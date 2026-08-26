import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FONT_FAMILY, registerCzechFont } from "../lib/pdf/czechFont.ts";

// =========================================================================================
// Visualization v2 (report section 16): the presentation PDF must reuse the EXACT SAME embedded
// Noto Sans Czech font Graphics Production Package v1 already added — never a second embed.
// =========================================================================================

test("SHARED FONT: both PDF modules import registerCzechFont/FONT_FAMILY from lib/pdf/czechFont.ts, never defining their own", () => {
  const graphicsSource = readFileSync(new URL("../lib/graphicsProductionPdf.ts", import.meta.url), "utf8");
  const presentationSource = readFileSync(new URL("../lib/presentationPdf.ts", import.meta.url), "utf8");
  assert.match(graphicsSource, /from "\.\/pdf\/czechFont\.ts"/u);
  assert.match(presentationSource, /from "\.\/pdf\/czechFont\.ts"/u);
  assert.doesNotMatch(graphicsSource, /addFileToVFS/u, "font registration must live only in lib/pdf/czechFont.ts, not be re-implemented here");
  assert.doesNotMatch(presentationSource, /addFileToVFS/u, "font registration must live only in lib/pdf/czechFont.ts, not be re-implemented here");
});

test("SHARED FONT: no second font asset file exists — only lib/fonts/graphicsProductionFont.ts is imported for base64 font data", () => {
  const czechFontSource = readFileSync(new URL("../lib/pdf/czechFont.ts", import.meta.url), "utf8");
  assert.match(czechFontSource, /from "\.\.\/fonts\/graphicsProductionFont\.ts"/u);
});

test("registerCzechFont registers both Regular and Bold weights under the same FONT_FAMILY", () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const fakeDoc = {
    addFileToVFS: (...args: unknown[]) => calls.push({ method: "addFileToVFS", args }),
    addFont: (...args: unknown[]) => calls.push({ method: "addFont", args }),
  } as never;
  registerCzechFont(fakeDoc);
  const addFontCalls = calls.filter((call) => call.method === "addFont");
  assert.equal(addFontCalls.length, 2);
  assert.ok(addFontCalls.every((call) => call.args[1] === FONT_FAMILY));
  assert.deepEqual(addFontCalls.map((call) => call.args[2]).sort(), ["bold", "normal"]);
});
