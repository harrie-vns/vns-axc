// netlify/functions/add-contact-note.js
// Create a Contact Note in aXcelerate (POST /api/contact/note)
//
// Env vars:
//   AXC_BASE_URL   e.g. https://vetnurse.app.axcelerate.com
//   AXC_API_TOKEN
//   AXC_WS_TOKEN
//
// POST JSON:
// {
//   "email": "student@example.com",       // optional if contactId provided
//   "contactId": 15292430,               // optional if email provided
//   "subject": "Re: Your course",
//   "htmlBody": "<p>Hi…</p>",
//   "textBody": "Hi…",                   // fallback if you prefer
//   "agent": "Harrie Phillips",
//   "ticketUrl": "https://helpdesk/t/123",
//   "noteTypeID": 6444                   // optional; default 6444 (Email)
// }

const AXC_BASE_URL  = (process.env.AXC_BASE_URL  || "").replace(/\/+$/,"");
const AXC_API_TOKEN = (process.env.AXC_API_TOKEN || "").trim();
const AXC_WS_TOKEN  = (process.env.AXC_WS_TOKEN  || "").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

const axcHeaders = () => ({
  apitoken: AXC_API_TOKEN,
  wstoken: AXC_WS_TOKEN,
  json: "true"
});

const toForm = (obj) => new URLSearchParams(
  Object.entries(obj).reduce((acc,[k,v]) => {
    if (v !== undefined && v !== null) acc[k] = String(v);
    return acc;
  }, {})
);

const stripHtml = (html="") =>
  html.replace(/<style[\s\S]*?<\/style>/gi,"")
      .replace(/<script[\s\S]*?<\/script>/gi,"")
      .replace(/<[^>]+>/g," ")
      .replace(/&nbsp;/g," ")
      .replace(/&amp;/g,"&")
      .trim();

async function axcGet(path, params={}) {
  const url = new URL(`${AXC_BASE_URL}${path}`);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const res = await fetch(url, { headers: axcHeaders() });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, url: url.toString() };
}

async function resolveContactId({ contactId, email }) {
  if (contactId) return Number(contactId);
  if (!email) return null;

  // exact email endpoint
  let r = await axcGet("/api/contacts", { emailAddress: email });
  if (r.status === 200 && Array.isArray(r.body) && r.body.length) {
    const exact = r.body.find(c =>
      (c.EMAILADDRESS || "").toLowerCase() === email.toLowerCase() ||
      (c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === email.toLowerCase()
    );
    if (exact) return Number(exact.CONTACTID);
  }

  // fallback: wildcard search
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

function buildNoteText({ subject, htmlBody, textBody, agent, ticketUrl }) {
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
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST with JSON" }) };
  }
  if (!AXC_BASE_URL || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Missing env: AXC_BASE_URL, AXC_API_TOKEN, AXC_WS_TOKEN" }) };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch {}

  const { email, contactId, subject, htmlBody, textBody, agent, ticketUrl } = payload;
  const noteTypeID = payload.noteTypeID ?? 6444; // default to Email note type

  const cid = await resolveContactId({ contactId, email });
  if (!cid) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Could not resolve contactID", received: { email, contactId } }) };
  }

  const contactNote = buildNoteText({ subject, htmlBody, textBody, agent, ticketUrl });

  // *** single canonical create call (POST, no trailing slash) ***
  const url = `${AXC_BASE_URL}/api/contact/note`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...axcHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm({ contactID: cid, contactNote, noteTypeID })
  });

  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }

  if (res.ok) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ contactId: cid, created: true, usedUrl: url, noteTypeID, response: body })
    };
  }

  return {
    statusCode: res.status || 502,
    headers: CORS,
    body: JSON.stringify({ contactId: cid, created: false, noteTypeID, usedUrl: url, response: body })
  };
}
