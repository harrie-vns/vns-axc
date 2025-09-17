// netlify/functions/add-contact-note.js
// ThriveDesk ➜ aXcelerate Contact Note webhook
// - Verifies X-TD-SIGNATURE per ThriveDesk docs
// - Uses the SAME contact lookup approach as your working /contact-and-enrolments
// - Adds a contact note to aXcelerate (POST /api/contact/note/)

const crypto = require("crypto");

// ====== ENV ======
const AXC_BASE_URL = (process.env.AXC_BASE_URL || "").trim();    // e.g. https://vetnurse.app.axcelerate.com
const AXC_API_TOKEN = (process.env.AXC_API_TOKEN || "").trim();
const AXC_WS_TOKEN  = (process.env.AXC_WS_TOKEN  || "").trim();
const TD_WEBHOOK_SECRET = (process.env.TD_WEBHOOK_SECRET || "").trim(); // your ThriveDesk webhook secret

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

// ====== ThriveDesk signature (per docs) ======
// signature = base64(HMAC_SHA1(secret, JSON.stringify(data)))
function verifyTdSignature(rawBodyStr, event) {
  try {
    const sig = getHeader(event, "x-td-signature");
    if (!sig || !TD_WEBHOOK_SECRET) return { ok: false, reason: "missing" };

    const body = JSON.parse(rawBodyStr || "{}");
    const data = body && typeof body === "object" && body.data !== undefined ? body.data : body;

    const computed = crypto
      .createHmac("sha1", TD_WEBHOOK_SECRET)
      .update(JSON.stringify(data))
      .digest("base64");

    const okMatch = sig === computed;
    return { ok: okMatch, provided: sig, computed };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
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
  ].map(normEmail).filter(Boolean);
}
function isEmailMatch(rec, target) {
  const t = normEmail(target);
  return recordEmails(rec).includes(t);
}

// ====== Robust contact lookup (lifted from working function) ======
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

  // helper: paged search up to 1000 results in case of right-wildcard broad matches
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
  // You can add noteTypeID later if/when confirmed by API: form.set("noteTypeID", "6444");

  const res = await axcFetch(`/api/contact/note/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return res;
}

// ====== Extract email & note content from ThriveDesk payload ======
function extractEmailFromTdData(data) {
  // Per docs: contactInfo.email is the one to trust
  const direct = data?.contactInfo?.email;
  if (direct) return direct;

  // Fallbacks (best-effort)
  const toList = data?.message?.to || data?.payload?.to || [];
  const toEmail = Array.isArray(toList) && toList.length ? (toList[0].email || toList[0]) : null;
  return toEmail || null;
}

function renderNoteFromTdData(data) {
  const subject = data?.message?.subject || data?.conversation?.subject || "(no subject)";
  const bodyHtml = data?.message?.html || data?.message?.body || data?.message?.text || "";
  const toStr = (() => {
    const to = data?.contactInfo?.email || "";
    return to ? `To: ${to}\n` : "";
  })();
  const agent = data?.agent?.name || data?.user?.name || "";
  const header = `Email sent from ThriveDesk\n${toStr}${agent ? `Agent: ${agent}\n` : ""}Subject: ${subject}\n\n`;
  // strip very basic HTML if present
  const text = bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return (header + text).slice(0, 12000); // keep it safe for long emails
}

// ====== Handler ======
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: withCors(), body: "" };

  try {
    assertEnv();
  } catch (err) {
    return bad(500, err.message);
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  // Verify signature
  const sig = verifyTdSignature(rawBody, event);
  if (!sig.ok) {
    console.info("[add-contact-note] signature mismatch or missing");
    // For testing you can return 200 to see logs; in prod, reject:
    return bad(401, "signature verification failed");
  }

  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch {
    return bad(400, "invalid JSON");
  }
  const data = body && typeof body === "object" && body.data !== undefined ? body.data : body;

  const customerEmail = extractEmailFromTdData(data);
  if (!customerEmail) {
    console.info("[add-contact-note] no customer email in payload", {
      hasContactInfo: !!data?.contactInfo, keys: Object.keys(data || {})
    });
    return ok({ skipped: true, reason: "no email" });
  }

  // Find contact in aXcelerate (reusing the robust flow from your working code)
  const { contact, tried } = await findContactByEmail(customerEmail);
  if (!contact) {
    console.info("[add-contact-note] no aXcelerate match", { customerEmail, tried });
    return ok({ skipped: true, reason: "no aX match", customerEmail });
  }

  // Build and POST the note
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
