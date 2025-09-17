// netlify/functions/add-contact-note.js
const crypto = require("crypto");

// ---------- config helpers ----------
const AXC_BASE_URL = (process.env.AXC_BASE_URL || "").replace(/\/+$/, "");
const AXC_API_TOKEN = process.env.AXC_API_TOKEN;
const AXC_WS_TOKEN = process.env.AXC_WS_TOKEN;
const TD_WEBHOOK_SECRET =
  process.env.TD_WEBHOOK_SECRET || process.env.THRIVEDESK_SECRET || ""; // support either name
const ALLOW_UNVERIFIED = String(process.env.ALLOW_UNVERIFIED_WEBHOOKS || "").toLowerCase() === "true";

const log = (...a) => console.log("[add-contact-note]", ...a);

// ---------- ThriveDesk signature ----------
function computeTdSig(secret, dataObj) {
  // Docs-proven: base64(HMAC-SHA1(JSON.stringify(body.data)))
  return crypto.createHmac("sha1", secret).update(JSON.stringify(dataObj)).digest("base64");
}

function verifyTdSig(event, payload) {
  if (!TD_WEBHOOK_SECRET) return true; // no secret set = skip
  if (ALLOW_UNVERIFIED) return true;   // debug bypass
  const header = event.headers["x-td-signature"] || event.headers["X-TD-Signature"];
  if (!header || !payload?.data) return false;
  const computed = computeTdSig(TD_WEBHOOK_SECRET, payload.data);
  return header === computed;
}

// ---------- small utils ----------
function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function pickCustomerEmail(data) {
  return (
    data?.contactInfo?.email ||
    data?.contact?.email ||
    data?.customer?.email ||
    data?.conversation?.contact?.email ||
    null
  );
}

function lastOutboundEmailThread(data) {
  const threads = Array.isArray(data?.threads)
    ? data.threads
    : Array.isArray(data?.conversation?.threads)
    ? data.conversation.threads
    : [];
  for (let i = threads.length - 1; i >= 0; i--) {
    const t = threads[i];
    if (String(t?.type).toLowerCase() === "email" &&
        String(t?.direction).toLowerCase() === "outbound") {
      return t;
    }
  }
  return null;
}

// ---------- aXcelerate fetch ----------
async function axcFetch(path, init = {}) {
  const url = `${AXC_BASE_URL}${path}`;
  const headers = {
    apitoken: AXC_API_TOKEN,
    wstoken: AXC_WS_TOKEN,
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, url, body };
}

function isExactEmailMatch(rec, emailLower) {
  return (
    (rec.EMAILADDRESS && rec.EMAILADDRESS.toLowerCase() === emailLower) ||
    (rec.EMAILADDRESSALTERNATIVE && rec.EMAILADDRESSALTERNATIVE.toLowerCase() === emailLower) ||
    (rec.CUSTOMFIELD_PERSONALEMAIL && rec.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === emailLower)
  );
}

async function findContactByEmail(email) {
  const tried = [];
  const e = encodeURIComponent(email);
  const lower = email.toLowerCase();

  // 1) Exact endpoint (often returns a single or small array)
  let r = await axcFetch(`/api/contacts?emailAddress=${e}`, { method: "GET" });
  tried.push(r.url);
  if (r.ok) {
    let arr = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    let exact = arr.find(c => isExactEmailMatch(c, lower));
    if (exact) return { contact: exact, tried };
  }

  // 2) Search by dedicated emailAddress param (right-wildcard behavior server-side)
  r = await axcFetch(`/api/contacts/search?emailAddress=${e}&displayLength=50`, { method: "GET" });
  tried.push(r.url);
  if (r.ok && Array.isArray(r.body)) {
    let exact = r.body.find(c => isExactEmailMatch(c, lower));
    if (exact) return { contact: exact, tried };
    if (r.body.length === 1) return { contact: r.body[0], tried };
  }

  // 3) Broad search (q/search)
  r = await axcFetch(`/api/contacts/search?search=${e}&displayLength=50`, { method: "GET" });
  tried.push(r.url);
  if (r.ok && Array.isArray(r.body)) {
    let exact = r.body.find(c => isExactEmailMatch(c, lower));
    if (exact) return { contact: exact, tried };
  }

  return { contact: null, tried };
}

async function addContactNote(contactID, note) {
  // Must be form-encoded for this endpoint
  const form = new URLSearchParams();
  form.set("contactID", String(contactID));
  form.set("contactNote", note);

  return axcFetch(`/api/contact/note/`, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Use POST with JSON" }) };
    }

    if (!AXC_BASE_URL || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing aXcelerate env vars" }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing body" }) };
    }

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: "Body must be JSON" }) }; }

    // Signature check (based on everything we confirmed)
    if (!verifyTdSig(event, payload)) {
      log("signature mismatch or missing");
      return { statusCode: 401, body: JSON.stringify({ error: "Signature check failed" }) };
    }

    const data = payload.data || payload;
    const customerEmail = pickCustomerEmail(data);
    if (!customerEmail) {
      log("no customer email in payload", {
        hasContactInfo: !!data?.contactInfo, hasContact: !!data?.contact,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no customer email" }) };
    }

    // Build the note content
    const outbound = lastOutboundEmailThread(data);
    const subject =
      outbound?.subject ||
      data?.subject ||
      data?.conversation?.subject ||
      "(no subject)";

    const plain =
      outbound?.textBody ||
      htmlToText(outbound?.htmlBody || data?.message?.htmlBody || data?.message?.body || "");

    const inboxName = data?.inbox?.name || "";
    const inboxAddr = data?.inbox?.connectedEmailAddress || "";
    const convId = data?.conversation?.id || data?.ticketId || data?.id;

    const note = [
      "Email sent via ThriveDesk",
      `To: ${customerEmail}`,
      `Subject: ${subject}`,
      (inboxName || inboxAddr) ? `From: ${inboxName}${inboxAddr ? ` <${inboxAddr}>` : ""}` : null,
      convId ? `Conversation ID: ${convId}` : null,
      "",
      plain || "(no body)"
    ].filter(Boolean).join("\n").slice(0, 60000); // keep it sane

    // Locate the aXcelerate contact
    const { contact, tried } = await findContactByEmail(customerEmail);
    if (!contact?.CONTACTID) {
      log("no aXcelerate match", { customerEmail, tried });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "contact not found", tried }) };
    }

    // Create the note
    const put = await addContactNote(contact.CONTACTID, note);
    if (!put.ok) {
      log("note PUT failed", { status: put.status, url: put.url, body: put.body });
      return { statusCode: 502, body: JSON.stringify({ error: "aXcelerate note create failed", status: put.status, tried }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        contactID: contact.CONTACTID,
        email: customerEmail,
        noteLength: note.length,
      }),
    };
  } catch (err) {
    log("error", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
};
