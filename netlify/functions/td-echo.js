// netlify/functions/td-echo.js
const crypto = require("crypto");

const b64 = (algo, key, msg) =>
  crypto.createHmac(algo, key).update(msg).digest("base64");
const hex = (algo, key, msg) =>
  crypto.createHmac(algo, key).update(msg).digest("hex");

exports.handler = async (event) => {
  const secret = process.env.TD_WEBHOOK_SECRET || "";
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const sigHdr = headers["x-td-signature"] || "";

  // Raw body and parsed body
  const raw = event.body || "";
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}

  // Pull the `data` object and also keep the raw substring if possible
  const dataObj = parsed?.data;
  // naive raw extractor (works because TD sends "data":{...})
  const m = raw.match(/"data"\s*:\s*(\{[\s\S]*\})\s*}$/);
  const dataRaw = m ? m[1] : null;

  const candidates = [];
  if (dataObj) candidates.push(["sha1 base64 JSON.stringify(dataObj)",
    b64("sha1", secret, JSON.stringify(dataObj))]);
  if (dataRaw) candidates.push(["sha1 base64 raw data substring",
    b64("sha1", secret, dataRaw)]);
  if (parsed) candidates.push(["sha1 base64 JSON.stringify(full body)",
    b64("sha1", secret, JSON.stringify(parsed))]);
  candidates.push(["sha1 base64 raw full body", b64("sha1", secret, raw)]);
  // a couple of “just in case” variants people try
  if (dataObj) candidates.push(["sha256 base64 JSON.stringify(dataObj)",
    b64("sha256", secret, JSON.stringify(dataObj))]);
  if (dataObj) candidates.push(["sha1 hex JSON.stringify(dataObj)",
    hex("sha1", secret, JSON.stringify(dataObj))]);

  const match = candidates.find(([, v]) => v === sigHdr)?.[0] || null;

  console.log("[td-echo]", {
    sigHeaderPresent: !!sigHdr,
    match,
    headerKeys: Object.keys(event.headers || {})
  });

  return {
    statusCode: 200,
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      ok: true,
      sigHeader: sigHdr,
      match,
      tested: candidates.map(([name, value]) => ({ name, value })),
      hasData: !!dataObj,
      usedRawDataSubstring: !!dataRaw
    })
  };
};
