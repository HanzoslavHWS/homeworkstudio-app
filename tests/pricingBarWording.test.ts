import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pricingBarSource = readFileSync(new URL("../components/configurator/PricingBar.tsx", import.meta.url), "utf8");
const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");

// =========================================================================================
// Turn 5 LIVE QA section 45: an Individual booth has no single fixed booth-level price — showing
// "FIXNÍ TYPOVKA" (a typovka-only concept) for it was a semantic bug. Only the WORDING changes
// here; no Individual pricing engine is implemented in this session (explicitly out of scope).
// =========================================================================================

test("PRICING FOOTER: PricingBar picks a project-type-aware label when the booth has no fixed price — 'DLE KOMPONENT' for Individual, 'FIXNÍ TYPOVKA' unchanged for typovka", () => {
  assert.match(pricingBarSource, /projectType === "individualni" \? "DLE KOMPONENT" : "FIXNÍ TYPOVKA"/u);
  assert.doesNotMatch(pricingBarSource, /: "FIXNÍ TYPOVKA"\s*\}<\/strong>/u, "the raw literal fallback must be routed through unpricedLabel, never inlined directly again");
});

test("PRICING FOOTER: BoothGenerator.tsx passes the real project type into PricingBar (never hardcoded/omitted)", () => {
  assert.match(boothGeneratorSource, /<PricingBar booth=\{selectedBooth\} placedItems=\{placedComponents\} currency=\{currency\} projectType=\{type\} \/>/u);
});

test("TYPOVKA REGRESSION: a typovka booth WITH a real fixed pricingEntries salePrice still shows the actual price, never the fallback label at all — this session never touches the priced branch", () => {
  assert.match(pricingBarSource, /const boothNet = getBasePricingEntry\(booth\?\.pricingEntries, currency\)\?\.salePrice \?\? 0;/u);
  assert.match(pricingBarSource, /\{boothNet \? `\$\{boothNet\.toLocaleString\("cs-CZ"\)\} \$\{currency\} bez DPH` : unpricedLabel\}/u);
});
