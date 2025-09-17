// netlify/functions/add-contact-note.js
// Create a Contact Note in aXcelerate when a message/reply is sent from ThriveDesk.
//
// Required env vars: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN
// Optional: TD_WEBHOOK_SECRET  (must match TD "Secret Key"; accepted header names: X-Webhook-Secret or X-Secret-Key)

const AXC_BASE_URL  = (process.env.AXC_BASE_URL  || "").replace(/\/+$/, "");
const AXC_API_TOKEN = (process.env.AXC_API_TOKEN || "").trim();
const AXC_WS_TOKEN  = (process.env.AXC_WS_TOKEN  || "").trim();
const TD_SECRET     = (process.env.TD_WEBHOOK_SECRET || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret, X-Secret-Key",
  "Content-Type": "application/json"
};

const axcHeaders = () => ({ apitoken: AXC_API_TOKEN, wstoken: AXC_WS_TOKEN, json: "true" });
const toForm = (o) =>
  new URLSearchParams(
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)])
  );

const stripHtml = (h = "") =>
  h
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

const get = (p, o) => p.split(".").reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o);
const pick = (...vals) => vals.find((v) => typeof v === "string" && v.trim());

async function axcGet(path, params = {}) {
  const url = new URL(`${AXC_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: axcHeaders() });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, url: url.toString() };
}

async function resolveContactId({ contactId, email }) {
  if (contactId) return Number(contactId);
  if (!email) return null;

  // Exact email match via /contacts
  let r = await axcGet("/api/contacts", { emailAddress: email });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(
      (c) =>
        (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
        (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }

  // Fallback: wildcard search
  r = await axcGet("/api/contacts/search", { search: email, displayLength: 20 });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(
      (c) =>
        (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
        (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }
  return null;
}

function extractFromThriveDesk(payload = {}) {
  // Try common ThriveDesk shapes
  const email = pick(
    get("contact.email", payload),
    get("customer.email", payload),
    get("data.contact.email", payload),
    get("data.customer.email", payload),
    get("data.conversation.customer.email", payload),
    get("conversation.customer.email", payload),
    get("conversation.contact.email", payload),
    get("message.to_email", payload),
    (Array.isArray(get("message.to", payload)) && get("message.to", payload)[0])
  );

  const contactId =
    get("contact.id", payload) ||
    get("customer.id", payload) ||
    get("data.contact.id", payload) ||
    get("data.customer.id", payload);

  const subject = pick(
    get("ticket.subject", payload),
    get("conversation.subject", payload),
    get("data.conversation.subject", payload),
    get("message.subject", payload)
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
    get("data.reply.body_text", payload),
    get("body_text", payload)
  );

  const agent = pick(
    get("user.name", payload),
    get("agent.name", payload),
    get("data.user.name", payload),
    get("message.agent_name", payload)
  );

  const number =
    get("ticket.number", payload) ||
    get("data.conversation.number", payload) ||
    get("conversation.number", payload);
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
  ]
    .filter(Boolean)
    .join("\n");
}

function parseBody(event) {
  const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
  let obj = {};
  if (ct.includes("application/json")) {
    try {
      obj = JSON.parse(event.body || "{}");
    } catch {}
    return { obj, ct };
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(event.body || "");
    const plain = Object.fromEntries(params.entries());
    if (plain.payload) {
      try {
        obj = JSON.parse(plain.payload);
      } catch {
        obj = plain;
      }
    } else {
      obj = plain;
    }
    return { obj, ct };
  }
  try {
    obj = JSON.parse(event.body || "{}");
  } catch {
    obj = {};
  }
  return { obj, ct };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST with JSON" }) };

  if (!AXC_BASE_URL || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Missing env: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN" })
    };
  }

  // Accept either header name for the secret
  if (TD_SECRET) {
    const got =
      event.headers["x-webhook-secret"] ||
      event.headers["X-Webhook-Secret"] ||
      event.headers["x-secret-key"] ||
      event.headers["X-Secret-Key"];
    if (got !== TD_SECRET) {
      console.log("[add-contact-note] secret mismatch; header keys:", Object.keys(event.headers || {}));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Bad webhook secret" }) };
    }
  }

  const { obj: body, ct } = parseBody(event);

  const td = extractFromThriveDesk(body);
  const email = pick(body.email, td.email);
  const contactId = body.contactId || td.contactId;
  const subject = pick(body.subject, td.subject);
  const htmlBody = pick(body.htmlBody, td.htmlBody);
  const textBody = pick(body.textBody, td.textBody);
  const agent = pick(body.agent, td.agent);
  const ticketUrl = pick(body.ticketUrl, td.ticketUrl);

  console.log("[add-contact-note] start", {
    ct,
    hasBody: !!event.body,
    email,
    contactIdProvided: contactId,
    subjectPresent: !!subject
  });

  const cid = await resolveContactId({ contactId, email });
  if (!cid) {
    console.log("[add-contact-note] could not resolve contact", { email, contactIdProvided: contactId });
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: "Could not resolve contactID", debug: { email, contactIdProvided: contactId } })
    };
  }

  const contactNote = buildNote({ subject, htmlBody, textBody, agent, ticketUrl });

  const url = `${AXC_BASE_URL}/api/contact/note`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...axcHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    // ⛔️ noteTypeID intentionally omitted
    body: toForm({ contactID: cid, contactNote })
  });

  const text = await res.text();
  let resp;
  try {
    resp = JSON.parse(text);
  } catch {
    resp = text;
  }

  console.log("[add-contact-note] axc response", { status: res.status });

  return res.ok
    ? { statusCode: 200, headers: CORS, body: JSON.stringify({ created: true, contactId: cid, usedUrl: url }) }
    : {
        statusCode: res.status || 502,
        headers: CORS,
        body: JSON.stringify({ created: false, contactId: cid, usedUrl: url, response: resp })
      };
}
