/**
 * DEV test project for the manual check of V1-DATA-07 / 07-B1 (shared project pricing).
 *
 *   npm run dev                                  (in another terminal)
 *   npm run seed:pricing-b1-project              [-- --base-url=http://localhost:3000] [-- --reset]
 *
 * Creates ONE reserved project "ZKUŠEBNÍ V1-DATA-07-B1" (id zkusebni-v1-data-07-b1) through the
 * app's own API, linked to the existing test event zkusebni-v1-data-05. Only items that the
 * generator really offers in DEV are used:
 *   - 2× chair M57 (static seed, 300 Kč/ks)                          -> priced 600
 *   - 1× electrical point (technical marker)                          -> not billed separately
 *   - electricity 2 kW ordered (static seed L02 base price 5100 Kč)   -> priced 5100
 *   - one-time cleaning ordered (no rate in DEV)                      -> K nacenění
 *   - container wanted without an individual price                    -> K nacenění
 *
 * Safety: refuses to run unless .env.local targets DEV and the server is on localhost. Writes only
 * the reserved project id. An existing project is left untouched (it may have been edited in the
 * browser) unless --reset is passed; --reset overwrites only this reserved project, against its
 * current revision. No other project, event, catalog card or price list is written.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { componentCatalogItems, placeComponent } from "../data/components.ts";
import { createDefaultTechnicalRequirements, createProjectRecord, type ProjectRecord } from "../domain/project.ts";
import { KNOWN_PRODUCTION_SUPABASE_REFS, supabaseProjectRef } from "../lib/env/supabaseEnvironment.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (existsSync(`${root}.env.local`)) process.loadEnvFile(`${root}.env.local`);
const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF?.trim();
const appRef = supabaseProjectRef(process.env.SUPABASE_URL);
if (process.env.NEXT_PUBLIC_APP_ENV?.trim() !== "development" || !expectedRef || appRef !== expectedRef || KNOWN_PRODUCTION_SUPABASE_REFS.includes(appRef)) {
  console.error("✖ Skript běží jen proti DEV (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF, ne produkce).");
  process.exit(1);
}
const baseUrl = (process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) ?? "http://localhost:3000").replace(/\/$/u, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(baseUrl)) {
  console.error("✖ Server musí běžet lokálně (http://localhost:…).");
  process.exit(1);
}
const reset = process.argv.includes("--reset");

const PROJECT_ID = "zkusebni-v1-data-07-b1";
const EVENT_ID = "zkusebni-v1-data-05";

const form = new FormData();
// V1-AUTH-01: a DEV account (Správce) — e-mail + heslo z .env.local, nikdy produkční účet.
form.set("email", process.env.E2E_LOGIN_EMAIL ?? "");
form.set("password", process.env.E2E_LOGIN_PASSWORD ?? "");
form.set("next", "/abf");
const cookie = ((await fetch(`${baseUrl}/api/auth/login`, { method: "POST", body: form, redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
if (!cookie.startsWith("homeworkstudio_session=")) {
  console.error("✖ Přihlášení selhalo (E2E_LOGIN_EMAIL / E2E_LOGIN_PASSWORD v .env.local — DEV účet s rolí Správce).");
  process.exit(1);
}
const headers = { cookie, "Content-Type": "application/json" };

const events = ((await (await fetch(`${baseUrl}/api/events/list`, { headers })).json()) as { events: { id: string }[] }).events;
if (!events.some((event) => event.id === EVENT_ID)) {
  console.error(`✖ Zkušební veletrh ${EVENT_ID} v DEV není.`);
  process.exit(1);
}
const projects = ((await (await fetch(`${baseUrl}/api/projects/list`, { headers })).json()) as { projects: (ProjectRecord & { revision?: number })[] }).projects;
const existing = projects.find((project) => project.id === PROJECT_ID);
if (existing && !reset) {
  console.log(`• Projekt „${existing.name}“ (${PROJECT_ID}) už existuje a zůstává beze změny. Obnovení do výchozího stavu: --reset.`);
  process.exit(0);
}

const chair = componentCatalogItems.find((item) => item.internalCode === "M57");
const electricalPoint = componentCatalogItems.find((item) => item.internalCode === "TECH-ELECTRO");
if (!chair || !electricalPoint) {
  console.error("✖ V seedech chybí židle M57 nebo elektro bod.");
  process.exit(1);
}

const now = new Date().toISOString();
const project: ProjectRecord = createProjectRecord(
  {
    id: PROJECT_ID,
    name: "ZKUŠEBNÍ V1-DATA-07-B1",
    fairId: EVENT_ID,
    company: "ZKUŠEBNÍ V1-DATA-07-B1 s.r.o.",
    boothNumber: "B1-TEST",
    projectType: "individualni",
    individualWidthMm: 3000,
    individualDepthMm: 3000,
    currency: "CZK",
    sceneObjects: [
      placeComponent(chair, "zkusebni-b1-zidle-1", 800, 900),
      placeComponent(chair, "zkusebni-b1-zidle-2", 1600, 900),
      placeComponent(electricalPoint, "zkusebni-b1-elektro", 2600, 2600),
    ],
    technicalRequirements: {
      ...createDefaultTechnicalRequirements(),
      electricity: { ...createDefaultTechnicalRequirements().electricity, status: "ordered", powerOption: "2kw" },
      cleaning: { status: "oneTime", note: "" },
      container: { status: "wanted", volumeSize: "", note: "Bez individuální ceny — test „K nacenění“" },
    },
    notes: { internalNote: "Testovací projekt pro ruční kontrolu V1-DATA-07-B1. Vytvořen skriptem scripts/seedPricingB1TestProject.ts.", customerNote: "" },
  },
  now,
);

const response = await fetch(`${baseUrl}/api/projects/save`, { method: "POST", headers, body: JSON.stringify({ project, expectedRevision: existing?.revision ?? null }) });
if (!response.ok) {
  console.error(`✖ Uložení selhalo: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}
const saved = ((await response.json()) as { project: ProjectRecord & { revision: number } }).project;
console.log(`✔ Projekt „${saved.name}“ (${saved.id}) ${existing ? "obnoven do výchozího stavu" : "založen"}, revize ${saved.revision}, veletrh ${saved.fairId}.`);
