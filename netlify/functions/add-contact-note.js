// netlify/functions/add-contact-note.js
const crypto = require("crypto");

const REQ_TIMEOUT_MS = 10000;

// --- Signature verification (handles TD raw `data` substring) ---
function getHeader(headers, name) {
  const map = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return map[name.toLowerCase()] || null;
}

function extractRawDataSubstring(rawBody) {
  // Capture the exact JSON substring for the `data` object at the end of the payload
  // (This matched in your td-echo: 'sha1 base64 raw data substring')
  const m = (rawBody || "").match(/"data"\s*:\s*(\{[\s\S]*\})\s*}$/);
  return m ? m[1] : null;
}

function safeEqual(a, b) {
  try {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function verifyTdSignature(rawBody, sigHeader, secret) {
  if (!secret) return { ok: true, mode: "no-secret" }; // don't block if unset
  if (!sigHeader || !rawBody) return { ok: false, reason: "missing header/body" };

  const dataRaw = extractRawDataSubstring(rawBody);

  const candidates = [];
  const pushHmacs = (msg, label) => {
    const h = crypto.createHmac("sha1", secret).update(msg);
    const base64 = h.digest("base64");
    const hex = crypto.createHmac("sha1", secret).update(msg).digest("hex");
    candidates.push({ val: base64, mode: `${label}-base64` });
    candidates.push({ val: `sha1=${base64}`, mode: `${label}-sha1=base64` });
    candidates.push({ val: hex, mode: `${label}-hex` });
    candidates.push({ val: `sha1=${hex}`, mode: `${label}-sha1=hex` });
  };

  if (dataRaw) pushHmacs(dataRaw, "raw-data");
  pushHmacs(rawBody, "raw-body"); // fallback
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.data) pushHmacs(JSON.stringify(parsed.data), "json-data");
  } catch { /* ignore */ }

  // Prefer constant-time exact matches
  for (const c of candidates) {
    if (safeEqual(c.val, sigHeader)) return { ok: true, mode: c.mode };
  }
  // Loose fallback (last resort)
  const loose = candidates.find(c => sigHeader.includes(c.val));
  if (loose) return { ok: true, mode: `${loose.mode}-loose` };

  return { ok: false, reason: "no-candidate-match" };
}

// --- Parsing helpers ---
function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  let json;
  try { json = JSON.parse(raw || "{}"); } catch { json = {}; }
  return { raw, json };
}

// ------- ThriveDesk extraction -------
function extractEmail(payload) {
  const p = payload || {};
  const d = p.data || p;
  const conv = d.conversation || p.conversation || {};
  const msg  = d.message || p.message || {};
  const cust = d.customer || p.customer || conv.customer || {};

  const candidates = [
    cust.email,
    cust.emailAddress,
    conv?.customer?.email,
    conv?.customer?.emailAddress,
    (Array.isArray(msg.to) && msg.to.length) ? (msg.to[0].email || msg.to[0].address) : null,
    msg.from?.email || msg.from?.address,
  ].filter(Boolean);

  return candidates[0] || null;
}

function extractAgentName(payload) {
  const d = payload?.data || payload || {};
  const user = d.user || d.agent || d.actor || {};
  return user.name || user.full_name || user.display_name || "ThriveDesk Agent";
}

function extractMessageText(payload) {
  const d = payload?.data || payload || {};
  const msg = d.message || payload?.message || {};
  return (
    msg.plaintext ||
    msg.text ||
    msg.body ||
    msg.html ||
    [msg.subject, msg.snippet].filter(Boolean).join(" — ") ||
    "(no message body provided)"
  );
}

// ------- aXcelerate helpers -------
async function axcFetch(path, opts = {}) {
  const base = process.env.AXC_BASE_URL;
  const apitoken = process.env.AXC_API_TOKEN;
  const wstoken = process.env.AXC_WS_TOKEN;
  if (!base || !apitoken || !wstoken) throw new Error("Missing AXC_* env vars");

  const url = `${base.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": opts.contentType || "application/json",
      apitoken, wstoken,
      ...(opts.headers || {})
    },
    body: opts.body,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AXC ${res.status} on ${path} :: ${text.slice(0,300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function findContactByEmail(email) {
  // Use emailAddress param for exact matching; still filter locally for safety
  const q = encodeURIComponent(email);
  const data = await axcFetch(`/api/contacts/search?emailAddress=${q}&displayLength=100`);
  const arr = Array.isArray(data) ? data : [];
  const target = String(email || "").toLowerCase().trim();
  const exact = arr.find(c =>
    (c.EMAILADDRESS && c.EMAILADDRESS.toLowerCase() === target) ||
    (c.CUSTOMFIELD_PERSONALEMAIL && c.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === target)
  );
  return exact || arr[0] || null;
}

async function addNote(contactID, note) {
  const body = new URLSearchParams({
    contactID: String(contactID),
    contactNote: note, // leave noteTypeID out (defaults to System Note)
  });
  return axcFetch(`/api/contact/note`, {
    method: "PUT",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
  });
}

// ------- handler -------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Use POST with JSON" }) };
  }

  const { raw, json } = parseBody(event);
  const sigHeader = getHeader(event.headers, "x-td-signature");
  const secret = process.env.TD_WEBHOOK_SECRET || "";

  const sig = verifyTdSignature(raw, sigHeader, secret);
  if (!sig.ok) {
    console.info("[add-contact-note] signature mismatch", { reason: sig.reason });
    return { statusCode: 401, body: JSON.stringify({ error: "Bad signature" }) };
  }

  const email = extractEmail(json);
  if (!email) {
    console.info("[add-contact-note] no customer email in payload", {
      hasMsgTo: !!json?.data?.message?.to,
      hasMsgFrom: !!json?.data?.message?.from,
      hasCust: !!json?.data?.customer || !!json?.customer,
      hasConvCust: !!json?.data?.conversation?.customer || !!json?.conversation?.customer,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no email" }) };
  }

  const agent = extractAgentName(json);
  const text  = extractMessageText(json);
  const convId =
    json?.data?.conversation?.id ||
    json?.conversation?.id ||
    json?.data?.conversation_id ||
    json?.conversation_id || "";
  const tdLink = convId ? `https://app.thrivedesk.com/inboxes/conversations/${convId}` : "";

  // Find contact & create note
  const contact = await findContactByEmail(email);
  if (!contact?.CONTACTID) {
    console.info("[add-contact-note] no aXc contact match", { email });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no-contact" }) };
  }

  const stamped = new Date().toISOString().replace("T", " ").slice(0, 19);
  const note = [
    `ThriveDesk email sent by: ${agent}`,
    `To: ${email}`,
    tdLink ? `Conversation: ${tdLink}` : null,
    `Date: ${stamped}`,
    "",
    text,
  ].filter(Boolean).join("\n");

  await addNote(contact.CONTACTID, note);
  console.info("[add-contact-note] success", { contactID: contact.CONTACTID, email, sigMode: sig.mode });

  return { statusCode: 200, body: JSON.stringify({ ok: true, contactID: contact.CONTACTID, sigMode: sig.mode }) };
};
