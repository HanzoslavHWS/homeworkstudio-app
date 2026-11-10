import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

// SHAD-01 — shadcn/ui alongside the legacy stylesheet. These guard the coexistence rules that keep
// the unconverted modules (generator, rasters, print surfaces…) exactly as they were.

const appCss = readFileSync("app/app.css", "utf8");
const legacyCss = readFileSync("app/globals.css", "utf8");

test("stylesheet entry: legacy CSS lives in its own layer before the utilities; no global Tailwind preflight", () => {
  assert.match(readFileSync("app/layout.tsx", "utf8"), /import "\.\/app\.css";/u);
  assert.match(appCss, /@layer theme, base, legacy, components, utilities;/u);
  assert.match(appCss, /@import "\.\/globals\.css" layer\(legacy\);/u);
  assert.match(appCss, /@import "tailwindcss\/utilities\.css" layer\(utilities\)/u);
  assert.doesNotMatch(appCss, /@import "tailwindcss";|@import "tailwindcss\/preflight/u, "preflight would reset buttons, inputs and tables of unconverted modules");
  // the theme does not reuse the legacy variable names (--muted is a text colour there)
  assert.doesNotMatch(appCss, /^\s+--(muted|border|background|foreground):/mu);
});

test("legacy state classes are never generated as utilities (a hidden CAD layer must stay listed)", () => {
  assert.match(appCss, /@source not inline\("hidden visible invisible collapse"\);/u);
  assert.match(readFileSync("components/configurator/BoothCadPlanView.tsx", "utf8"), /!visible \? "hidden" : ""/u, "the legacy class this protects");
});

test("legacy bare form-element rules skip the new UI region and shadcn components, with unchanged specificity", () => {
  const scope = ":where(:not([data-ui] *, [data-slot], [data-slot] *))";
  for (const selector of ["label", "input", "select"]) assert.ok(legacyCss.includes(`${selector}${scope}`), selector);
  assert.doesNotMatch(legacyCss, /^label \{/mu);
  assert.doesNotMatch(legacyCss, /^input,\nselect \{\n  width: 100%;\n  height: 50px;/mu);
});

test("the administration frame is the shadcn/ui region; shared blocks come from components/ui", () => {
  assert.match(readFileSync("components/workflow/AdminShell.tsx", "utf8"), /data-ui="admin"/u);
  for (const file of ["button", "input", "native-select", "checkbox", "table", "dialog", "alert-dialog", "badge", "workspace"]) assert.ok(existsSync(`components/ui/${file}.tsx`), file);
  const components = JSON.parse(readFileSync("components.json", "utf8"));
  assert.equal(components.style, "radix-nova");
  assert.equal(components.tailwind.css, "app/app.css");
});

test("catalog bulk actions confirm in a dialog; active items are archived only when explicitly included", () => {
  const page = readFileSync("components/workflow/ComponentAdminPage.tsx", "utf8");
  assert.doesNotMatch(page, /window\.confirm/u);
  assert.match(page, /<ConfirmDialog/u);
  assert.match(page, /runBulk\("archive", choice === "include-active"\)/u);
  assert.match(page, /Archivovat, aktivní přeskočit/u);
});

test("Vzorníky: the preview shows the stored photo, else the set colour, else „Bez náhledu“ — never the picker's default grey", () => {
  const panel = readFileSync("components/workflow/CatalogKitPanels.tsx", "utf8");
  assert.doesNotMatch(panel, /\|\| "#cccccc"/u);
  assert.match(panel, /stored: \{ photoAsset: variant\.photoAsset, imageSource: variant\.imageSource, series: variant\.series \}/u);
  assert.match(panel, /useAssetUrl\(variant\.stored\?\.photoAsset/u);
  assert.match(panel, /Bez náhledu/u);
  assert.match(panel, /Nastavit barvu/u);
  // the save never sends the display-only fields, so stored photos stay untouched
  const draftToInput = panel.slice(panel.indexOf("function draftToInput"), panel.indexOf("const LEGACY_CARPET_FINISHES"));
  assert.doesNotMatch(draftToInput, /photoAsset|imageSource|stored/u);
});
