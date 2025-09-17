// Netlify Serverless Function (Node 18+)
export async function handler(event) {
  // ---- CORS (wide open for testing; you can restrict Origin later) ----
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With,Accept,*",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }

  const headers = { ...CORS, "Content-Type": "application/json" };

  try {
    // --------- params ---------
    const p = event.queryStringParameters || {};
    const email = (p.email || "").trim().toLowerCase();
    const debug = p.debug === "1" || p.debug === "true";
    const minimal = p.minimal === "1" || p.minimal === "true"; // optional

    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };
    }

    // --------- config ---------
    const base = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
    const axc = {
      apitoken: process.env.AXCELERATE_API_TOKEN,
      wstoken: process.env.AXCELERATE_WS_TOKEN,
      Accept: "application/json",
    };

    const tried = [];
    const toLower = (v) => (v || "").toString().toLowerCase();

    // --------- 1) Find contact by email ---------
    const sUrl = `${base}/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
    tried.push({ type: "contactSearch", url: sUrl });
    let list = [];
    try {
      const r = await fetch(sUrl, { headers: axc });
      if (r.ok) list = await r.json();
    } catch {}

    const contact = (Array.isArray(list) ? list : []).find((c) => {
      const e1 = toLower(c.EMAILADDRESS);
      const e2 = toLower(c.EMAILADDRESSALTERNATIVE);
      const e3 = toLower(c.CUSTOMFIELD_PERSONALEMAIL);
      return e1 === email || e2 === email || e3 === email;
    }) || null;

    // --------- helpers ----------
    const looksLikeEnrolment = (obj) =>
      !!obj && typeof obj === "object" &&
      ["STATUS","ENROLMENTID","CODE","NAME","STARTDATE","FINISHDATE","ENROLMENTDATE","INSTANCEID","TYPE","CONTACTID"].some((k) => k in obj);

    const normalise = (data) => {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.rows)) return data.rows;
      if (data && Array.isArray(data.enrolments)) return data.enrolments;
      return [];
    };

    let raw = [];
    let usedUrls = [];

    // --------- 2) Pull enrolments (match Kustomer first) ----------
    if (contact?.CONTACTID) {
      const id = contact.CONTACTID;
      const urls = [
        `${base}/api/course/enrolments?contactID=${id}`,            // Kustomer's exact call
        `${base}/api/course/enrolments?contactID=${id}&limit=100`,  // pagination variant
        `${base}/api/course/enrolments?contactID=${id}&type=p&limit=100`, // programs
        `${base}/api/course/enrolments?contactID=${id}&type=w&limit=100`, // workshops (harmless)
        `${base}/api/enrolments/search?contactID=${id}&displayLength=100`, // generic fallback
      ];

      for (const url of urls) {
        tried.push({ type: "enrolmentsTry", url });
        try {
          const r = await fetch(url, { headers: axc });
          if (!r.ok) continue;
          const data = await r.json();
          const arr = normalise(data).filter(looksLikeEnrolment);
          if (arr.length) { raw = raw.concat(arr); usedUrls.push(url); }
        } catch {}
      }
    }

    // --------- 3) Remove catalog noise ----------
    raw = raw.filter((e) => e.CONTACTID || e.ENROLID);

    // --------- 4) Split quals (TYPE 'p') vs units (TYPE 's') ----------
    const qualificationEnrolments = raw.filter((e) => toLower(e.TYPE) === "p");
    const unitEnrolments = qualificationEnrolments.flatMap((q) =>
      Array.isArray(q.ACTIVITIES) ? q.ACTIVITIES.map((u) => ({
        ...u,
        PROGRAM_CODE: q.CODE,
        PROGRAM_NAME: q.NAME,
        PROGRAM_INSTANCEID: q.INSTANCEID,
        PROGRAM_ENROLID: q.ENROLID,
      })) : []
    );

    // --------- 5) Current-ish quals ----------
    const currentQualifications = qualificationEnrolments.filter((e) =>
      /current|in progress|active|enrolled|ongoing/i.test(String(e.STATUS || "")));

    // --------- 6) Minimal mode (optional to keep payload tiny) ----------
    const body = minimal
      ? {
          contact: contact ? {
            CONTACTID: contact.CONTACTID,
            GIVENNAME: contact.GIVENNAME,
            SURNAME: contact.SURNAME,
            EMAILADDRESS: contact.EMAILADDRESS || contact.CUSTOMFIELD_PERSONALEMAIL || contact.EMAILADDRESSALTERNATIVE,
          } : null,
          currentQualifications: currentQualifications.map(q => ({
            CODE: q.CODE, NAME: q.NAME, STATUS: q.STATUS,
            ENROLMENTDATE: q.ENROLMENTDATE, STARTDATE: q.STARTDATE, FINISHDATE: q.FINISHDATE
          })),
        }
      : {
          contact,
          qualificationEnrolments,
          currentQualifications,
          unitEnrolments,
          enrolments: raw, // full merged list (if you still want it)
        };

    if (debug) body._debug = { tried, usedUrls };

    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    // Always return JSON + CORS so UIs don't choke
    return { statusCode: 500, headers, body: JSON.stringify({ error: "internal_error", message: String(err) }) };
  }
}
