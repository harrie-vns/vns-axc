// netlify/functions/contact-and-enrolments.js
// Fetch aXcelerate contact by email, then program (qualification) enrolments.
// Adds EXPECTEDCOMPLETIONDATE via (1) enrolment field, (2) instance detail end date, (3) latest unit end/proposed end.
// Single-call to /api/course/enrolments to avoid duplicates. Includes CORS for ThriveDesk.

export async function handler(event) {
  // ---- CORS (relaxed; tighten Origin later if needed) ----
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

  // ---- Config ----
  const BASE = process.env.AXCELERATE_BASE || "https://vetnurse.app.axcelerate.com";
  const AX_HEADERS = {
    apitoken: process.env.AXCELERATE_API_TOKEN || "",
    wstoken: process.env.AXCELERATE_WS_TOKEN || "",
    Accept: "application/json",
  };

  // ---- Helpers ----
  const buildUrl = (path, params = {}) => {
    const u = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    }
    return u.toString();
  };

  const axGet = async (path, params, debug, tag) => {
    const url = buildUrl(path, params);
    debug.tried.push({ type: tag, url });
    const res = await fetch(url, { headers: AX_HEADERS });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`aXcelerate GET ${url} -> ${res.status} ${res.statusText} ${text}`);
    }
    debug.usedUrls.push(url);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const t = await res.text();
      try { return JSON.parse(t); } catch { return []; }
    }
    return res.json();
  };

  const toLower = (v) => (v || "").toString().toLowerCase();

  const pickExactContact = (rows, email) => {
    if (!Array.isArray(rows)) return null;
    const em = toLower(email);
    const fields = ["EMAILADDRESS", "CUSTOMFIELD_PERSONALEMAIL", "EMAILADDRESSALTERNATIVE"];
    // exact match first
    let hit = rows.find(c => fields.some(f => toLower(c[f]) === em));
    if (hit) return hit;
    // startsWith fallback (aXcelerate wildcard on right)
    hit = rows.find(c => fields.some(f => toLower(c[f]).startsWith(em)));
    return hit || null;
  };

  const asDate = (s) => {
    if (!s) return null;
    const clean = String(s).replace(" 00:00", "T00:00:00");
    const d = new Date(clean);
    return isNaN(d) ? null : d;
  };

  const fmt = (d) => {
    if (!d) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00`;
  };

  // Try to compute Expected Completion for a program enrolment
  const deriveExpectedCompletion = async (enrol, debug) => {
    // 1) direct enrolment fields (tenant/version vary)
    const enrolFields = [
      "DATECOMPLETIONEXPECTED", "DateCompletionExpected",
      "EXPECTEDCOMPLETIONDATE", "ExpectedCompletionDate",
      "EXPECTED_FINISH", "ExpectedFinishDate"
    ];
    for (const f of enrolFields) {
      if (enrol && enrol[f]) return enrol[f];
    }

    // 2) course instance detail end date
    if (enrol?.INSTANCEID) {
      try {
        const detail = await axGet("/api/course/instance/detail", { id: enrol.INSTANCEID, type: "p" }, debug, "instanceDetail");
        const end = detail?.FINISHDATE || detail?.ENDDATE || detail?.EndDate || detail?.EXPECTEDFINISHDATE || null;
        if (end) return end;
      } catch { /* ignore and continue */ }
    }

    // 3) latest unit end/proposed end in ACTIVITIES
    if (Array.isArray(enrol?.ACTIVITIES) && enrol.ACTIVITIES.length) {
      const candidates = enrol.ACTIVITIES
        .map(a => a?.PROPOSEDENDDATE || a?.ProposedEndDate || a?.ActivityEndDate || a?.FINISHDATE || null)
        .filter(Boolean)
        .map(asDate)
        .filter(Boolean);
      if (candidates.length) {
        candidates.sort((a, b) => b - a);
        return fmt(candidates[0]);
      }
    }

    return null;
  };

  try {
    const qs = event.queryStringParameters || {};
    const email = (qs.email || "").trim();
    const debugWanted = qs.debug === "1" || qs.debug === "true";
    const minimal = qs.minimal === "1" || qs.minimal === "true";
    const debug = { tried: [], usedUrls: [] };

    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "email required", _debug: debugWanted ? debug : undefined }) };
    }

    // 1) Contact by email (broad search, then exact match)
    const contactSearch = await axGet("/api/contacts/search", { search: email, displayLength: 100 }, debug, "contactSearch");
    const contact = pickExactContact(contactSearch, email);
    if (!contact) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "contact_not_found", _debug: debugWanted ? debug : undefined }) };
    }

    // 2) Single call: program enrolments + units in ACTIVITIES
    const enrols = await axGet("/api/course/enrolments", { contactID: contact.CONTACTID, limit: 100 }, debug, "courseEnrolments");

    // 3) Keep program (qualification) enrolments only & dedupe by ENROLID/INSTANCEID
    const programMap = new Map();
    for (const e of (Array.isArray(enrols) ? enrols : [])) {
      if (toLower(e?.TYPE) !== "p") continue;
      const key = e.ENROLID ?? e.INSTANCEID ?? `${e.CODE || ""}|${e.STARTDATE || ""}`;
      if (!programMap.has(key)) programMap.set(key, e);
    }
    const programs = Array.from(programMap.values());

    // 4) Build outputs
    const qualificationEnrolments = [];
    for (const p of programs) {
      const EXPECTEDCOMPLETIONDATE = await deriveExpectedCompletion(p, debug);
      qualificationEnrolments.push({
        ...p,
        EXPECTEDCOMPLETIONDATE
      });
    }

    const currentQualifications = qualificationEnrolments.filter(q =>
      /current|in progress|active|enrolled|ongoing/i.test(String(q.STATUS || ""))
    );

    const unitEnrolments = qualificationEnrolments.flatMap(q =>
      Array.isArray(q.ACTIVITIES) ? q.ACTIVITIES.map(u => ({
        ...u,
        PROGRAM_CODE: q.CODE,
        PROGRAM_NAME: q.NAME,
        PROGRAM_INSTANCEID: q.INSTANCEID,
        PROGRAM_ENROLID: q.ENROLID,
      })) : []
    );

    // 5) Shape response
    const baseContact = {
      CONTACTID: contact.CONTACTID,
      GIVENNAME: contact.GIVENNAME,
      SURNAME: contact.SURNAME,
      EMAILADDRESS: contact.EMAILADDRESS || contact.CUSTOMFIELD_PERSONALEMAIL || contact.EMAILADDRESSALTERNATIVE || null,
    };

    const body = minimal
      ? {
          contact: baseContact,
          currentQualifications: currentQualifications.map(q => ({
            CODE: q.CODE, NAME: q.NAME, STATUS: q.STATUS,
            ENROLMENTDATE: q.ENROLMENTDATE, STARTDATE: q.STARTDATE, FINISHDATE: q.FINISHDATE,
            EXPECTEDCOMPLETIONDATE: q.EXPECTEDCOMPLETIONDATE
          })),
          _debug: debugWanted ? debug : undefined
        }
      : {
          contact: baseContact,
          qualificationEnrolments,
          currentQualifications,
          unitEnrolments,
          _debug: debugWanted ? debug : undefined
        };

    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "internal_error", message: String(err) }) };
  }
}
