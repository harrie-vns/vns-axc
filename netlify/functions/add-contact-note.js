// netlify/functions/add-contact-note.js
import crypto from "crypto";

const log = (...a) => console.log("[add-contact-note]", ...a);

// --- signature verification (ThriveDesk: HMAC-SHA1 BASE64 over JSON.stringify(data)) ---
function computeSignature(secret, dataObj) {
  const h = crypto.createHmac("sha1", secret);
  h.update(JSON.stringify(dataObj));
  return h.digest("base64");
}

function signatureOk(headerValue, secret, payload) {
  if (!secret) return true; // no secret set = skip
  if (!headerValue) return false;
  const expected = computeSignature(secret, payload?.data ?? payload);
  // Simple string compare (avoids timingSafeEqual length errors seen earlier)
  return headerValue === expected;
}

// --- tiny helper: HTML -> plain text for notes ---
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const AXC = {
  base: process.env.AXC_BASE_URL?.replace(/\/+$/, ""),
  apitoken: process.env.AXC_API_TOKEN,
  wstoken: process.env.AXC_WS_TOKEN,
};

async function axcFetch(path, opts = {}) {
  const url = `${AXC.base}${path}`;
  const headers = {
    apitoken: AXC.apitoken,
    wstoken: AXC.wstoken,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function findContactByEmail(email) {
  // Use /contacts/search and pick the best exact match
  const q = encodeURIComponent(email);
  const { ok, body } = await axcFetch(`/api/contacts/search?search=${q}&displayLength=100`, { method: "GET" });
  if (!ok || !Array.isArray(body) || body.length === 0) return null;

  const lower = email.toLowerCase();
  const exact = body.find(
    c =>
      (c.EMAILADDRESS && c.EMAILADDRESS.toLowerCase() === lower) ||
      (c.EMAILADDRESSALTERNATIVE && c.EMAILADDRESSALTERNATIVE.toLowerCase() === lower) ||
      (c.CUSTOMFIELD_PERSONALEMAIL && c.CUSTOMFIELD_PERSONALEMAIL.toLowerCase() === lower)
  );
  return exact || (body.length === 1 ? body[0] : null);
}

async function addContactNote(contactID, noteText) {
  // aXcelerate prefers form-encoded for this endpoint
  const form = new URLSearchParams();
  form.set("contactID", String(contactID));
  form.set("contactNote", noteText);
  // Intentionally NOT sending noteTypeID per your finding (defaults to System Note)
  return axcFetch("/api/contact/note/", {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Use POST with JSON" }) };
    }
    if (!AXC.base || !AXC.apitoken || !AXC.wstoken) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing aXcelerate env vars" }) };
    }
    const raw = event.body;
    if (!raw) {
      log("no body");
      return { statusCode: 400, body: JSON.stringify({ error: "Missing body" }) };
    }

    let payload;
    try { payload = JSON.parse(raw); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Body must be JSON" }) };
    }

    const sig = event.headers["x-td-signature"] || event.headers["X-TD-Signature"];
    const secret = process.env.TD_WEBHOOK_SECRET;
    const allowUnverified = String(process.env.ALLOW_UNVERIFIED_WEBHOOKS || "").toLowerCase() === "true";

    if (!allowUnverified && !signatureOk(sig, secret, payload)) {
      log("signature mismatch or missing");
      return { statusCode: 401, body: JSON.stringify({ error: "Signature check failed" }) };
    }

    const data = payload.data || payload;

    // 1) Get the recipient email (customer) from the documented field
    const customerEmail =
      data?.contactInfo?.email ||
      data?.contact?.email ||
      data?.customer?.email ||
      data?.conversation?.contact?.email ||
      null;

    if (!customerEmail) {
      log("no customer email in payload", {
        hasContactInfo: !!data?.contactInfo, hasContact: !!data?.contact, hasCustomer: !!data?.customer
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "No customer email present" }) };
    }

    // 2) Find the contact in aXcelerate
    const contact = await findContactByEmail(customerEmail);
    if (!contact?.CONTACTID) {
      log("contact not found for email", customerEmail);
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "Contact not found", email: customerEmail }) };
    }

    // 3) Build the note from the latest outbound thread (if present); otherwise fallback to subject/message
    const threads =
      data?.threads ||
      data?.conversation?.threads ||
      [];

    const latestOutbound = [...threads].reverse().find(t => String(t?.direction || "").toLowerCase() === "outbound");

    const subject =
      latestOutbound?.subject ||
      data?.subject ||
      data?.conversation?.subject ||
      "(no subject)";

    const bodyHtml =
      latestOutbound?.htmlBody ||
      latestOutbound?.body ||
      data?.message?.htmlBody ||
      data?.message?.body ||
      "";

    const bodyText =
      latestOutbound?.textBody ||
      htmlToText(bodyHtml);

    const inboxName = data?.inbox?.name || "";
    const inboxAddr = data?.inbox?.connectedEmailAddress || "";
    const convId = data?.conversation?.id || data?.id;

    const note = [
      `Email sent via ThriveDesk`,
      subject ? `Subject: ${subject}` : null,
      inboxName || inboxAddr ? `From: ${inboxName}${inboxAddr ? ` <${inboxAddr}>` : ""}` : null,
      `To: ${customerEmail}`,
      convId ? `Conversation ID: ${convId}` : null,
      "",
      bodyText || "(no body provided)"
    ].filter(Boolean).join("\n");

    // 4) Add the contact note in aXcelerate
    const { ok, status, body } = await addContactNote(contact.CONTACTID, note);

    if (!ok) {
      log("aXcelerate note failed", { status, body });
      return { statusCode: 502, body: JSON.stringify({ error: "aXcelerate note failed", status, body }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        contactID: contact.CONTACTID,
        email: customerEmail,
        noteChars: note.length
      })
    };
  } catch (err) {
    log("error", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
};
