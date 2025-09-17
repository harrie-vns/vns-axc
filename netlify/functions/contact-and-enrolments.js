// Netlify Function: /contact-and-enrolments
// Fetch a contact by email (robust matching) and their PROGRAM (qualification) enrolments.
// Env vars required:
//   AXC_BASE_URL      e.g. https://vetnurse.app.axcelerate.com
//   AXC_API_TOKEN
//   AXC_WS_TOKEN
//
// Notes:
// - We use /contacts/search?search=<email> because it's consistently reliable across tenants.
// - We fetch /course/enrolments?contactID=<id>&limit=100 once, then filter TYPE === 'p' (program/qualification).
// - Expected Completion Date (individual) is not exposed by /course/enrolments; aXcelerate docs show only
//   ENROLMENTDATE/STARTDATE/FINISHDATE at the instance level. If aXcelerate exposes DateCompletionExpected
//   for GET elsewhere, we can add that endpoint later; for now we leave expectedCompletionDate: null.

const ALLOWED_ORIGINS = ['*']; // Loosen for now; tighten later if ThriveDesk needs it

const requiredEnv = ['AXC_BASE_URL', 'AXC_API_TOKEN', 'AXC_WS_TOKEN'];

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
};

function withCors(h) {
  return {
    ...h,
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

const badRequest = (msg, extra = {}) => ({
  statusCode: 400,
  headers: withCors(headers),
  body: JSON.stringify({ error: msg, ...extra }),
});

const serverError = (msg, extra = {}) => ({
  statusCode: 500,
  headers: withCors(headers),
  body: JSON.stringify({ error: msg, ...extra }),
});

const notFound = (msg, extra = {}) => ({
  statusCode: 404,
  headers: withCors(headers),
  body: JSON.stringify({ error: msg, ...extra }),
});

const ok = (data) => ({
  statusCode: 200,
  headers: withCors(headers),
  body: JSON.stringify(data),
});

function assertEnv() {
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

function apiHeaders() {
  return {
    apitoken: process.env.AXC_API_TOKEN,
    wstoken: process.env.AXC_WS_TOKEN,
  };
}

function isEmailEqual(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

function pickContactFields(c) {
  // Keep key identity + address/phones (no stripping)
  return {
    CONTACTID: c.CONTACTID,
    USERID: c.USERID ?? null,
    GIVENNAME: c.GIVENNAME ?? null,
    SURNAME: c.SURNAME ?? null,
    EMAILADDRESS: c.EMAILADDRESS ?? null,
    EMAILADDRESSALTERNATIVE: c.EMAILADDRESSALTERNATIVE ?? null,
    CUSTOMFIELD_PERSONALEMAIL: c.CUSTOMFIELD_PERSONALEMAIL ?? null,
    PHONE: c.PHONE ?? null,
    WORKPHONE: c.WORKPHONE ?? null,
    MOBILEPHONE: c.MOBILEPHONE ?? null,
    ADDRESS1: c.ADDRESS1 ?? null,
    ADDRESS2: c.ADDRESS2 ?? null,
    CITY: c.CITY ?? null,
    STATE: c.STATE ?? null,
    POSTCODE: c.POSTCODE ?? null,
    COUNTRY: c.COUNTRY ?? c.SCOUNTRY ?? null,
    // Keep a couple of useful flags/dates:
    CONTACTACTIVE: c.CONTACTACTIVE ?? null,
    CONTACTENTRYDATE: c.CONTACTENTRYDATE ?? null,
    LASTUPDATED: c.LASTUPDATED ?? null,
  };
}

function dedupeByEnrolId(items) {
  const seen = new Map();
  for (const it of items) {
    const key = String(it.ENROLID ?? `${it.CODE || 'UNK'}:${it.INSTANCEID || 'UNK'}`);
    if (!seen.has(key)) seen.set(key, it);
  }
  return Array.from(seen.values());
}

function toProgramSummary(e) {
  return {
    ENROLID: e.ENROLID ?? null,
    INSTANCEID: e.INSTANCEID ?? null,
    CODE: e.CODE ?? null,
    NAME: e.NAME ?? null,
    STATUS: e.STATUS ?? null,
    ENROLMENTDATE: e.ENROLMENTDATE ?? null,
    STARTDATE: e.STARTDATE ?? null,
    FINISHDATE: e.FINISHDATE ?? null, // graduation/withdrawal; blank until completion
    AMOUNTPAID: e.AMOUNTPAID ?? null,
    expectedCompletionDate: null, // Not exposed by /course/enrolments (see file comments)
  };
}

function isCurrentStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  // Exclude clearly "not current"
  const notCurrent = ['withdrawn', 'cancelled', 'deleted', 'completed', 'finished'];
  if (notCurrent.includes(s)) return false;
  // Treat everything else as current (e.g., "In Progress", "Active", "Commenced", "Tentative", etc.)
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: withCors({}),
      body: '',
    };
  }

  try {
    assertEnv();
  } catch (err) {
    return serverError(err.message);
  }

  const { email, debug } = event.queryStringParameters || {};
  if (!email) {
    return badRequest('Query param "email" is required, e.g. ?email=someone%40example.com');
  }

  const base = process.env.AXC_BASE_URL.replace(/\/+$/, '');
  const tried = [];
  const usedUrls = [];

  async function axc(pathWithQuery) {
    const url = `${base}${pathWithQuery}`;
    tried.push({ type: 'GET', url });
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`aXcelerate error ${res.status} for ${url} :: ${text.slice(0, 200)}`);
    }
    usedUrls.push(url);
    return res.json();
  }

  try {
    // 1) Robust contact lookup
    const searchUrl = `/api/contacts/search?search=${encodeURIComponent(email)}&displayLength=100`;
    const contacts = await axc(searchUrl);

    // Find best exact match across likely fields
    let contact =
      contacts.find((c) => isEmailEqual(c.EMAILADDRESS, email)) ||
      contacts.find((c) => isEmailEqual(c.EMAILADDRESSALTERNATIVE, email)) ||
      contacts.find((c) => isEmailEqual(c.CUSTOMFIELD_PERSONALEMAIL, email)) ||
      contacts[0];

    if (!contact) {
      return notFound(`No contact matched email: ${email}`, debug ? { _debug: { tried, usedUrls } } : undefined);
    }

    const contactOut = pickContactFields(contact);

    // 2) Single call to enrolments, then filter to TYPE === 'p' (program/qualification)
    const enrolUrl = `/api/course/enrolments?contactID=${encodeURIComponent(
      String(contact.CONTACTID)
    )}&limit=100`;
    const enrolments = await axc(enrolUrl);

    // Some tenants return an array of mixed enrolments (workshops 'w' + programs 'p')
    const programEnrols = Array.isArray(enrolments)
      ? enrolments.filter((e) => (e.TYPE || e.type) === 'p')
      : [];

    // Dedupe (some tenants echo dupes)
    const deduped = dedupeByEnrolId(programEnrols).map(toProgramSummary);

    const currentQualifications = deduped.filter((e) => isCurrentStatus(e.STATUS));

    // 3) Direct link to the contact in aXcelerate console
    // Use tenant domain from AXC_BASE_URL
    const portalBase = base.replace(/\/api\/?$/, '');
    const axcelerateContactUrl = `${portalBase}/management/management2/Contact_View.cfm?ContactID=${encodeURIComponent(
      String(contact.CONTACTID)
    )}`;

    const payload = {
      contact: contactOut,
      currentQualifications,
      axcelerateContactUrl,
    };

    if (debug) payload._debug = { tried, usedUrls };

    return ok(payload);
  } catch (err) {
    return serverError('Failed to fetch data from aXcelerate', {
      details: err.message,
      ...(debug ? { _debug: { tried, usedUrls } } : {}),
    });
  }
};
