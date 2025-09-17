// netlify/functions/td-echo.js
const crypto = require("crypto");

exports.handler = async (event) => {
  const headersLower = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const signature = headersLower["x-td-signature"] || null;
  let parsed = null;
  try { parsed = JSON.parse(event.body || "{}"); } catch {}
  const data = parsed && parsed.data;
  let sigOk = null;

  if (signature && process.env.TD_WEBHOOK_SECRET && data) {
    const calc = crypto.createHmac("sha1", process.env.TD_WEBHOOK_SECRET)
      .update(JSON.stringify(data)) // ThriveDesk signs ONLY `data`
      .digest("base64");
    sigOk = (signature === calc);
  }

  console.log("[td-echo]", {
    method: event.httpMethod,
    hasBody: !!event.body,
    sigHeaderPresent: !!signature,
    sigOk,
    headerKeys: Object.keys(event.headers || {})
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      received: true,
      method: event.httpMethod,
      headerKeys: Object.keys(event.headers || {}),
      signature,
      sigOk,
      query: event.queryStringParameters || {},
      body: parsed
    })
  };
};
