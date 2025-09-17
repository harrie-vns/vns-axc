// netlify/functions/add-contact-note.js
import crypto from "crypto";

// ---- helpers ----
function tdSignature(secret, dataObj) {
  // ThriveDesk: base64(HMAC-SHA1(JSON.stringify(data))) using the webhook secret
  // (sign ONLY the `data` field) — see docs. 
  return crypto.createHmac("sha1", secret)
    .update(JSON.stringify(dataObj))
    .digest("base64");
}

function pickContactEmail(data) {
  // Docs sometimes say contactInfo, the sample shows contact.
  return data?.contact?.email || data?.contactInfo?.email || null;
}

function latestOutboundEmailThread(data) {
  const threads = Array.isArray(data?.threads) ? data.threads : [];
  const candidates = threads.filter(t =>
    (t.type === "Email") && (t.direction === "Outbound")
  );
  candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return candidates[0] || null;
}

async function axcFetch(base, path, headers, init = {}) {
  const url = `${base.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, url };
}

function makeNote({ data, outbound, subjectPrefix = "ThriveDesk Email" }) {
  const subj = data?.subject ? `${data.subject}` : "(no subject)";
  const bodyTxt = outbound?.textBody || "";
  const bodyHtml = outbound?.htmlBody || "";

  const stamp = new Date().toISOString();
  let note = `📧 ${subjectPrefix}\nTicket #${data?.ticketId ?? "-"}  •  ${stamp}\n`;
  note += `To: ${data?.contact?.email || data?.contactInfo?.email || "-"}\n`;
  note += `Subject: ${subj}\n\n`;

  if (bodyTxt) {
    note += `--- TEXT ---\n${bodyTxt}\n`;
  } else if (bodyHtml) {
    // Simple HTML to text fallback (very basic)
    note += `--- HTML ---\n${bodyHtml.replace(/<[^>]+>/g, "").trim()}\n`;
  } else if (data?.excerpt) {
    note += `--- EXCERPT ---\n${data.excerpt}\n`;
  } else {
    note += `(no body)\n`;
  }
  return note.slice(0, 60000); // safety: keep it sane
}

// ---- handler ----
export const handler = async (event) => {
  const log = (...args) => console.log("[add-contact-note]", ...args);

  const {
    AXC_BASE_URL,
    AXC_API_TOKEN,
    AXC_WS_TOKEN,
    THRIVEDESK_SECRET,
  } = process.env;

  if (!AXC_BASE_URL || !AXC_API_TOKEN || !AXC_WS_TOKEN || !THRIVEDESK_SECRET) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing env vars" }),
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Use POST with JSON" }),
    };
  }

  // Parse JSON
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    log("bad json", e?.message);
    return { statusCode: 400, body: JSON.stringify({ error: "Bad JSON" }) };
  }

  const sigHeader = event.headers["x-td-signature"] || event.headers["X-TD-Signature"] || "";
  const dataObj = payload?.data;
  if (!dataObj) {
    log("no data field in payload");
    return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
  }

  // Verify signature: ONLY the data object (per docs)
  try {
    const computed = tdSignature(THRIVEDESK_SECRET, dataObj);
    if (sigHeader !== computed) {
      log("signature mismatch", { headerLen: sigHeader.length, computedLen: computed.length });
      return { statusCode: 401, body: JSON.stringify({ error: "signature mismatch or missing" }) };
    }
  } catch (e) {
    log("signature calc error", e?.message);
    return { statusCode: 401, body: JSON.stringify({ error: "signature error" }) };
  }

  // Extract the customer email from webhook
  const customerEmail = pickContactEmail(dataObj);
  if (!customerEmail) {
    log("no customer email in payload", {
      hasContact: !!dataObj?.contact,
      hasContactInfo: !!dataObj?.contactInfo,
    });
    return { statusCode: 200, body: JSON.stringify({ info: "No customer email; nothing to do" }) };
  }

  // Build the note from the last outbound email thread
  const outbound = latestOutboundEmailThread(dataObj);
  const note = makeNote({ data: dataObj, outbound });

  // Prepare aXcelerate headers
  const axcHeaders = {
    apitoken: AXC_API_TOKEN,
    wstoken: AXC_WS_TOKEN,
  };

  // 1) Find contact by email — try search first (more reliable), then direct
  // Search (wildcard/right-match) but we will exact-match filter in JS
  const base = AXC_BASE_URL;
  const tried = [];

  // search by `search=` first
  const r1 = await axcFetch(base, `/api/contacts/search?search=${encodeURIComponent(customerEmail)}&displayLength=25`, axcHeaders);
  tried.push(r1.url);

  let candidates = Array.isArray(r1.body) ? r1.body : [];
  // If the endpoint sometimes returns wrapped objects, normalize
  if (!Array.isArray(candidates) && Array.isArray(r1.body?.body)) candidates = r1.body.body;

  // Filter exact case-insensitive matches on EMAILADDRESS
  let found = candidates.find(c => (c.EMAILADDRESS || "").toLowerCase() === customerEmail.toLowerCase());

  // fallback: direct lookup
  if (!found) {
    const r2 = await axcFetch(base, `/api/contacts?emailAddress=${encodeURIComponent(customerEmail)}`, axcHeaders);
    tried.push(r2.url);
    const body = r2.body;
    if (Array.isArray(body) && body.length) {
      // Many tenants return a single contact in an array
      const exact = body.find(c => (c.EMAILADDRESS || "").toLowerCase() === customerEmail.toLowerCase());
      found = exact || body[0];
    } else if (body && typeof body === "object" && body.CONTACTID) {
      found = body;
    }
  }

  if (!found?.CONTACTID) {
    log("no matching contact in aXcelerate", { customerEmail, tried });
    return {
      statusCode: 200,
      body: JSON.stringify({ info: "No aXcelerate match; skipped", tried }),
    };
  }

  // 2) Add the contact note (PUT)
  const putBody = {
    contactID: found.CONTACTID,
    contactNote: note,
    // noteTypeID: 6444, // leave off for now per your testing
  };

  const putRes = await axcFetch(base, `/api/contact/note/`, axcHeaders, {
    method: "PUT",
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    log("axcelerate note PUT failed", { status: putRes.status, body: putRes.body });
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "aXcelerate note create failed", putRes }),
    };
  }

  // Done
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      contactID: found.CONTACTID,
      email: customerEmail,
      noteLength: note.length,
    }),
  };
};
