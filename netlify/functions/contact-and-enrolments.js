// Netlify Serverless Function (Node 18+)
export async function handler(event) {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const p = event.queryStringParameters || {};
  const email = (p.email || "").trim().toLowerCase();
  const debug = p.debug === "1" || p.debug === "true";
  if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "email required" }) };

  const base = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
  const axc = { apitoken: process.env.AXCELERATE_API_TOKEN, wstoken: process.env.AXCELERATE_WS_TOKEN, Accept: "application/json" };
  const tried = [];
  const toLower = v => (v || "").toString().toLowerCase();

  // 1) Find contact by email (broad -> exact match against three email fields)
  const sUrl = `${base}/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
  tried.push({ type: "contactSearch", url: sUrl });
  let list = [];
  try { const r = await fetch(sUrl, { headers: axc }); if (r.ok) list = await r.json(); } catch {}
  const contact = (Array.isArray(list) ? list : []).find(c => {
    const e1 = toLower(c.EMAILADDRESS);
    const e2 = toLower(c.EMAILADDRESSALTERNATIVE);
    const e3 = toLower(c.CUSTOMFIELD_PERSONALEMAIL);
    return e1 === email || e2 === email || e3 === email;
  }) || null;

  let enrolments = [];
  let usedUrls = [];

  const looksLikeEnrolment = obj => !!obj && typeof obj === "object" &&
    ["STATUS","ENROLMENTID","CODE","COURSENAME","PROGRAMNAME","CLASSNAME","NAME","STARTDATE","FINISHDATE","ENROLMENTDATE","INSTANCEID","TYPE"].some(k => k in obj);

  const normalise = data => {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.rows)) return data.rows;
    if (data && Array.isArray(data.enrolments)) return data.enrolments;
    return [];
  };

  if (contact?.CONTACTID) {
    const id = contact.CONTACTID;

    // 2) Match Kustomer exactly FIRST (no type param)
    const urls = [
      `${base}/api/course/enrolments?contactID=${id}`,
      // then useful fallbacks
      `${base}/api/course/enrolments?contactID=${id}&limit=100`,
      `${base}/api/course/enrolments?contactID=${id}&type=p&limit=100`,
      `${base}/api/course/enrolments?contactID=${id}&type=w&limit=100`,
      `${base}/api/courses/enrolments?contactID=${id}&displayLength=100`,
      `${base}/api/enrolments/search?contactID=${id}&displayLength=100`,
      `${base}/api/contact/enrolments?contactID=${id}&displayLength=100`,
      `${base}/api/contact/${id}/enrolments`
    ];

    for (const url of urls) {
      tried.push({ type: "enrolmentsTry", url });
      try {
        const r = await fetch(url, { headers: axc });
        if (!r.ok) continue;
        const data = await r.json();
        const arr = normalise(data).filter(looksLikeEnrolment);
        if (arr.length) { enrolments = enrolments.concat(arr); usedUrls.push(url); }
      } catch {}
    }
  }

  // 3) Deduplicate (by ENROLMENTID or fallback key)
  const seen = new Set();
  enrolments = enrolments.filter(e => {
    const key = e.ENROLMENTID ?? `${e.INSTANCEID || ""}|${e.TYPE || ""}|${e.CONTACTID || ""}|${e.CODE || ""}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // 4) "Current-ish" filter for convenience
  const currentEnrolments = enrolments.filter(e => /current|active|enrolled|ongoing/i.test(String(e.STATUS || e.Status || "")));

  const body = { contact, enrolments, currentEnrolments };
  if (debug) body._debug = { tried, usedUrls };
  return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
