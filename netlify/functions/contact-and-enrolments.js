// Netlify Function: /contact-and-enrolments
// Fetch FULL contact + FULL qualification (program) enrolments for a given email.
// Also returns a concise summary array for easy mapping and a direct aX contact link.
//
// Required env vars (set in Netlify > Site settings > Environment variables):
//   AXC_BASE_URL   e.g. https://vetnurse.app.axcelerate.com
//   AXC_API_TOKEN
//   AXC_WS_TOKEN
//
// Query:
//   ?email=<urlencoded email>[&debug=1]
//
// Response shape:
// {
//   contact: <FULL aX contact object>,
//   contactSummary: {...small subset...},     // convenience only
//   currentQualifications: [ { summary fields… } ],
//   programEnrolments: [ <FULL program enrolment objects> ],
//   axcelerateContactUrl: "https://.../Contact_View.cfm?ContactID=...",
//   _debug?: { tried: [...], usedUrls: [...], envSeen: {...} }
// }

const ALLOWED_ORIGINS = ["*"];

// ---- ENV handling (with fallbacks, just in case) ----
const AXC_BASE_URL =
  (process.env.AXC_BASE_URL || process.env.AXC_BASE || process.env.AXC_BASEURL || "").trim();
const AXC_API_TOKEN =
  (process.env.AXC_API_TOKEN || process.env.apitoken || process.env.AXC_APITOKEN || "").trim();
const AXC_WS_TOKEN =
  (process.env.AXC_WS_TOKEN || process.env.wstoken || process.env.AXC_WSTOKEN || "").trim();

const baseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
};

function withCors(h) {
  return {
    ...h,
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };
}

const ok = (data) => ({ statusCode: 200, headers: withCors(baseHeaders), body: JSON.stringify(data) });
const bad = (code, msg, extra = {}) => ({
  statusCode: code,
  headers: withCors(baseHeaders),
  body: JSON.stringify({ error: msg, ...extra }),
});

function assertEnv() {
  const missing = [];
  if (!AXC_BASE_URL) missing.push("AXC_BASE_URL");
  if (!AXC_API_TOKEN) missing.push("AXC_API_TOKEN");
  if (!AXC_WS_TOKEN) missing.push("AXC_WS_TOKEN");
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

function apiHeaders() {
  return { apitoken: AXC_API_TOKEN, wstoken: AXC_WS_TOKEN };
}

function isEmailEqual(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

function dedupeByEnrolId(items) {
  const seen = new Map();
  for (const it of items) {
    const key = String(it.ENROLID ?? `${it.CODE || "UNK"}:${it.INSTANCEID || "UNK"}`);
    if (!seen.has(key)) seen.set(key, it);
  }
  return Array.from(seen.values());
}

function programSummary(e) {
  return {
    ENROLID: e.ENROLID ?? null,
    INSTANCEID: e.INSTANCEID ?? null,
    CODE: e.CODE ?? null,
    NAME: e.NAME ?? null,
    STATUS: e.STATUS ?? null,
    ENROLMENTDATE: e.ENROLMENTDATE ?? null,
    STARTDATE: e.STARTDATE ?? null,
    FINISHDATE: e.FINISHDATE ?? null, // stays null until completion/withdrawal
    AMOUNTPAID: e.AMOUNTPAID ?? null,
    // Expected completion is not exposed by this list endpoint.
    expectedCompletionDate: null,
  };
}

function isCurrentStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  const notCurrent = ["withdrawn", "cancelled", "deleted", "completed", "finished"];
  return !notCurrent.includes(s);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: withCors({}), body: "" };
  }

  try {
    assertEnv();
  } catch (err) {
    return bad(500, err.message);
  }

  const { email, debug } = event.queryStringParameters || {};
  if (!email) return bad(400, 'Query param "email" is required, e.g. ?email=someone%40example.com');

  const base = AXC_BASE_URL.replace(/\/+$/, "");
  const tried = [];
  const usedUrls = [];

  async function axc(pathWithQuery) {
    const url = `${base}${pathWithQuery}`;
    tried.push({ type: "GET", url });
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`aXcelerate ${res.status} for ${url} :: ${text.slice(0, 300)}`);
    }
    usedUrls.push(url);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  try {
    // 1) Contact lookup — try exact email param first, then broader 'search'
    let contacts = await axc(`/api/contacts/search?emailAddress=${encodeURIComponent(email)}&displayLength=100`);
    if (!Array.isArray(contacts) || contacts.length === 0) {
      contacts = await axc(`/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`);
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
      const out = { contact: null, currentQualifications: [], programEnrolments: [] };
      if (debug) out._debug = { tried, usedUrls, envSeen: {
        has_BASE_URL: !!AXC_BASE_URL, has_API_TOKEN: !!AXC_API_TOKEN, has_WS_TOKEN: !!AXC_WS_TOKEN } };
      return ok(out);
    }

    // Choose best exact match across EMAILADDRESS / ALT / PERSONAL
    const contact =
      contacts.find((c) => isEmailEqual(c.EMAILADDRESS, email)) ||
      contacts.find((c) => isEmailEqual(c.EMAILADDRESSALTERNATIVE, email)) ||
      contacts.find((c) => isEmailEqual(c.CUSTOMFIELD_PERSONALEMAIL, email)) ||
      contacts[0];

    // Keep FULL contact (no stripping)
    const fullContact = contact;

    // 2) Enrolments (single call), filter to program TYPE 'p', de-dupe
    const enrolments = await axc(`/api/course/enrolments?contactID=${encodeURIComponent(String(contact.CONTACTID))}&limit=100`);
    const programRows = Array.isArray(enrolments) ? enrolments.filter((e) => (e.TYPE || e.type) === "p") : [];
    const programUnique = dedupeByEnrolId(programRows);

    // FULL raw program enrolments
    const programEnrolments = programUnique;

    // Small summary & current filtering
    const currentQualifications = programUnique.map(programSummary).filter((e) => isCurrentStatus(e.STATUS));

    // 3) Direct link into aXcelerate UI
    const portalBase = base.replace(/\/api\/?$/, "");
    const axcelerateContactUrl =
      `${portalBase}/management/management2/Contact_View.cfm?ContactID=${encodeURIComponent(String(contact.CONTACTID))}`;

    // Optional small contact subset (you can ignore this and just use `contact.*`)
    const contactSummary = {
      CONTACTID: contact.CONTACTID,
      GIVENNAME: contact.GIVENNAME,
      SURNAME: contact.SURNAME,
      EMAILADDRESS: contact.EMAILADDRESS || contact.CUSTOMFIELD_PERSONALEMAIL || contact.EMAILADDRESSALTERNATIVE || null,
      MOBILEPHONE: contact.MOBILEPHONE ?? null,
      PHONE: contact.PHONE ?? null,
      WORKPHONE: contact.WORKPHONE ?? null,
      ADDRESS1: contact.ADDRESS1 ?? null,
      ADDRESS2: contact.ADDRESS2 ?? null,
      CITY: contact.CITY ?? null,
      STATE: contact.STATE ?? null,
      POSTCODE: contact.POSTCODE ?? null,
      COUNTRY: contact.COUNTRY ?? contact.SCOUNTRY ?? null,
      CONTACT_LINK: axcelerateContactUrl,
    };

    const payload = {
      contact: fullContact,            // FULL contact object (ALL fields)
      contactSummary,                  // optional subset for convenience
      currentQualifications,           // tidy summary of program enrolments
      programEnrolments,               // FULL program enrolment objects (ALL fields)
      axcelerateContactUrl,
    };

    if (debug) {
      payload._debug = {
        tried,
        usedUrls,
        envSeen: {
          has_BASE_URL: !!AXC_BASE_URL,
          has_API_TOKEN: !!AXC_API_TOKEN,
          has_WS_TOKEN: !!AXC_WS_TOKEN,
        },
      };
    }

    return ok(payload);
  } catch (err) {
    return bad(500, "Failed to fetch from aXcelerate", {
      details: err.message,
      ...(debug ? { _debug: { tried, usedUrls, envSeen: {
        has_BASE_URL: !!AXC_BASE_URL, has_API_TOKEN: !!AXC_API_TOKEN, has_WS_TOKEN: !!AXC_WS_TOKEN } } } : {}),
    });
  }
};
