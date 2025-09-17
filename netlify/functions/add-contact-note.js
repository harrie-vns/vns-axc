// netlify/functions/add-contact-note.js
const crypto = require("crypto");

// ---- helpers ---------------------------------------------------------------
const json = (status, obj) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function verifyThriveDeskSignature(event, secret) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sent = headers["x-td-signature"] || "";
  if (!secret || !sent) return { ok: false, reason: "missing secret or signature" };

  const raw = event.body || "";
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}

  // 1) TD on your account signs the RAW substring of the `data` object
  const m = raw.match(/"data"\s*:\s*(\{[\s\S]*\})\s*}$/);
  if (m) {
    const rawData = m[1];
    const calc = crypto.createHmac("sha1", secret).update(rawData).digest("base64");
    if (calc === sent) return { ok: true, mode: "raw-substring" };
  }

  // 2) Fallback: JSON.stringify(data) (TD docs default)
  const dataObj = parsed?.data;
  if (dataObj) {
    const calc = crypto.createHmac("sha1", secret).update(JSON.stringify(dataObj)).digest("base64");
    if (calc === sent) return { ok: true, mode: "json-stringify" };
  }

  return { ok: false, reason: "signature mismatch" };
}

function pickEmail(data) {
  // Try the most reliable shapes first
  return (
    data?.conversation?.customer?.email ||
    data?.customer?.email ||
    data?.message?.to?.[0]?.email ||
    data?.message?.customer?.email ||
    data?.recipient?.email ||
    data?.ticket?.customer?.email ||
    null
  );
}

function buildNoteText(data) {
  const agent = data?.user?.name || data?.agent?.name || "Agent";
  const subject =
    data?.message?.subject ||
    data?.conversation?.subject ||
    "ThriveDesk message";
  const bodyHtml =
    data?.message?.body_html || data?.message?.html || data?.message?.content;
  const bodyText =
    data?.message?.body_text ||
    data?.message?.text ||
    data?.message?.body ||
    "";

  // keep it simple & compact; AXC notes are plain text
  const text = [
    `From: ${agent}`,
    `Subject: ${subject}`,
    "",
    bodyText || (bodyHtml ? bodyHtml.replace(/<[^>]+>/g, "") : "")
  ].join("\n");

  // AXC copes fine with long notes, but cap at ~20k just in case
  return text.slice(0, 20000);
}

async function axcFetch(path, { method = "GET", params, headers = {}, body } = {}) {
  const base = process.env.AXC_BASE_URL;
  if (!base) throw new Error("Missing AXC_BASE_URL");

  const url = new URL(path, base);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method,
    headers: {
      apitoken: process.env.AXC_API_TOKEN || "",
      wstoken: process.env.AXC_WS_TOKEN || "",
      ...headers
    },
    body
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, body: json };
}

function matchContactByEmail(list, email) {
  if (!Array.isArray(list)) return null;
  const norm = (s) => String(s || "").trim().toLowerCase();

  const target = norm(email);
  // Exact matches on official email first
  let hit = list.find(c => norm(c.EMAILADDRESS) === target);
  if (hit) return hit;

  // Then custom personal email field
  hit = list.find(c => norm(c.CUSTOMFIELD_PERSONALEMAIL) === target);
  if (hit) return hit;

  // Nothing exact
  return null;
}

// ---- handler ---------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Use POST with JSON" });
  }

  // Verify TD signature
  const sig = verifyThriveDeskSignature(event, process.env.TD_WEBHOOK_SECRET || "");
  if (!sig.ok) {
    console.log("[add-contact-note] verify failed:", sig.reason);
    return json(401, { error: "Invalid signature" });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON" }); }

  const data = body.data || {};
  const email = pickEmail(data);
  if (!email) {
    console.log("[add-contact-note] no customer email in payload");
    return json(200, { ok: true, skipped: "no email in payload" });
  }

  // Find contact by email
  const search = await axcFetch("/api/contacts/search", {
    params: { search: email, displayLength: "100" }
  });

  if (!search.ok) {
    console.log("[add-contact-note] search failed", search.status);
    return json(502, { error: "aXcelerate search failed", status: search.status });
  }

  const contact = matchContactByEmail(search.body, email);
  if (!contact) {
    console.log("[add-contact-note] no exact match for", email);
    return json(200, { ok: true, skipped: "no matching contact", email });
  }

  // Build note
  const note = buildNoteText(data);

  // Create note (PUT, form-encoded)
  const form = new URLSearchParams({ contactID: String(contact.CONTACTID), contactNote: note });
  const created = await axcFetch("/api/contact/note/", {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });

  if (!created.ok) {
    console.log("[add-contact-note] create note failed", created.status, created.body);
    return json(502, { error: "aXcelerate note create failed", status: created.status, body: created.body });
  }

  // Done
  return json(200, {
    ok: true,
    contactID: contact.CONTACTID,
    emailMatched: email,
    noteChars: note.length,
    sigMode: sig.mode
  });
};
