/**
 * ClearDrive — Used Stock Matcher (core logic)
 * --------------------------------------------------
 * Pure, framework-agnostic functions plus an optional SMS step.
 * Used by server.js (production) and test.js (offline proof).
 *
 * Flow: Vapi posts a tool-call -> read the customer's criteria ->
 * fetch the live FMG stock JSON -> match -> (if matched) text the
 * salesperson the lead details -> return the Vapi
 * {"results":[{"toolCallId","result"}]} envelope with a spoken sentence.
 *
 * SECRETS: Twilio credentials are read from environment variables only.
 * Never hard-code them. Set them in Render -> Environment.
 */

const STOCK_URL =
  "https://www.fmgauto.com.au/page-data/our-stock/used-cars-for-sale-in-victor-harbor/page-data.json";

// ---------- small helpers ----------

/** Lowercase, trim, collapse internal whitespace. Safe on null/number. */
function norm(v) {
  if (v === null || v === undefined) return "";
  return String(v).toLowerCase().trim().replace(/\s+/g, " ");
}

/** Pull a clean integer out of "112,500 km", "$32,480", 32480, etc. */
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const digits = String(v).replace(/[^0-9.]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** "112500" -> "112,500" for natural speech. */
function groupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Turn "QE MY19 4X4 Dual Range" -> "qe-my19-4x4-dual-range" for URLs. */
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the live FMG detail-page URL for a vehicle.
 * Pattern (verified against real stock):
 *   /used-cars/for-sale/{make}/{model}/{year}/{variations}/{series}/{id}/
 */
function buildStockUrl(v) {
  if (!v) return "";
  const parts = [
    "used-cars",
    "for-sale",
    slugify(v.make),
    slugify(v.model),
    String(v.year || ""),
    slugify(v.variations),
    slugify(v.series),
    String(v.id || ""),
  ];
  return "https://www.fmgauto.com.au/" + parts.join("/") + "/";
}

// ---------- read the Vapi tool-call ----------

/**
 * Vapi sends the tool call under message.toolCallList (current builds) or
 * message.toolCalls (older). We read whichever is present.
 * Returns { toolCallId, args } where args holds the customer's criteria
 * AND lead details (name, phone, email, purchase_type, budget_*).
 */
function extractToolCall(body) {
  const message = (body && body.message) || {};
  const list =
    (Array.isArray(message.toolCallList) && message.toolCallList) ||
    (Array.isArray(message.toolCalls) && message.toolCalls) ||
    [];
  const call = list[0] || {};
  const toolCallId = call.id || call.toolCallId || null;

  let args = (call.function && call.function.arguments) || call.arguments || {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { toolCallId, args: args || {} };
}

/** Best-effort read of the caller's phone number from the call payload. */
function callerNumberFromBody(body) {
  try {
    return (body && body.message && body.message.call &&
      body.message.call.customer && body.message.call.customer.number) || "";
  } catch {
    return "";
  }
}

// ---------- matching ----------

function passesHardFilter(vehicle, criteria) {
  const haystack = norm(
    [vehicle.make, vehicle.model, vehicle.series, vehicle.variations].join(" ")
  );
  const wanted = norm(criteria.vehicle);
  if (wanted) {
    const words = wanted.split(" ").filter(Boolean);
    const allPresent = words.every((w) => haystack.includes(w));
    if (!allPresent) return false;
  }

  const wantYear = toNumber(criteria.build_year);
  if (wantYear !== null) {
    const vYear = toNumber(vehicle.year);
    if (vYear === null || vYear < wantYear) return false;
  }

  const wantKms = toNumber(criteria.kms);
  if (wantKms !== null) {
    const vKms = toNumber(vehicle.odometer);
    if (vKms !== null && vKms > wantKms) return false;
  }

  return true;
}

function scoreVehicle(vehicle, criteria) {
  let score = 0;
  const wantColour = norm(criteria.colour);
  if (wantColour && norm(vehicle.colour).includes(wantColour)) score += 100;
  const vYear = toNumber(vehicle.year) || 0;
  score += vYear * 0.001;
  return score;
}

function findBestMatch(stock, criteria) {
  const survivors = stock.filter((v) => passesHardFilter(v, criteria));
  if (survivors.length === 0) return null;
  survivors.sort((a, b) => {
    const s = scoreVehicle(b, criteria) - scoreVehicle(a, criteria);
    if (s !== 0) return s;
    return (toNumber(a.odometer) || 0) - (toNumber(b.odometer) || 0);
  });
  return survivors[0];
}

// ---------- response building ----------

function buildMatchSentence(v) {
  const year = toNumber(v.year);
  const km = toNumber(v.odometer);
  const price = toNumber(v.price != null ? v.price : v.egcPrice);
  const trim = v.variations ? ` ${v.variations}` : "";

  const parts = [];
  parts.push(`Great news. We have a ${year} ${v.make} ${v.model}${trim}`);
  if (v.colour) parts.push(` in ${v.colour}`);
  if (km !== null) parts.push(` with ${groupThousands(km)} kilometres on it`);
  if (price !== null)
    parts.push(`, priced at $${groupThousands(price)} plus on-road costs`);
  parts.push(`, stock number ${v.stockNumber}.`);
  return parts.join("");
}

const NO_MATCH_SENTENCE =
  "I don't have an exact match in stock right now, but I'd be happy to take your details and let you know the moment something suitable comes in. What's the best number to reach you on?";

function buildVapiResponse(toolCallId, resultString) {
  return { results: [{ toolCallId: toolCallId, result: resultString }] };
}

// ---------- salesperson SMS ----------

/** NA for any blank/missing value, otherwise the trimmed string. */
function naOr(v) {
  return v !== null && v !== undefined && String(v).trim() !== ""
    ? String(v).trim()
    : "NA";
}

/**
 * Build the SMS text the salesperson receives. Pure function (no network),
 * so it can be unit-tested. Combines matched-vehicle data + lead details.
 */
function buildSalespersonMessage(vehicle, args, body) {
  const phone =
    naOr(args.phone) !== "NA" ? naOr(args.phone) : naOr(callerNumberFromBody(body));
  const vehDesc = [vehicle.year, vehicle.make, vehicle.model, vehicle.variations]
    .filter(Boolean)
    .join(" ");
  return (
    "New ClearDrive lead:\n" +
    `Name: ${naOr(args.name)}\n` +
    `Phone Number: ${phone}\n` +
    `Email: ${naOr(args.email)}\n` +
    `Vehicle: ${naOr(vehDesc)}\n` +
    `Stock Number: ${naOr(vehicle.stockNumber)}\n` +
    `Stock Link: ${naOr(buildStockUrl(vehicle))}\n` +
    `Budget: ${naOr(args.budget_value)}\n` +
    `Cash or Finance Purchase: ${naOr(args.budget_type)}\n` +
    `Personal or Business Purchase: ${naOr(args.purchase_type)}`
  );
}

/**
 * Send the SMS via Twilio's REST API (no SDK needed).
 * Reads creds from env vars. Fails soft — never throws into the call flow.
 */
async function sendSalespersonSms(vehicle, args, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.SALESPERSON_SMS_NUMBER;

  if (!sid || !token || !from || !to) {
    console.log("[sms] skipped — Twilio env vars not all set");
    return { sent: false, reason: "missing-config" };
  }

  const text = buildSalespersonMessage(vehicle, args, body);
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: from, Body: text });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("[sms] Twilio error:", res.status, errText.slice(0, 300));
      return { sent: false, reason: `http-${res.status}` };
    }
    console.log("[sms] sent to salesperson:", to);
    return { sent: true };
  } catch (err) {
    console.error("[sms] send failed:", String(err && err.message ? err.message : err));
    return { sent: false, reason: "exception" };
  }
}

// ---------- live fetch ----------

async function fetchStock(url = STOCK_URL) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "ClearDrive-Matcher/1.0" },
  });
  if (!res.ok) throw new Error(`Stock fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const stock =
    data &&
    data.result &&
    data.result.serverData &&
    Array.isArray(data.result.serverData.stockData)
      ? data.result.serverData.stockData
      : [];
  return stock;
}

/**
 * End-to-end handler used by the server.
 * On a match, texts the salesperson, then returns the spoken envelope.
 */
async function handleToolCall(body, opts = {}) {
  const { toolCallId, args } = extractToolCall(body);
  try {
    const stock = opts.stock || (await fetchStock(opts.url));
    const match = findBestMatch(stock, args);

    let sms = null;
    if (match && !opts.skipSms) {
      sms = await sendSalespersonSms(match, args, body);
    }

    const sentence = match ? buildMatchSentence(match) : NO_MATCH_SENTENCE;
    return {
      response: buildVapiResponse(toolCallId, sentence),
      match,
      sms,
    };
  } catch (err) {
    const safe =
      "I'm having trouble checking our live stock this second. Let me take your details and have Bodie call you straight back.";
    return {
      response: buildVapiResponse(toolCallId, safe),
      match: null,
      error: String(err && err.message ? err.message : err),
    };
  }
}

module.exports = {
  STOCK_URL,
  norm,
  toNumber,
  slugify,
  buildStockUrl,
  extractToolCall,
  callerNumberFromBody,
  passesHardFilter,
  findBestMatch,
  buildMatchSentence,
  buildVapiResponse,
  buildSalespersonMessage,
  sendSalespersonSms,
  fetchStock,
  handleToolCall,
  NO_MATCH_SENTENCE,
};
