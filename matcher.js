/**
 * ClearDrive — Used Stock Matcher (core logic)
 * --------------------------------------------------
 * Pure, framework-agnostic functions. No server, no secrets.
 * Used by server.js (production) and test.js (offline proof).
 *
 * Flow: Vapi posts a tool-call -> we read the customer's criteria ->
 * fetch the live FMG stock JSON -> match -> return the Vapi
 * {"results":[{"toolCallId","result"}]} envelope with a spoken sentence.
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

// ---------- read the Vapi tool-call ----------

/**
 * Vapi has sent the tool call under message.toolCallList in current builds
 * and message.toolCalls in older ones. We read whichever is present so the
 * toolCalls-vs-toolCallList ambiguity can never break this again.
 * Returns { toolCallId, args } where args is the customer's criteria object.
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
  // Arguments sometimes arrive as a JSON string rather than an object.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { toolCallId, args: args || {} };
}

// ---------- matching ----------

/**
 * Decide if a stock vehicle satisfies the customer's hard criteria.
 *  - make/model: every word the customer said must appear in "make model series variations"
 *  - year: vehicle year >= requested build_year (when given)
 *  - kms:  vehicle odometer <= requested kms (when given)
 * Colour is NOT a hard filter — it is used for ranking (see scoreVehicle).
 */
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

/**
 * Rank survivors so the BEST match surfaces first. Higher score = better.
 *  +100  colour matches what the customer asked for (e.g. "maroon")
 *   +1   newer year (mild tie-breaker)
 * Lowest odometer breaks remaining ties (handled in the sort).
 */
function scoreVehicle(vehicle, criteria) {
  let score = 0;
  const wantColour = norm(criteria.colour);
  if (wantColour && norm(vehicle.colour).includes(wantColour)) score += 100;
  const vYear = toNumber(vehicle.year) || 0;
  score += vYear * 0.001; // tiny nudge toward newer
  return score;
}

/** Returns the best matching vehicle, or null. */
function findBestMatch(stock, criteria) {
  const survivors = stock.filter((v) => passesHardFilter(v, criteria));
  if (survivors.length === 0) return null;
  survivors.sort((a, b) => {
    const s = scoreVehicle(b, criteria) - scoreVehicle(a, criteria);
    if (s !== 0) return s;
    // tie-break: lower odometer first
    return (toNumber(a.odometer) || 0) - (toNumber(b.odometer) || 0);
  });
  return survivors[0];
}

// ---------- response building ----------

/** The natural sentence the voice agent will speak for a match. */
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
  parts.push(
    `, stock number ${v.stockNumber}. I'd love to connect you with Bodie, our used vehicle specialist, so you don't have to repeat yourself. Would you like me to put you through?`
  );
  return parts.join("");
}

const NO_MATCH_SENTENCE =
  "I don't have an exact match in stock right now, but I'd be happy to take your details and let you know the moment something suitable comes in. What's the best number to reach you on?";

/** Wrap a spoken string in the exact envelope Vapi requires. */
function buildVapiResponse(toolCallId, resultString) {
  return { results: [{ toolCallId: toolCallId, result: resultString }] };
}

// ---------- live fetch ----------

/** Fetch + parse the live stock array. Node 18+ has global fetch. */
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
 * Takes the raw Vapi request body, returns the Vapi response object.
 * Always returns a 200-able envelope, even on internal error, so the
 * agent always has something to say.
 */
async function handleToolCall(body, opts = {}) {
  const { toolCallId, args } = extractToolCall(body);
  try {
    const stock = opts.stock || (await fetchStock(opts.url));
    const match = findBestMatch(stock, args);
    const sentence = match ? buildMatchSentence(match) : NO_MATCH_SENTENCE;
    return {
      response: buildVapiResponse(toolCallId, sentence),
      match, // handy for logging/tests; ignored by Vapi
    };
  } catch (err) {
    // Fail soft: never leave the agent silent.
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
  extractToolCall,
  passesHardFilter,
  findBestMatch,
  buildMatchSentence,
  buildVapiResponse,
  fetchStock,
  handleToolCall,
  NO_MATCH_SENTENCE,
};
