// netlify/functions/add-contact-note.js
const crypto = require("crypto");

const AXC_BASE_URL = (process.env.AXC_BASE_URL || "").replace(/\/+$/, "");
const AXC_API_TOKEN = process.env.AXC_API_TOKEN;
const AXC_WS_TOKEN = process.env.AXC_WS_TOKEN;
const TD_WEBHOOK_SECRET =
  process.env.TD_WEBHOOK_SECRET || process.env.THRIVEDESK_SECRET || "";
const ALLOW_UNVERIFIED =
  String(process.env.ALLOW_UNVERIFIED_WEBHOOKS || "").toLowerCase() === "true";

const log = (...a) => console.log("[add-contact-note]", ...a);

/* ----------------- signature utils (unchanged) ----------------- */
function hmacBase64(secret, content) {
  return crypto.createHmac("sha1", secret).update(content).digest("base64");
}
function extractRawDataSubstring(bodyStr) {
  const keyIdx = bodyStr.indexOf('"data"');
  if (keyIdx < 0) return null;
  let i = keyIdx + 6;
  while (i < bodyStr.length && /\s|:/.test(bodyStr[i]) === false) i++;
  while (i < bodyStr.length && /\s/.test(bodyStr[i])) i++;
  if (bodyStr[i] !== ":") return null;
  i++;
  while (i < bodyStr.length && /\s/.test(bodyStr[i])) i++;
  const start = i;
  const first = bodyStr[start];
  if (first !== "{" && first !== "[") return null;

  let depth = 0, inStr = false, strQuote = null, esc = false;
  for (let j = start; j < bodyStr.length; j++) {
    const ch = bodyStr[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === strQuote) { inStr = false; strQuote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strQuote = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth === 0) return bodyStr.slice(start, j + 1);
  }
  return null;
}
function verifyTdSignature(event) {
  if (!TD_WEBHOOK_SECRET) return true;
  if (ALLOW_UNVERIFIED) return true;

  const headerRaw =
    event.headers["x-td-signature"] || event.headers["X-TD-Signature"] || "";
  const header = headerRaw.replace(/^sha1=/i, "").trim();
  if (!header) return false;

  const bodyStr = event.body || "";
  let payload;
  try { payload = JSON.parse(bodyStr); } catch { payload = null; }

  let c1 = null;
  const rawData = extractRawDataSubstring(bodyStr);
  if (rawData) c1 = hmacBase64(TD_WEBHOOK_SECRET, rawData);

  let c2 = null;
  if (payload && payload.data) {
    try { c2 = hmacBase64(TD_WEBHOOK_SECRET, JSON.stringify(payload.data)); } catch {}
  }

  const c3 = hmacBase64(TD_WEBHOOK_SECRET, bodyStr);
  const ok = [c1, c2, c3].some(sig => sig && sig === header);
  if (!ok) log("signature mismatch or missing");
  return ok;
}

/* ----------------- general utils ----------------- */
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

/* ----------------- aXcelerate helpers ----------------- */
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
function toLower(s) { return (s || "").toString().trim().toLowerCase(); }
function isExactEmail(rec, targetLower) {
  return (
    (rec.EMAILADDRESS && rec.EMAILADDRESS.toLowerCase() === targetLower) ||
    (rec.EMAILADDRESSALTERNATIVE && rec.EMAILADDRESSALTERNATIVE.toLowerCase() === targetLower) ||
    (rec.CUSTOMFIELD_PERSONALEMAIL && rec.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === targetLower)
  );
}
async function findContactByEmail(email) {
  const tried = [];
  const e = encodeURIComponent(email);
  const lower = toLower(email);

  let r = await axcFetch(`/api/contacts?emailAddress=${e}`);
  tried.push(r.url);
  if (r.ok) {
    const arr = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    const exact = arr.find(c => isExactEmail(c, lower));
    if (exact) return { contact: exact, tried };
  }

  async function pagedExact(base) {
    let offset = 0;
    while (offset <= 900) {
      const url = `${base}${base.includes("?") ? "&" : "?"}displayLength=100&offset=${offset}`;
      const res = await axcFetch(url);
      tried.push(res.url);
      if (!res.ok || !Array.isArray(res.body) || res.body.length === 0) break;
      const exact = res.body.find(c => isExactEmail(c, lower));
      if (exact) return exact;
      if (res.body.length < 100) break;
      offset += 100;
    }
    return null;
  }

  let exact = await pagedExact(`/api/contacts/search?emailAddress=${e}`);
  if (exact) return { contact: exact, tried };

  exact = await pagedExact(`/api/contacts/search?q=${e}`);
  if (exact) return { contact: exact, tried };

  exact = await pagedExact(`/api/contacts/search?search=${e}`);
  if (exact) return { contact: exact, tried };

  const fallbacks = [
    `/api/contacts/search?emailAddress=${e}&displayLength=1`,
    `/api/contacts/search?q=${e}&displayLength=1`,
    `/api/contacts/search?search=${e}&displayLength=1`,
  ];
  for (const url of fallbacks) {
    const res = await axcFetch(url);
    tried.push(res.url);
    if (res.ok && Array.isArray(res.body) && res.body.length === 1) {
      return { contact: res.body[0], tried };
    }
  }

  return { contact: null, tried };
}
async function addContactNote(contactID, note) {
  const form = new URLSearchParams();
  form.set("contactID", String(contactID));
  form.set("contactNote", note);
  return axcFetch(`/api/contact/note/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

/* ----------------- handler ----------------- */
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

    // Verify signature
    if (!verifyTdSignature(event)) {
      log("signature mismatch or missing");
      if (!ALLOW_UNVERIFIED) {
        return { statusCode: 401, body: JSON.stringify({ error: "Signature check failed" }) };
      }
    }

    // Parse payload AFTER signature check
    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: "Body must be JSON" }) }; }

    const data = payload?.data || payload;

    // Email we’re sending TO (the student/customer)
    const customerEmail = pickCustomerEmail(data);
    if (!customerEmail) {
      log("no customer email in payload", {
        hasContactInfo: !!data?.contactInfo, hasContact: !!data?.contact,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no customer email" }) };
    }

    // What we sent (subject/body) comes from the last outbound email thread
    const outbound = lastOutboundEmailThread(data);

    const subject =
      outbound?.subject ||
      data?.subject ||
      data?.conversation?.subject ||
      "(no subject)";

    const plain =
      outbound?.textBody ||
      htmlToText(
        outbound?.htmlBody ||
        data?.message?.htmlBody ||
        data?.message?.body ||
        ""
      );

// Agent (assignee of the conversation)
const assignee =
  data?.assignedTo ||                  // top-level
  data?.conversation?.assignedTo ||    // sometimes nested
  null;

const agentName = assignee
  ? [assignee.firstName, assignee.lastName].filter(Boolean).join(" ").trim()
  : "";

// Inbox (name first, then fall back to connected address, else "Support")
const inbox = data?.inbox || data?.conversation?.inbox || {};
const inboxName = inbox.name || inbox.connectedEmailAddress || "Support";

    // CC / BCC (prefer what’s on the outbound email thread)
    const ccList = Array.isArray(outbound?.cc) ? outbound.cc
                  : Array.isArray(data?.cc) ? data.cc
                  : Array.isArray(data?.message?.cc) ? data.message.cc
                  : [];
    const bccList = Array.isArray(outbound?.bcc) ? outbound.bcc
                   : Array.isArray(data?.bcc) ? data.bcc
                   : Array.isArray(data?.message?.bcc) ? data.message.bcc
                   : [];

    // Conversation ID for traceability
    const convId = data?.conversation?.id || data?.ticketId || data?.id;

    // Compose the note exactly as requested
    const lines = [
      `Email sent via ThriveDesk - Conversation ID: ${convId ?? "(unknown)"}`,
      `To: ${customerEmail}`,
    ];
    if (ccList.length) lines.push(`CC: ${ccList.join(", ")}`);
    if (bccList.length) lines.push(`BCC: ${bccList.join(", ")}`);
    lines.push(`Subject: ${subject}`);

    const fromBits = [];
    if (connectedAddr) fromBits.push(connectedAddr);
    if (agentName) fromBits.push(agentName);
    lines.push(`From: ${inboxName}${agentName ? ` - ${agentName}` : ""}`);

    lines.push("", plain || "(no body)");

    const note = lines.join("\n").slice(0, 60000);

    // Find aXcelerate contact & add note
    const { contact, tried } = await findContactByEmail(customerEmail);
    if (!contact?.CONTACTID) {
      log("no aXcelerate match", { customerEmail, tried });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "contact not found", tried }) };
    }

    const put = await addContactNote(contact.CONTACTID, note);
    if (!put.ok) {
      log("note POST failed", { status: put.status, url: put.url, body: put.body });
      return { statusCode: 502, body: JSON.stringify({ error: "aXcelerate note create failed", status: put.status }) };
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
