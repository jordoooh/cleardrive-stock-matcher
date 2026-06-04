/**
 * Offline proof. Runs the matcher against the real FMG stock fixture
 * (no network needed) and checks the cases that matter.
 *   node test.js
 */
const fs = require("fs");
const path = require("path");
const m = require("./matcher");

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "stock-fixture.json"), "utf8")
);
const stock = fixture.result.serverData.stockData;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
    failed++;
  }
}

async function run(label, body) {
  const out = await m.handleToolCall(body, { stock });
  console.log(`\n--- ${label} ---`);
  console.log("toolCallId:", out.response.results[0].toolCallId);
  console.log("matched:", out.match ? out.match.stockNumber : "(none)");
  console.log("spoken:", out.response.results[0].result);
  return out;
}

(async () => {
  // TEST 1 — exact customer request: Pajero Sport, 2019+, under 120k, maroon.
  // Sent in the CURRENT Vapi shape (toolCallList, arguments as object).
  const pajero = await run("TEST 1: Pajero Sport / 2019+ / <120k / maroon", {
    message: {
      toolCallList: [
        {
          id: "call_pajero_1",
          type: "function",
          function: {
            name: "Check_Used_Stock",
            arguments: {
              vehicle: "Mitsubishi Pajero Sport",
              build_year: "2019",
              kms: "120000",
              colour: "maroon",
            },
          },
        },
      ],
    },
  });
  check("envelope has results[0].toolCallId", !!pajero.response.results[0].toolCallId);
  check("toolCallId echoed correctly", pajero.response.results[0].toolCallId === "call_pajero_1");
  check("a vehicle matched", !!pajero.match);
  check(
    "picked the MAROON Pajero (U02655) not the white one (U02718)",
    pajero.match && pajero.match.stockNumber === "U02655",
    pajero.match ? "got " + pajero.match.stockNumber : "no match"
  );
  check(
    "spoken line contains real details (2019 / Maroon / 112,500 / 32,480 / U02655)",
    /2019/.test(pajero.response.results[0].result) &&
      /Maroon/.test(pajero.response.results[0].result) &&
      /112,500/.test(pajero.response.results[0].result) &&
      /32,480/.test(pajero.response.results[0].result) &&
      /U02655/.test(pajero.response.results[0].result)
  );
  check("offers Bodie transfer", /Bodie/.test(pajero.response.results[0].result));

  // TEST 2 — Ferrari, not in stock. Sent in the OLDER shape (toolCalls,
  // arguments as a JSON STRING) to prove both shapes are handled.
  const ferrari = await run("TEST 2: Ferrari (not in stock), legacy payload shape", {
    message: {
      toolCalls: [
        {
          id: "call_ferrari_1",
          function: {
            name: "Check_Used_Stock",
            arguments: JSON.stringify({ vehicle: "Ferrari", build_year: "2016" }),
          },
        },
      ],
    },
  });
  check("toolCallId echoed from legacy shape", ferrari.response.results[0].toolCallId === "call_ferrari_1");
  check("no vehicle matched", !ferrari.match);
  check(
    "spoken line is the no-match / take-details message",
    /don't have an exact match/.test(ferrari.response.results[0].result)
  );

  // TEST 3 — model-only phrasing ("pajero sport" lowercase, no make, no colour).
  const modelOnly = await run("TEST 3: 'pajero sport' only, 2020+, no colour", {
    message: {
      toolCallList: [
        {
          id: "call_3",
          function: {
            name: "Check_Used_Stock",
            arguments: { vehicle: "pajero sport", build_year: "2020" },
          },
        },
      ],
    },
  });
  check(
    "2020+ with no colour pref returns a 2020 Pajero (U02718)",
    modelOnly.match && modelOnly.match.stockNumber === "U02718",
    modelOnly.match ? "got " + modelOnly.match.stockNumber : "no match"
  );

  // TEST 4 — km filter excludes: ask under 60k, both Pajeros are over -> no match.
  const tightKm = await run("TEST 4: Pajero Sport but under 60,000 km", {
    message: {
      toolCallList: [
        {
          id: "call_4",
          function: {
            name: "Check_Used_Stock",
            arguments: { vehicle: "Pajero Sport", kms: "60000" },
          },
        },
      ],
    },
  });
  check("km cap correctly excludes both Pajeros", !tightKm.match);

  console.log(`\n========================\n${passed} passed, ${failed} failed\n========================`);
  process.exit(failed === 0 ? 0 : 1);
})();
