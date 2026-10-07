// Offline fixture preparation only. The maintained mock owns HTTP and SSE.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const cases = {
  family: [1195, "👨‍👩‍👧‍👦"],
  accent: [1199, "e\u0301"],
  flag: [1198, "🇨🇦"],
  "accent-fit": [1195, "e\u0301"],
  "flag-fit": [1195, "🇨🇦"],
  ascii: [1195, "ABCD"],
  "family-short": [100, "👨‍👩‍👧‍👦"],
};
const [caseName, runLabel, destination, widthArg = "1"] = process.argv.slice(2);
assert(Object.hasOwn(cases, caseName ?? ""), "unknown case");
assert(/^[A-Z0-9]{8,32}$/.test(runLabel ?? ""), "use a fresh public ASCII run label");
assert(destination, "supply a new fixture directory");
assert(widthArg === "1" || widthArg === "17", "delta width must be 1 or 17 code points");
const width = Number(widthArg);
const [prefixUnits, focus] = cases[caseName];
const marker = `OPENCLAWE2EGRAPHEME${caseName.toUpperCase().replaceAll("-", "")}${runLabel}`;
assert(marker.length < prefixUnits);
const prefix = marker + "x".repeat(prefixUnits - marker.length);
const text = prefix + focus + "done";
const points = Array.from(text);
const deltas = [];
for (let i = 0; i < points.length; i += width) {
  deltas.push(points.slice(i, i + width).join(""));
}
assert.equal(deltas.join(""), text);
const item = {
  type: "message",
  id: "msg_grapheme_fixture",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
};
const events = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, content: [], status: "in_progress" },
  },
  ...deltas.map((delta) => ({
    type: "response.output_text.delta",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta,
  })),
  {
    type: "response.output_text.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text,
  },
  { type: "response.output_item.done", output_index: 0, item },
  {
    type: "response.completed",
    response: {
      id: "resp_grapheme_fixture",
      status: "completed",
      output: [item],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    },
  },
];
const folder = resolve(destination);
mkdirSync(folder, { recursive: false, mode: 0o700 });
const save = (name, value) =>
  writeFileSync(join(folder, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
save("control.json", { models: { "gpt-5.5": { events } } });
save("scenario.json", {
  actions: [
    {
      type: "send",
      atMs: 0,
      text: `Run the controlled grapheme proof ${marker}. Do not use tools.`,
    },
  ],
});
save("expected.json", {
  candidate: "0216d75b6508a9db7dcd08ade81dd8f80482bd2a",
  caseName,
  marker,
  text,
  focus,
  prefixUtf16Units: prefixUnits,
  focusUtf16Units: focus.length,
  textUtf16Units: text.length,
  deltaCodePointWidth: width,
  deltaCount: deltas.length,
  focusCrosses1200: prefixUnits < 1200 && prefixUnits + focus.length > 1200,
});
console.log(
  JSON.stringify({ caseName, marker, textUtf16Units: text.length, deltaCount: deltas.length }),
);
