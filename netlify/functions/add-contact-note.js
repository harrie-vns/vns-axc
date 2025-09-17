// netlify/functions/add-contact-note.js
// Create a Contact Note in aXcelerate when a message/reply is sent from ThriveDesk.
//
// Env vars: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN
// Optional : TD_WEBHOOK_SECRET  (set the same value in ThriveDesk header X-Webhook-Secret)

const AXC_BASE_URL  = (process.env.AXC_BASE_URL  || "").replace(/\/+$/, "");
const AXC_API_TOKEN = (process.env.AXC_API_TOKEN || "").trim();
const AXC_WS_TOKEN  = (process.env.AXC_WS_TOKEN  || "").trim();
const TD_SECRET     = (process.env.TD_WEBHOOK_SECRET || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret",
  "Content-Type": "application/json"
};

const axcHeaders = () => ({ apitoken: AXC_API_TOKEN, wstoken: AXC_WS_TOKEN, json: "true" });
const toForm = (o) => new URLSearchParams(
  Object.entries(o).filter(([,v]) => v !== undefined && v !== null).map(([k,v]) => [k, String(v)])
);

const stripHtml = (h="") =>
  h.replace(/<style[\s\S]*?<\/style>/gi,"")
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
  return { status: res.status, body, url: url.toString() };
}

async function resolveContactId({ contactId, email }) {
  if (contactId) return Number(contactId);
  if (!email) return null;

  let r = await axcGet("/api/contacts", { emailAddress: email });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(c =>
      (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
      (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }

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
  // Try a bunch of likely shapes used by ThriveDesk webhooks
  const email = pick(
    get("contact.email", payload),
    get("customer.email", payload),
    get("data.contact.email", payload),
    get("data.customer.email", payload),
    get("data.conversation.customer.email", payload),
    get("conversation.customer.email", payload),
    get("conversation.contact.email", payload),
    get("message.to_email", payload) // fallback if present
  );

  const contactId = get("contact.id", payload) || get("customer.id", payload) ||
                    get("data.contact.id", payload) || get("data.customer.id", payload);

  const subject  = pick(
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

  const number = get("ticket.number", payload) || get("data.conversation.number", payload) || get("conversation.number", payload);
  const ticketUrl = number ? `https://app.thrivedesk.io/inbox/tickets/${number}` : undefined;

  // Heuristic: only proceed for agent/outgoing messages if we can tell
  const outgoing = [
    get("message.direction", payload) === "outgoing",
    get("message.is_outgoing", payload) === true,
    get("message.from_agent", payload) === true,
    get("data.message.direction", payload) === "outgoing",
  ].some(Boolean);

  return { email, contactId, subject, htmlBody, textBody, agent, ticketUrl, outgoing };
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

function parseBody(event) {
  const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
  let obj = {};
  // Try JSON first
  if (ct.includes("application/json")) {
    try { obj = JSON.parse(event.body || "{}"); } catch {}
    return { obj, ct };
  }
  // Try form-encoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(event.body || "");
    const plain = Object.fromEntries(params.entries());
    // Some services send JSON under "payload"
    if (plain.payload) {
      try { obj = JSON.parse(plain.payload); } catch { obj = plain; }
    } else {
      obj = plain;
    }
    return { obj, ct };
  }
  // Fallback: attempt JSON anyway
  try { obj = JSON.parse(event.body || "{}"); } catch { obj = {}; }
  return { obj, ct };
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

  const { obj: body, ct } = parseBody(event);

  // Merge: accept direct JSON OR webhook-shaped payload
  const td = extractFromThriveDesk(body);
  const email      = pick(body.email, td.email);
  const contactId  = body.contactId || td.contactId;
  const subject    = pick(body.subject, td.subject);
  const htmlBody   = pick(body.htmlBody, td.htmlBody);
  const textBody   = pick(body.textBody, td.textBody);
  const agent      = pick(body.agent, td.agent);
  const ticketUrl  = pick(body.ticketUrl, td.ticketUrl);
  const noteTypeID = body.noteTypeID ?? 6444;

  // Log a safe debug line to Netlify logs
  try {
    console.log("[add-contact-note] ct=", ct, "email=", email, "contactId=", contactId, "subject=", subject);
  } catch {}

  const cid = await resolveContactId({ contactId, email });
  if (!cid) {
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: "Could not resolve contactID", debug: { email, contactIdProvided: contactId, contentType: ct } })
    };
  }

  const contactNote = buildNote({ subject, htmlBody, textBody, agent, ticketUrl });

  const url = `${AXC_BASE_URL}/api/contact/note`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...axcHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm({ contactID: cid, contactNote, noteTypeID })
  });

  const text = await res.text();
  let resp; try { resp = JSON.parse(text); } catch { resp = text; }

  return res.ok
    ? { statusCode: 200, headers: CORS, body: JSON.stringify({ created: true, contactId: cid, noteTypeID, usedUrl: url }) }
    : { statusCode: res.status || 502, headers: CORS, body: JSON.stringify({ created: false, contactId: cid, noteTypeID, usedUrl: url, response: resp }) };
}
