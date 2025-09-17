// Netlify Serverless Function (Node 18+)
// Single-call version for your tenant
export async function handler(event) {
  // ---- CORS ----
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With,Accept,*",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const headers = { ...CORS, "Content-Type": "application/json" };

  try {
    const p = event.queryStringParameters || {};
    const email = (p.email || "").trim().toLowerCase();
    const debug = p.debug === "1" || p.debug === "true";
    const minimal = p.minimal === "1" || p.minimal === "true";
    // Optional override if you ever need it: &etype=p or &etype=w
    const etype = (p.etype || "").trim().toLowerCase(); // "", "p", or "w"
    const limit = p.limit && /^\d+$/.test(p.limit) ? Number(p.limit) : null;

    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };

    const base = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
    const axc = { apitoken: process.env.AXCELERATE_API_TOKEN, wstoken: process.env.AXCELERATE_WS_TOKEN, Accept: "application/json" };
    const toLower = v => (v || "").toString().toLowerCase();

    // --- 1) Find contact by email ---
    const sUrl = `${base}/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
    let list = [];
    try { const r = await fetch(sUrl, { headers: axc }); if (r.ok) list = await r.json(); } catch {}
    const contact = (Array.isArray(list) ? list : []).find(c => {
      const e1 = toLower(c.EMAILADDRESS);
      const e2 = toLower(c.EMAILADDRESSALTERNATIVE);
      const e3 = toLower(c.CUSTOMFIELD_PERSONALEMAIL);
      return e1 === email || e2 === email || e3 === email;
    }) || null;

    const looksLikeEnrolment = obj => !!obj && typeof obj === "object" &&
      ["STATUS","ENROLMENTID","CODE","NAME","STARTDATE","FINISHDATE","ENROLMENTDATE","INSTANCEID","TYPE","CONTACTID"].some(k => k in obj);
    const normalise = data => Array.isArray(data) ? data
                      : (data && Array.isArray(data.rows)) ? data.rows
                      : (data && Array.isArray(data.enrolments)) ? data.enrolments
                      : [];

    let usedUrl = null;
    let raw = [];

    // --- 2) Single enrolments call ---
    if (contact?.CONTACTID) {
      const id = contact.CONTACTID;
      const qs = new URLSearchParams({ contactID: String(id) });
      if (etype === "p" || etype === "w") qs.set("type", etype); // optional override
      if (limit) qs.set("limit", String(limit));                 // optional pagination
      const url = `${base}/api/course/enrolments?${qs.toString()}`;
      usedUrl = url;

      try {
        const r = await fetch(url, { headers: axc });
        if (r.ok) {
          const data = await r.json();
          raw = normalise(data).filter(looksLikeEnrolment);
        }
      } catch {}
    }

    // --- 3) Filter out catalog noise (no CONTACTID/ENROLID) ---
    const items = raw.filter(e => e.CONTACTID || e.ENROLID);

    // --- 4) Split quals (TYPE 'p') vs units (TYPE 's') ---
    const qualificationEnrolments = items.filter(e => toLower(e.TYPE) === "p");

    // De-dupe quals by ENROLID just in case
    const seenQ = new Set();
    const quals = qualificationEnrolments.filter(q => {
      const key = q.ENROLID ?? `${q.INSTANCEID || ""}|${q.CODE || ""}`;
      if (seenQ.has(key)) return false;
      seenQ.add(key);
      return true;
    });

    const unitEnrolments = quals.flatMap(q =>
      Array.isArray(q.ACTIVITIES) ? q.ACTIVITIES.map(u => ({
        ...u,
        PROGRAM_CODE: q.CODE,
        PROGRAM_NAME: q.NAME,
        PROGRAM_INSTANCEID: q.INSTANCEID,
        PROGRAM_ENROLID: q.ENROLID,
      })) : []
    );

    // --- 5) Current-ish quals ---
    const currentQualifications = quals.filter(e =>
      /current|in progress|active|enrolled|ongoing/i.test(String(e.STATUS || "")));

    // --- 6) Minimal vs full ---
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
          _debug: debug ? { usedUrl } : undefined
        }
      : {
          contact,
          qualificationEnrolments: quals,
          currentQualifications,
          unitEnrolments,
          enrolments: items,
          _debug: debug ? { usedUrl } : undefined
        };

    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "internal_error", message: String(err) }) };
  }
}
