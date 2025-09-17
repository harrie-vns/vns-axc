// netlify/functions/add-contact-note.js
// ThriveDesk ➜ aXcelerate Contact Note webhook
//
// What it does
// - Verifies ThriveDesk webhook (RELAXED signature check that worked for you)
// - Pulls the recipient email from data.contactInfo.email
// - Finds the matching aX contact (same lookup logic as your working function)
// - Posts a note to /api/contact/note/ (POST, x-www-form-urlencoded)
//
// Required env vars (Netlify > Site settings > Environment variables):
//   AXC_BASE_URL      e.g. https://vetnurse.app.axcelerate.com
//   AXC_API_TOKEN
//   AXC_WS_TOKEN
//   TD_WEBHOOK_SECRET (your ThriveDesk webhook secret)

const crypto = require("crypto");

// ====== ENV ======
const AXC_BASE_URL     = (process.env.AXC_BASE_URL     || "").trim();
const AXC_API_TOKEN    = (process.env.AXC_API_TOKEN    || "").trim();
const AXC_WS_TOKEN     = (process.env.AXC_WS_TOKEN     || "").trim();
const TD_WEBHOOK_SECRET= (process.env.TD_WEBHOOK_SECRET|| "").trim();

// ====== Small HTTP helpers ======
function withCors(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-TD-Signature",
    "Cache-Control": "no-store",
  };
}
const ok  = (obj) => ({ statusCode: 200, headers: withCors({"Content-Type":"application/json"}), body: JSON.stringify(obj ?? {ok:true}) });
const bad = (code, msg, extra={}) => ({ statusCode: code, headers: withCors({"Content-Type":"application/json"}), body: JSON.stringify({ error: msg, ...extra }) });

function assertEnv() {
  const missing = [];
  if (!AXC_BASE_URL) missing.push("AXC_BASE_URL");
  if (!AXC_API_TOKEN) missing.push("AXC_API_TOKEN");
  if (!AXC_WS_TOKEN)  missing.push("AXC_WS_TOKEN");
  if (!TD_WEBHOOK_SECRET) missing.push("TD_WEBHOOK_SECRET");
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

function getHeader(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

// ====== Signature helpers (RELAXED — back to what worked) ======
function computeTdSignatureBase64FromDataField(rawBodyStr, secret) {
  let payloadData;
  try {
    const parsed = JSON.parse(rawBodyStr || "{}");
    payloadData = (parsed && typeof parsed === "object" && parsed.data !== undefined)
      ? parsed.data
      : parsed;
  } catch {
    payloadData = {};
  }
  const json = JSON.stringify(payloadData);
  return crypto.createHmac("sha1", secret).update(json).digest("base64");
}

function sigLooksValid(headerValue, computed) {
  if (!headerValue) return false;
  const h = String(headerValue).trim();
  // Accept common variants & substring (the relaxed approach you used successfully)
  if (h === computed) return true;
  if (h === `sha1=${computed}`) return true;
  if (h === `sha1 ${computed}`) return true;
  if (h.includes(computed)) return true;
  return false;
}

function verifyTdSignatureLoose(event) {
  const sigHeader = getHeader(event, "x-td-signature");
  const rawBodyStr = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  const computed = computeTdSignatureBase64FromDataField(rawBodyStr, TD_WEBHOOK_SECRET);
  const ok = sigLooksValid(sigHeader, computed);
  return { ok, provided: sigHeader || null, computed };
}

// ====== aXcelerate HTTP ======
async function axcFetch(pathOrUrl, init = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${AXC_BASE_URL.replace(/\/+$/,"")}${pathOrUrl}`;
  const headers = {
    apitoken: AXC_API_TOKEN,
    wstoken:  AXC_WS_TOKEN,
    Accept:   "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, url, body };
}

function normEmail(v) {
  return (v ?? "").toString().trim().toLowerCase();
}
function recordEmails(rec = {}) {
  return [
    rec.EMAILADDRESS,
    rec.EMAILADDRESSALTERNATIVE,
    rec.CUSTOMFIELD_PERSONALEMAIL,
    rec.CUSTOMFIELD_THIRDPARTYACCESS_EMAIL,
    rec.CUSTOMFIELD_THIRDPARTYACCESS_EMAILADDRESS,
  ].map(normEmail).filter(Boolean);
}
function isEmailMatch(rec, target) {
  const t = normEmail(target);
  return recordEmails(rec).includes(t);
}

// ====== Robust contact lookup (same approach as your working function) ======
async function findContactByEmail(email) {
  const tried = [];
  const e = encodeURIComponent(email);
  const target = normEmail(email);

  // 0) exact endpoint (some tenants support this)
  let r = await axcFetch(`/api/contacts?emailAddress=${e}`);
  tried.push(r.url);
  if (r.ok) {
    const arr = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
    const exact0 = arr.find(c => isEmailMatch(c, target));
    if (exact0) return { contact: exact0, tried };
  }

  // helper: paged search up to 1000 in case of wildcard-y results
  async function pagedSearch(baseUrl) {
    let offset = 0;
    while (offset <= 900) {
      const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}displayLength=100&offset=${offset}`;
      const res = await axcFetch(url);
      tried.push(res.url);
      if (!res.ok || !Array.isArray(res.body) || res.body.length === 0) break;
      const exact = res.body.find(c => isEmailMatch(c, target));
      if (exact) return exact;
      if (res.body.length < 100) break;
      offset += 100;
    }
    return null;
  }

  // 1) /contacts/search?emailAddress=
  let exact = await pagedSearch(`/api/contacts/search?emailAddress=${e}`);
  if (exact) return { contact: exact, tried };

  // 2) /contacts/search?q=
  exact = await pagedSearch(`/api/contacts/search?q=${e}`);
  if (exact) return { contact: exact, tried };

  // 3) /contacts/search?search=
  exact = await pagedSearch(`/api/contacts/search?search=${e}`);
  if (exact) return { contact: exact, tried };

  return { contact: null, tried };
}

// ====== Note POST ======
async function addContactNote(contactID, note) {
  const form = new URLSearchParams();
  form.set("contactID", String(contactID));
  form.set("contactNote", note);
  // Do NOT set noteTypeID for now (not reliable in your manual tests)
  // form.set("noteTypeID", "6444");

  const res = await axcFetch(`/api/contact/note/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return res;
}

// ====== Extract email & compose note from ThriveDesk payload ======
function extractEmailFromTdData(data) {
  // Per ThriveDesk docs: contactInfo.email is the one we trust
  const direct = data?.contactInfo?.email;
  if (direct) return direct;

  // Fallbacks (best-effort only)
  const toList = data?.message?.to || data?.payload?.to || [];
  if (Array.isArray(toList) && toList.length) {
    const first = toList[0];
    return typeof first === "string" ? first : (first?.email || null);
  }
  return null;
}

function renderNoteFromTdData(data) {
  const subject = data?.message?.subject || data?.conversation?.subject || "(no subject)";
  const bodyHtml = data?.message?.html || data?.message?.body || data?.message?.text || "";
  const toStr = data?.contactInfo?.email ? `To: ${data.contactInfo.email}\n` : "";
  const agent  = data?.agent?.name || data?.user?.name || "";
  const header = `Email sent from ThriveDesk\n${toStr}${agent ? `Agent: ${agent}\n` : ""}Subject: ${subject}\n\n`;
  // Very light HTML → text
  const text = bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return (header + text).slice(0, 12000);
}

// ====== Handler ======
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: withCors(), body: "" };
  if (event.httpMethod !== "POST")  return bad(405, "Use POST with JSON");

  try {
    assertEnv();
  } catch (err) {
    return bad(500, err.message);
  }

  // Verify signature (RELAXED)
  const sig = verifyTdSignatureLoose(event);
  if (!sig.ok) {
    console.info("[add-contact-note] signature mismatch or missing (relaxed)", {
      provided: sig.provided ? String(sig.provided).slice(0, 32) : null,
      computed: sig.computed.slice(0, 32),
    });
    return bad(401, "signature verification failed");
  }

  // Parse body (& take just `data`)
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch { return bad(400, "invalid JSON"); }
  const data = (body && typeof body === "object" && body.data !== undefined) ? body.data : body;

  // Email to match in aX
  const customerEmail = extractEmailFromTdData(data);
  if (!customerEmail) {
    console.info("[add-contact-note] no customer email in payload", {
      hasContactInfo: !!data?.contactInfo, keys: Object.keys(data || {})
    });
    return ok({ skipped: true, reason: "no email" });
  }

  // Find contact in aXcelerate
  const { contact, tried } = await findContactByEmail(customerEmail);
  if (!contact) {
    console.info("[add-contact-note] no aXcelerate match", { customerEmail, tried });
    return ok({ skipped: true, reason: "no aX match", customerEmail });
  }

  // Build + POST note
  const note = renderNoteFromTdData(data);
  const put = await addContactNote(contact.CONTACTID, note);
  if (!put.ok) {
    console.info("[add-contact-note] note POST failed", { status: put.status, url: put.url, body: put.body });
    return bad(502, "aX note post failed", { status: put.status, axc: put.body });
  }

  return ok({
    ok: true,
    contactID: contact.CONTACTID,
    matchedEmailFields: recordEmails(contact),
  });
};
