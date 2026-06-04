/**
 * ClearDrive — Used Stock Matcher (server)
 * --------------------------------------------------
 * Zero dependencies. Runs on plain Node 18+ (uses global fetch).
 *   node server.js           # listens on PORT (default 3000)
 *
 * Point your Vapi "Check_Used_Stock" tool's Server URL at:
 *   https://<your-host>/check-stock
 *
 * Vapi POSTs the tool call as JSON; we reply with:
 *   {"results":[{"toolCallId":"...","result":"<spoken string>"}]}
 */
const http = require("http");
const { handleToolCall } = require("./matcher");

const PORT = process.env.PORT || 3000;
// Optional shared secret: set VAPI_SECRET here AND as a custom header on the
// Vapi tool (e.g. x-vapi-secret). Leave unset to skip the check.
const VAPI_SECRET = process.env.VAPI_SECRET || null;

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method !== "POST" || !req.url.startsWith("/check-stock")) {
    return send(res, 404, { error: "Not found" });
  }
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
    return send(res, 401, { error: "Unauthorized" });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy(); // basic guard
  });
  req.on("end", async () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
 const { args } = require("./matcher").extractToolCall(body);
    console.log("[check-stock] criteria received:", JSON.stringify(args));
    const out = await handleToolCall(body);
    if (out.error) console.error("[check-stock] soft error:", out.error);
    console.log(
      "[check-stock] matched:",
      out.match ? out.match.stockNumber : "(none)"
    );
    // Always 200 with the envelope so the agent always has something to say.
    send(res, 200, out.response);
  });
});

server.listen(PORT, () => {
  console.log(`ClearDrive stock matcher listening on :${PORT}`);
  console.log(`  POST /check-stock   (point the Vapi tool here)`);
  console.log(`  GET  /health`);
});

/*
 * ---- Deploying elsewhere ----
 * EXPRESS:
 *   const express = require("express");
 *   const { handleToolCall } = require("./matcher");
 *   const app = express(); app.use(express.json());
 *   app.post("/check-stock", async (req, res) => {
 *     const out = await handleToolCall(req.body);
 *     res.json(out.response);
 *   });
 *   app.listen(3000);
 *
 * VERCEL  (api/check-stock.js):
 *   const { handleToolCall } = require("../matcher");
 *   module.exports = async (req, res) => {
 *     const out = await handleToolCall(req.body);
 *     res.status(200).json(out.response);
 *   };
 *
 * AWS LAMBDA:
 *   const { handleToolCall } = require("./matcher");
 *   exports.handler = async (event) => {
 *     const body = JSON.parse(event.body || "{}");
 *     const out = await handleToolCall(body);
 *     return { statusCode: 200, headers: {"Content-Type":"application/json"},
 *              body: JSON.stringify(out.response) };
 *   };
 */
