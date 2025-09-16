// Netlify Serverless Function (Node 18+)
// Usage:
//   https://<your-site>.netlify.app/.netlify/functions/contact-and-enrolments?email=user@example.com
export async function handler(event) {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const emailRaw = (event.queryStringParameters && event.queryStringParameters.email) || "";
  const email = emailRaw.trim().toLowerCase();
  if (!email) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "email required" }) };
  }

  const base = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
  const axcHeaders = {
    apitoken: process.env.AXCELERATE_API_TOKEN,
    wstoken: process.env.AXCELERATE_WS_TOKEN,
    Accept: "application/json",
  };

  // 1) Broad search then exact match against any of the 3 email fields
  const sUrl = `${base}/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
  let list = [];
  try {
    const sRes = await fetch(sUrl, { headers: axcHeaders });
    if (sRes.ok) {
      list = await sRes.json();
    }
  } catch (err) {
    // ignore and continue; we'll return contact: null later
  }

  const toLower = (v) => (v || "").toString().toLowerCase();
  const contact = (Array.isArray(list) ? list : []).find((c) => {
    const e1 = toLower(c.EMAILADDRESS);
    const e2 = toLower(c.EMAILADDRESSALTERNATIVE);
    const e3 = toLower(c.CUSTOMFIELD_PERSONALEMAIL);
    return e1 === email || e2 === email || e3 === email;
  }) || null;

  // 2) Get enrolments for that contact (try two common endpoints)
  let enrolments = [];
  if (contact && contact.CONTACTID) {
    const urls = [
      `${base}/api/enrolments/search?contactID=${contact.CONTACTID}&displayLength=100`,
      `${base}/api/contacts/${contact.CONTACTID}/enrolments`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: axcHeaders });
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data) && data.length) { enrolments = data; break; }
        }
      } catch (err) {
        // try next URL
      }
    }
  }

  // 3) Handy filtered list of "current-ish" enrolments
  const currentEnrolments = enrolments.filter((e) => {
    const status = toLower(e.STATUS || e.Status);
    return /current|active|enrolled|ongoing/.test(status);
  });

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({ contact, enrolments, currentEnrolments }),
  };
}
