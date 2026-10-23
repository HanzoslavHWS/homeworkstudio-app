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

// V1-DATA-07 / 07-B1: the bar shows the shared project pricing (domain/projectPricing.ts). A typovka
// booth without a price is "K nacenění" (no longer hidden behind "FIXNÍ TYPOVKA" or a 0).

test("PRICING FOOTER: individuální projekt bez stánku = „DLE KOMPONENT“; chybějící cena stánku = „K nacenění“, nikdy „FIXNÍ TYPOVKA“ ani 0", () => {
  assert.match(pricingBarSource, /projectType === "individualni" \? "DLE KOMPONENT" : "—"/u);
  assert.match(pricingBarSource, /booth\.status === "missing"\s*\?\s*"K nacenění"/u);
  assert.doesNotMatch(pricingBarSource, /FIXNÍ TYPOVKA/u);
  assert.doesNotMatch(pricingBarSource, /salePrice \?\? 0/u, "žádná tichá nula");
});

test("PRICING FOOTER: BoothGenerator.tsx předává liště sdílený výsledek výpočtu a skutečný typ projektu", () => {
  assert.match(boothGeneratorSource, /<PricingBar pricing=\{projectPricingResult\} projectType=\{type\} \/>/u);
  assert.match(boothGeneratorSource, /const projectPricingResult = useMemo\(\(\) => priceProjectLegacy\(/u);
});

test("TYPOVKA REGRESSION: stánek s cenou ukazuje skutečnou částku z výsledku výpočtu", () => {
  assert.match(pricingBarSource, /`\$\{money\(booth\.totalNet \?\? 0, currency\)\} bez DPH`/u);
});

// V1-DATA-07 / 07-B1: an incomplete calculation is always marked as a subtotal of priced items,
// never as a final price; the customer PDF print asks for a confirmation but is never blocked.
const workflowSource = readFileSync(new URL("../components/workflow/WorkflowSteps.tsx", import.meta.url), "utf8");

test("NEÚPLNÁ KALKULACE: lišta ukáže „MEZISOUČET — NEÚPLNÉ“ místo „CELKEM“, když jsou položky k nacenění", () => {
  assert.match(pricingBarSource, /pricing\.missingCount \? "MEZISOUČET — NEÚPLNÉ" : "CELKEM"/u);
});

test("NEÚPLNÁ KALKULACE: dokument (náhled = PDF) má označení a mezisoučet; tisk se jen potvrdí, nezablokuje", () => {
  assert.match(workflowSource, /NEÚPLNÁ KALKULACE — obsahuje položky k nacenění/u);
  assert.match(workflowSource, /calculation\.missingCount > 0 \? "Mezisoučet oceněných položek bez DPH" : "Celkem bez DPH"/u);
  assert.match(workflowSource, /calculation\.missingCount > 0 \? "Mezisoučet s DPH" : "Celkem s DPH"/u);
  assert.match(workflowSource, /if \(calculation\.missingCount > 0 && !window\.confirm\([\s\S]{0,400}\)\) return; printDocument\("customer-calculation"\);/u, "potvrzení jen při položkách k nacenění, jinak tisk hned");
});

test("NEÚPLNÁ KALKULACE: souhrn i textový souhrn (ZIP, e-mail) mluví o mezisoučtu, ne o konečné ceně", () => {
  assert.match(workflowSource, /pricing\.missingCount \? "Mezisoučet bez DPH" : "Cena bez DPH"/u);
  assert.match(workflowSource, /"Mezisoučet oceněných položek bez DPH"/u);
  assert.match(workflowSource, /nejde o konečnou cenu/u);
});
