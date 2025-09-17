// netlify/functions/add-contact-note.js
const crypto = require("crypto");

const REQ_TIMEOUT_MS = 10000;

function hmacOk(secret, raw, sigHeader) {
  if (!secret) return true; // don't block if you forgot to set it
  if (!sigHeader) return false;
  const computed = crypto
    .createHmac("sha1", secret)
    .update(raw, "utf8")
    .digest("hex");
  // ThriveDesk typically sends "sha1=<hex>"
  const expected = `sha1=${computed}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  let json;
  try { json = JSON.parse(raw || "{}"); } catch { json = {}; }
  return { raw, json };
}

// Try many possible locations for the customer email
function extractEmail(payload) {
  const p = payload || {};
  const d = p.data || p;
  const conv = d.conversation || p.conversation || {};
  const msg  = d.message || p.message || {};
  const cust = d.customer || p.customer || conv.customer || {};

  // Prefer explicit customer email
  const candidates = [
    cust.email,
    cust.emailAddress,
    conv?.customer?.email,
    conv?.customer?.emailAddress,
    // If this was an AGENT reply, TD often has message.to[]
    Array.isArray(msg.to) && msg.to.length ? msg.to[0].email || msg.to[0].address : null,
    // If this was a CUSTOMER reply, TD may have from
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
  // Try plaintext first, then html, then subject + snippet fallback
  return (
    msg.plaintext ||
    msg.text ||
    msg.body ||
    msg.html ||
    [msg.subject, msg.snippet].filter(Boolean).join(" — ") ||
    "(no message body provided)"
  );
}

async function axcFetch(path, opts = {}) {
  const base = process.env.AXC_BASE_URL;
  const apitoken = process.env.AXC_API_TOKEN;
  const wstoken = process.env.AXC_WS_TOKEN;
  if (!base || !apitoken || !wstoken) {
    throw new Error("Missing AXC_* env vars");
  }
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": opts.contentType || "application/json",
      apitoken,
      wstoken,
      ...(opts.headers || {})
    },
    body: opts.body || undefined,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AXC ${res.status} on ${path} :: ${t.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function findContactByEmail(email) {
  // exact email match if possible
  const q = encodeURIComponent(email);
  const data = await axcFetch(`/api/contacts/search?emailAddress=${q}&displayLength=100`);
  const arr = Array.isArray(data) ? data : [];
  // Prefer exact match on EMAILADDRESS or CUSTOMFIELD_PERSONALEMAIL
  const exact = arr.find(c =>
    (c.EMAILADDRESS && c.EMAILADDRESS.toLowerCase() === email.toLowerCase()) ||
    (c.CUSTOMFIELD_PERSONALEMAIL && c.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === email.toLowerCase())
  );
  return exact || arr[0] || null;
}

async function addNote(contactID, note) {
  const body = new URLSearchParams({
    contactID: String(contactID),
    contactNote: note,
    // noteTypeID omitted on purpose (defaults to System Note)
  });
  // aXcelerate contact note creation uses PUT
  return axcFetch(`/api/contact/note`, {
    method: "PUT",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
  });
}

exports.handler = async (event) => {
  const secret = process.env.TD_WEBHOOK_SECRET || "";
  const sig = event.headers["x-td-signature"] || event.headers["X-TD-Signature"] || event.headers["x-td-signature"];
  const { raw, json } = parseBody(event);

  // Only accept POSTs with a valid signature (if secret provided)
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Use POST with JSON" }) };
  }
  const ok = hmacOk(secret, raw, sig);
  if (!ok) {
    console.info("[add-contact-note] signature mismatch");
    return { statusCode: 401, body: JSON.stringify({ error: "Bad signature" }) };
  }

  // Pull core fields from TD payload
  const email = extractEmail(json);
  if (!email) {
    console.info("[add-contact-note] no customer email in payload", {
      haveKeys: Object.keys(json || {}),
      sample: {
        conversationHasCustomer: !!json?.conversation?.customer,
        dataConversationHasCustomer: !!json?.data?.conversation?.customer,
        messageHasTo: !!json?.data?.message?.to,
        messageHasFrom: !!json?.data?.message?.from,
      }
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no email" }) };
  }

  const agent = extractAgentName(json);
  const text = extractMessageText(json);
  const convId =
    json?.data?.conversation?.id ||
    json?.conversation?.id ||
    json?.data?.conversation_id ||
    json?.conversation_id ||
    "";
  const tdLink = convId
    ? `https://app.thrivedesk.com/inboxes/conversations/${convId}`
    : "";

  // Find contact in aXcelerate
  const contact = await findContactByEmail(email);
  if (!contact || !contact.CONTACTID) {
    console.info("[add-contact-note] no aXc contact match", { email });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no-contact" }) };
  }

  // Compose note
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
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, contactID: contact.CONTACTID })
  };
};
