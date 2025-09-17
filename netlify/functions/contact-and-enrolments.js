// netlify/functions/contact-and-enrolments.js
// Returns:
// {
//   contact: <FULL AXCELERATE CONTACT OBJECT>,
//   contactSummary: { small, handy subset },
//   currentQualifications: [ { CODE, NAME, STATUS, ENROLMENTDATE, STARTDATE, FINISHDATE, ENROLID, INSTANCEID } ],
//   _debug?: { tried: [...], usedUrls: [...] } // when ?debug=1
// }

const AXC_BASE = process.env.AXC_BASE;          // e.g. https://vetnurse.app.axcelerate.com
const AXC_API_TOKEN = process.env.AXC_API_TOKEN;
const AXC_WS_TOKEN = process.env.AXC_WS_TOKEN;

const jsonHeaders = {
  "Content-Type": "application/json"
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const axHeaders = () => ({
  apitoken: AXC_API_TOKEN,
  wstoken: AXC_WS_TOKEN
});

const ok = (body) => ({
  statusCode: 200,
  headers: { ...jsonHeaders, ...corsHeaders, "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

const bad = (statusCode, message) => ({
  statusCode,
  headers: { ...jsonHeaders, ...corsHeaders },
  body: JSON.stringify({ error: message })
});

const buildURL = (base, path, params = {}) => {
  const u = new URL(path, base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  });
  return u.toString();
};

async function axGet(path, params, debug, usedUrls) {
  const url = buildURL(AXC_BASE, path, params);
  debug?.push({ type: "axGet", url });
  usedUrls?.push(url);

  const res = await fetch(url, { headers: axHeaders() });
  // Some aX endpoints return 200 with empty body or [] when not found.
  if (!res.ok) throw new Error(`aX GET ${path} failed: ${res.status}`);
  const text = await res.text();
  // Safely parse JSON or return blank
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Robust email match across primary/alt/custom fields
function pickExactEmail(candidates, email) {
  if (!Array.isArray(candidates)) return null;
  const lc = (s) => (s || "").toLowerCase();
  const e = lc(email);

  const exact = candidates.find(c =>
    [c.EMAILADDRESS, c.EMAILADDRESSALTERNATIVE, c.CUSTOMFIELD_PERSONALEMAIL]
      .some(v => lc(v) === e)
  );

  // If no exact, prefer the ONLY result, else null
  if (exact) return exact;
  if (candidates.length === 1) return candidates[0];
  return null;
}

// Dedupe helper by a stable key
function dedupe(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    const url = new URL(event.rawUrl || `https://dummy${event.rawQueryString ? "?" + event.rawQueryString : ""}`);
    const email = url.searchParams.get("email");
    const includeDebug = url.searchParams.get("debug") === "1";

    if (!AXC_BASE || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
      return bad(500, "Server not configured: missing aXcelerate credentials.");
    }
    if (!email) {
      return bad(400, "Missing required query param: email");
    }

    const _debugTried = [];
    const _debugUsed = [];

    // --- 1) Find contact (prefer exact match on emailAddress param) ---
    // Use /contacts/search with emailAddress for tighter matching (supports starts-with semantics),
    // then enforce exact match in code.
    _debugTried.push({
      type: "contactSearch",
      url: buildURL(AXC_BASE, "/api/contacts/search", { emailAddress: email, displayLength: 100 })
    });
    const searchResults = await axGet("/api/contacts/search", { emailAddress: email, displayLength: 100 }, _debugTried, _debugUsed);

    const contact = pickExactEmail(searchResults, email)
      // If that somehow failed, try the broader 'search' param as a fallback
      || await (async () => {
        _debugTried.push({
          type: "contactSearchFallback",
          url: buildURL(AXC_BASE, "/api/contacts/search", { search: email, displayLength: 100 })
        });
        const alt = await axGet("/api/contacts/search", { search: email, displayLength: 100 }, _debugTried, _debugUsed);
        return pickExactEmail(alt, email);
      })();

    if (!contact) {
      const body = { contact: null, currentQualifications: [] };
      if (includeDebug) body._debug = { tried: _debugTried, usedUrls: _debugUsed };
      return ok(body);
    }

    // --- 2) Program (qualification) enrolments for the contact ---
    // Use /course/enrolments with type=p to get accredited program enrolments.
    _debugTried.push({
      type: "programEnrolments",
      url: buildURL(AXC_BASE, "/api/course/enrolments", { contactID: contact.CONTACTID, type: "p", limit: 100 })
    });
    const enrolmentsRaw = await axGet("/api/course/enrolments", { contactID: contact.CONTACTID, type: "p", limit: 100 }, _debugTried, _debugUsed);

    const programRows = Array.isArray(enrolmentsRaw) ? enrolmentsRaw.filter(e => (e.TYPE || "").toLowerCase() === "p") : [];

    // Dedupe in case the endpoint returns duplicates (seen in some tenants)
    const programUnique = dedupe(
      programRows,
      (e) => String(e.ENROLID || "") || `${e.CODE || ""}|${e.INSTANCEID || ""}`
    );

    // Shape a small summary that’s easy to map in ThriveDesk,
    // while keeping the FULL contact object available.
    const currentQualifications = programUnique.map(e => ({
      CODE: e.CODE ?? null,
      NAME: e.NAME ?? null,
      STATUS: e.STATUS ?? null,
      ENROLMENTDATE: e.ENROLMENTDATE ?? null,
      STARTDATE: e.STARTDATE ?? null,
      FINISHDATE: e.FINISHDATE ?? null, // stays null until completion/withdrawal in aX
      ENROLID: e.ENROLID ?? e.LEARNERID ?? null,
      INSTANCEID: e.INSTANCEID ?? null
      // EXPECTED_COMPLETION: null // Not exposed by this list endpoint; see notes below.
    }));

    // Provide a concise contact summary (handy for quick mapping),
    // AND the full raw contact for all address/phone fields, etc.
    const contactSummary = {
      CONTACTID: contact.CONTACTID,
      GIVENNAME: contact.GIVENNAME,
      SURNAME: contact.SURNAME,
      EMAILADDRESS: contact.EMAILADDRESS,
      EMAILADDRESSALTERNATIVE: contact.EMAILADDRESSALTERNATIVE,
      MOBILEPHONE: contact.MOBILEPHONE,
      PHONE: contact.PHONE,
      WORKPHONE: contact.WORKPHONE,
      ADDRESS1: contact.ADDRESS1,
      ADDRESS2: contact.ADDRESS2,
      CITY: contact.CITY,
      STATE: contact.STATE,
      POSTCODE: contact.POSTCODE,
      COUNTRY: contact.COUNTRY
    };

    const payload = {
      // Full aX contact object so you can map ANY field in ThriveDesk now (addresses, phones, etc.)
      contact,
      // Small convenience subset (optional to use)
      contactSummary,
      currentQualifications
    };

    if (includeDebug) payload._debug = { tried: _debugTried, usedUrls: _debugUsed };

    return ok(payload);
  } catch (err) {
    return bad(500, `Server error: ${err.message || String(err)}`);
  }
};
