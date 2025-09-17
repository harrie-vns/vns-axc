// netlify/functions/add-contact-note.js
const crypto = require("crypto");

const REQ_TIMEOUT_MS = 10000;

function hmacOk(secret, raw, sigHeader) {
  if (!secret) return true;                 // don't block if you forgot to set it
  if (!sigHeader || !raw) return false;

  // Compute both encodings; TD sometimes sends sha1=<hex> or base64 variants
  const hmac = crypto.createHmac("sha1", secret).update(raw, "utf8");
  const hex = hmac.digest("hex");
  const base64 = crypto.createHmac("sha1", secret).update(raw, "utf8").digest("base64");
  const candidates = [hex, `sha1=${hex}`, base64, `sha1=${base64}`];

  // Try constant-time equality when lengths match; otherwise fall back to substring match
  for (const cand of candidates) {
    try {
      if (cand.length === sigHeader.length &&
          crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(sigHeader))) {
        return true;
      }
    } catch { /* length mismatch, ignore */ }
  }
  // Fallback: accept if the header contains the computed token
  return candidates.some(c => sigHeader.includes(c));
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  let json;
  try { json = JSON.parse(raw || "{}"); } catch { json = {}; }
  return { raw, json };
}

// ------- ThriveDesk helpers -------
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
    Array.isArray(msg.to) && msg.to.length ? (msg.to[0].email || msg.to[0].address) : null,
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
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AXC ${res.status} on ${path} :: ${t.slice(0,300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function findContactByEmail(email) {
  const q = encodeURIComponent(email);
  const data = await axcFetch(`/api/contacts/search?emailAddress=${q}&displayLength=100`);
  const arr = Array.isArray(data) ? data : [];
  const exact = arr.find(c =>
    (c.EMAILADDRESS && c.EMAILADDRESS.toLowerCase() === email.toLowerCase()) ||
    (c.CUSTOMFIELD_PERSONALEMAIL && c.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === email.toLowerCase())
  );
  return exact || arr[0] || null;
}

async function addNote(contactID, note) {
  const body = new URLSearchParams({
    contactID: String(contactID),
    contactNote: note,              // leave noteTypeID out (defaults to System Note)
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
  const secret = process.env.TD_WEBHOOK_SECRET || "";
  const sig = event.headers["x-td-signature"] || event.headers["X-TD-Signature"];
  if (!hmacOk(secret, raw, sig)) {
    console.info("[add-contact-note] signature mismatch or missing");
    return { statusCode: 401, body: JSON.stringify({ error: "Bad signature" }) };
  }

  const email = extractEmail(json);
  if (!email) {
    console.info("[add-contact-note] no customer email in payload", {
      keys: Object.keys(json || {}),
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
  console.info("[add-contact-note] success", { contactID: contact.CONTACTID, email });

  return { statusCode: 200, body: JSON.stringify({ ok: true, contactID: contact.CONTACTID }) };
};
