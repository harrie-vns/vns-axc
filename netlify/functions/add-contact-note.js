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

// ---------- signature utils ----------
function hmacBase64(secret, content) {
  return crypto.createHmac("sha1", secret).update(content).digest("base64");
}
// robust raw extractor for body.data (works regardless of whitespace/unicode)
function extractRawDataSubstring(bodyStr) {
  // find the first "data": occurrence at the top level
  const keyIdx = bodyStr.indexOf('"data"');
  if (keyIdx < 0) return null;
  // find the colon after "data"
  let i = keyIdx + 6; // after "data"
  while (i < bodyStr.length && /\s|:/.test(bodyStr[i]) === false) i++;
  while (i < bodyStr.length && /\s/.test(bodyStr[i])) i++;
  if (bodyStr[i] !== ":") return null;
  i++;
  while (i < bodyStr.length && /\s/.test(bodyStr[i])) i++;

  // now i points at the first char of the value (likely '{' or '[')
  const start = i;
  const first = bodyStr[start];
  if (first !== "{" && first !== "[") return null;

  // walk & match braces/brackets, respecting strings/escapes
  let depth = 0;
  let inStr = false;
  let strQuote = null;
  let esc = false;
  for (let j = start; j < bodyStr.length; j++) {
    const ch = bodyStr[j];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === strQuote) {
        inStr = false;
        strQuote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      strQuote = ch;
      continue;
    }

    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;

    if (depth === 0) {
      // include the closing brace/bracket
      return bodyStr.slice(start, j + 1);
    }
  }
  return null; // didn't find a closing
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

  // candidate 1: RAW "data" substring
  let c1 = null;
  const rawData = extractRawDataSubstring(bodyStr);
  if (rawData) c1 = hmacBase64(TD_WEBHOOK_SECRET, rawData);

  // candidate 2: JSON.stringify(data)
  let c2 = null;
  if (payload && payload.data) {
    try { c2 = hmacBase64(TD_WEBHOOK_SECRET, JSON.stringify(payload.data)); }
    catch { /* ignore */ }
  }

  // candidate 3: full raw body (paranoid fallback)
  const c3 = hmacBase64(TD_WEBHOOK_SECRET, bodyStr);

  const ok = [c1, c2, c3].some(sig => sig && sig === header);
  if (!ok) {
    log("signature mismatch", {
      hasC1: !!c1, hasC2: !!c2, triedC3: true,
      headerLen: header.length,
    });
  }
  return ok;
}

// ---------- general utils ----------
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

// ---------- aXcelerate ----------
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
  const lower = email.toLowerCase();

  // 1) direct endpoint
  let r = await axcFetch(`/api/contacts?emailAddress=${e}`);
  tried.push(r.url);
  if (r.ok) {
    const arr = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    const exact = arr.find(c => isExactEmail(c, lower));
    if (exact) return { contact: exact, tried };
  }

  // 2) search by emailAddress param
  r = await axcFetch(`/api/contacts/search?emailAddress=${e}&displayLength=50`);
  tried.push(r.url);
  if (r.ok && Array.isArray(r.body)) {
    const exact = r.body.find(c => isExactEmail(c, lower));
    if (exact) return { contact: exact, tried };
    if (r.body.length === 1) return { contact: r.body[0], tried };
  }

  // 3) broad search
  r = await axcFetch(`/api/contacts/search?search=${e}&displayLength=50`);
  tried.push(r.url);
  if (r.ok && Array.isArray(r.body)) {
    const exact = r.body.find(c => isExactEmail(c, lower));
    if (exact) return { contact: exact, tried };
  }

  return { contact: null, tried };
}
async function addContactNote(contactID, note) {
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

    // Verify signature (robust)
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
    const customerEmail = pickCustomerEmail(data);
    if (!customerEmail) {
      log("no customer email in payload", {
        hasContactInfo: !!data?.contactInfo, hasContact: !!data?.contact,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no customer email" }) };
    }

    // Build note from the last outbound email
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
    ].filter(Boolean).join("\n").slice(0, 60000);

    // Find aXcelerate contact & add note
    const { contact, tried } = await findContactByEmail(customerEmail);
    if (!contact?.CONTACTID) {
      log("no aXcelerate match", { customerEmail, tried });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "contact not found", tried }) };
    }

    const put = await addContactNote(contact.CONTACTID, note);
    if (!put.ok) {
      log("note PUT failed", { status: put.status, url: put.url, body: put.body });
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
