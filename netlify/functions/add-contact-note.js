// netlify/functions/add-contact-note.js
const crypto = require("crypto");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const reqHeader = (evt, name) => evt.headers[name] || evt.headers[name.toLowerCase()] || evt.headers[name.toUpperCase()];

const hmacValid = (dataObj, signature, secret) => {
  if (!signature || !secret) return false;
  const payload = JSON.stringify(dataObj); // ThriveDesk signs ONLY the `data` object
  const calc = crypto.createHmac("sha1", secret).update(payload).digest("base64");
  return signature === calc;
};

const axcHeaders = () => ({
  apitoken: process.env.AXC_API_TOKEN,
  wstoken: process.env.AXC_WS_TOKEN,
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Use POST with JSON" }) };
  }

  // Parse & verify ThriveDesk signature
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const secret = process.env.TD_WEBHOOK_SECRET;
  const signature = reqHeader(event, "x-td-signature");
  const data = body?.data;

  if (!data) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing `data` in payload" }) };
  }
  if (!hmacValid(data, signature, secret)) {
    // Return 401 so ThriveDesk retries but doesn't disable the webhook
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  // Pull the email address and the latest outbound email thread
  const contactEmail =
    data?.contact?.email ||
    data?.contactInfo?.email ||
    data?.inbox?.connectedEmailAddress ||
    null;

  // Prefer the most recent outbound Email thread; fallback to excerpt
  let emailThread = null;
  if (Array.isArray(data?.threads)) {
    emailThread = [...data.threads]
      .filter(t => t?.type === "Email" && (t?.direction === "Outbound" || t?.direction === "Agent"))
      .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }

  const subject = data?.subject || "(no subject)";
  const plain = emailThread?.textBody || "";
  const html = emailThread?.htmlBody || "";
  const noteBody =
    `Subject: ${subject}\n\n` +
    (plain ? plain :
      (html ? html.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim() : data?.excerpt || ""));

  // If we can't identify a recipient email, acknowledge to stop retries
  if (!contactEmail) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: "No contact email on event; nothing to do." }) };
  }

  const base = process.env.AXC_BASE_URL?.replace(/\/+$/, "");
  if (!base || !process.env.AXC_API_TOKEN || !process.env.AXC_WS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing AXC env vars" }) };
  }

  // 1) Find the aXcelerate contact by email (try strict endpoint, then search fallback)
  const safeEmail = encodeURIComponent(contactEmail);
  const tryUrls = [
    `${base}/api/contacts?emailAddress=${safeEmail}`,
    `${base}/api/contacts/search?search=${safeEmail}&displayLength=50`
  ];

  let contact = null;
  let lastFetch = null;
  for (const u of tryUrls) {
    const r = await fetch(u, { headers: axcHeaders() });
    lastFetch = { url: u, status: r.status };
    if (!r.ok) continue;
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      // Prefer exact email match if available
      contact = arr.find(c =>
        (c.EMAILADDRESS || c.CUSTOMFIELD_PERSONALEMAIL || "").toLowerCase() === contactEmail.toLowerCase()
      ) || arr[0];
      break;
    }
  }

  if (!contact?.CONTACTID) {
    // Nothing to do, but we succeeded from webhook’s POV
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, msg: "No matching contact found", lastFetch })
    };
  }

  // 2) Create the Contact Note (no noteTypeID)
  const params = new URLSearchParams();
  params.set("contactID", String(contact.CONTACTID));
  params.set("contactNote", noteBody.slice(0, 60000)); // stay well below typical limits

  const noteRes = await fetch(`${base}/api/contact/note/`, {
    method: "POST",
    headers: {
      ...axcHeaders(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const noteText = await noteRes.text().catch(() => "");
  const ok = noteRes.ok;

  // Always return 2xx so ThriveDesk doesn't disable the webhook
  return {
    statusCode: ok ? 200 : 202,
    body: JSON.stringify({
      ok,
      contactID: contact.CONTACTID,
      created: ok,
      axcStatus: noteRes.status,
      axcBody: noteText.slice(0, 2000) // trim for logs
    })
  };
};
