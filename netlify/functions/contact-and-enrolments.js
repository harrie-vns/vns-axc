// Netlify Serverless Function (Node 18+)
// Fetch aXcelerate contact + enrolments by email.
// Adds robust enrolment fetching using the **singular** `contact` endpoints.
// Debug: append `&debug=1` to see which URLs were tried.
export async function handler(event) {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const params = event.queryStringParameters || {};
  const email = (params.email || "").trim().toLowerCase();
  const debug = params.debug === "1" || params.debug === "true";
  if (!email) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "email required" }) };
  }

  const base = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
  const axcHeaders = {
    apitoken: process.env.AXCELERATE_API_TOKEN,
    wstoken: process.env.AXCELERATE_WS_TOKEN,
    Accept: "application/json",
  };

  const tried = [];

  // 1) Broad contact search then exact-match on any email field
  const sUrl = `${base}/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
  tried.push({ type: "contactSearch", url: sUrl });
  let list = [];
  try {
    const sRes = await fetch(sUrl, { headers: axcHeaders });
    if (sRes.ok) list = await sRes.json();
  } catch {}

  const toLower = (v) => (v || "").toString().toLowerCase();
  const contact = (Array.isArray(list) ? list : []).find((c) => {
    const e1 = toLower(c.EMAILADDRESS);
    const e2 = toLower(c.EMAILADDRESSALTERNATIVE);
    const e3 = toLower(c.CUSTOMFIELD_PERSONALEMAIL);
    return e1 === email || e2 === email || e3 === email;
  }) || null;

  let enrolments = [];
  let usedUrl = null;

  // Helper to check that a record "looks like" an enrolment (not a contact)
  const looksLikeEnrolment = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    const clues = ["STATUS", "ENROLMENTID", "ENROLMENT_ID", "COURSE", "COURSENAME", "PROGRAMNAME", "CLASSNAME", "STARTDATE", "ENDDATE"];
    return clues.some((k) => k in obj);
  };

  if (contact?.CONTACTID) {
    const contactID = contact.CONTACTID;

    const enrolUrls = [
      // Correct (singular) contact endpoints first
      `${base}/api/contact/enrolments?contactID=${contactID}&displayLength=100`,
      `${base}/api/contact/${contactID}/enrolments`,
      // Fallback to the general search
      `${base}/api/enrolments/search?contactID=${contactID}&displayLength=100`,
    ];

    for (const url of enrolUrls) {
      tried.push({ type: "enrolmentsTry", url });
      try {
        const r = await fetch(url, { headers: axcHeaders });
        if (!r.ok) continue;
        const data = await r.json();
        const arr = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
        if (Array.isArray(arr) && arr.length && looksLikeEnrolment(arr[0])) {
          enrolments = arr;
          usedUrl = url;
          break;
        }
      } catch {}
    }
  }

  // Filter to "current-ish" statuses
  const currentEnrolments = enrolments.filter((e) => {
    const status = toLower(e.STATUS || e.Status);
    return /current|active|enrolled|ongoing/.test(status);
  });

  const body = { contact, enrolments, currentEnrolments };
  if (debug) body._debug = { tried, usedUrl };

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
