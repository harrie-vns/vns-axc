// netlify/functions/add-contact-note.js
// Creates a Contact Note in aXcelerate when a reply is sent in ThriveDesk.
//
// Env vars: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN
// Optional: TD_WEBHOOK_SECRET  (if you set a secret header in ThriveDesk)

const AXC_BASE_URL  = (process.env.AXC_BASE_URL  || "").replace(/\/+$/, "");
const AXC_API_TOKEN = (process.env.AXC_API_TOKEN || "").trim();
const AXC_WS_TOKEN  = (process.env.AXC_WS_TOKEN  || "").trim();
const TD_SECRET     = (process.env.TD_WEBHOOK_SECRET || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret",
  "Content-Type": "application/json",
};

const axcHeaders = () => ({ apitoken: AXC_API_TOKEN, wstoken: AXC_WS_TOKEN, json: "true" });
const toForm = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([,v]) => v!==undefined && v!==null).map(([k,v]) => [k, String(v)])));

const stripHtml = (h="") => h
  .replace(/<style[\s\S]*?<\/style>/gi,"")
  .replace(/<script[\s\S]*?<\/script>/gi,"")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;/g," ")
  .replace(/&amp;/g,"&")
  .trim();

const get = (p, o) => p.split(".").reduce((a,k) => (a && a[k] != null ? a[k] : undefined), o);
const pick = (...vals) => vals.find(v => typeof v === "string" && v.trim());

async function axcGet(path, params={}) {
  const url = new URL(`${AXC_BASE_URL}${path}`);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: axcHeaders() });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function resolveContactId({ contactId, email }) {
  if (contactId) return Number(contactId);
  if (!email) return null;

  // exact email
  let r = await axcGet("/api/contacts", { emailAddress: email });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(c =>
      (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
      (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }
  // fallback search
  r = await axcGet("/api/contacts/search", { search: email, displayLength: 20 });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(c =>
      (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
      (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }
  return null;
}

function extractFromThriveDesk(payload = {}) {
  // Works with common webhook shapes; safe if fields differ.
  const email = pick(
    get("contact.email", payload),
    get("customer.email", payload),
    get("data.contact.email", payload),
    get("data.customer.email", payload),
    get("data.conversation.customer.email", payload),
    get("conversation.customer.email", payload),
    get("conversation.contact.email", payload)
  );
  const contactId = get("contact.id", payload) || get("customer.id", payload) ||
                    get("data.contact.id", payload) || get("data.customer.id", payload);

  const subject  = pick(
    get("ticket.subject", payload),
    get("conversation.subject", payload),
    get("data.conversation.subject", payload)
  );
  const htmlBody = pick(
    get("reply.body_html", payload),
    get("message.body_html", payload),
    get("data.message.body_html", payload),
    get("data.reply.body_html", payload),
    get("body_html", payload)
  );
  const textBody = pick(
    get("reply.body_text", payload),
    get("message.body_text", payload),
    get("data.message.body_text", payload),
    get("body_text", payload)
  );
  const agent = pick(
    get("user.name", payload),
    get("agent.name", payload),
    get("data.user.name", payload)
  );
  const number = get("ticket.number", payload) || get("data.conversation.number", payload);
  const ticketUrl = number ? `https://app.thrivedesk.io/inbox/tickets/${number}` : undefined;

  return { email, contactId, subject, htmlBody, textBody, agent, ticketUrl };
}

function buildNote({ subject, htmlBody, textBody, agent, ticketUrl }) {
  const body = (textBody && textBody.trim()) || stripHtml(htmlBody || "") || "(no body)";
  return [
    "Email sent from ThriveDesk",
    agent ? `Agent: ${agent}` : null,
    subject ? `Subject: ${subject}` : null,
    ticketUrl ? `Ticket: ${ticketUrl}` : null,
    "",
    body
  ].filter(Boolean).join("\n");
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST with JSON" }) };
  if (!AXC_BASE_URL || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Missing env: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN" }) };
  }
  if (TD_SECRET) {
    const got = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
    if (got !== TD_SECRET) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Bad webhook secret" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // Accept either direct JSON or ThriveDesk webhook payload
  const direct = {
    email: body.email, contactId: body.contactId,
    subject: body.subject, htmlBody: body.htmlBody, textBody: body.textBody,
    agent: body.agent, ticketUrl: body.ticketUrl, noteTypeID: body.noteTypeID
  };
  const td = extractFromThriveDesk(body);
  const email      = direct.email      || td.email;
  const contactId  = direct.contactId  || td.contactId;
  const subject    = direct.subject    || td.subject;
  const htmlBody   = direct.htmlBody   || td.htmlBody;
  const textBody   = direct.textBody   || td.textBody;
  const agent      = direct.agent      || td.agent;
  const ticketUrl  = direct.ticketUrl  || td.ticketUrl;
  const noteTypeID = direct.noteTypeID ?? 6444; // Email type by default

  const cid = await resolveContactId({ contactId, email });
  if (!cid) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Could not resolve contactID", received: { email, contactId } }) };

  const contactNote = buildNote({ subject, htmlBody, textBody, agent, ticketUrl });

  // POST create note (aXcelerate)
  const url = `${AXC_BASE_URL}/api/contact/note`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...axcHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm({ contactID: cid, contactNote, noteTypeID })
  });
  const text = await res.text();
  let resp; try { resp = JSON.parse(text); } catch { resp = text; }

  return res.ok
    ? { statusCode: 200, headers: CORS, body: JSON.stringify({ created: true, contactId: cid, noteTypeID, usedUrl: url, response: resp }) }
    : { statusCode: res.status || 502, headers: CORS, body: JSON.stringify({ created: false, contactId: cid, noteTypeID, usedUrl: url, response: resp }) };
}
