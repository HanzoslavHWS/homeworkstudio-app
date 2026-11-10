import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { launcherPresentation } from "../data/launcherApps.ts";
import { HWS_APPS, launcherEntries } from "../domain/hwsApps.ts";

test("registr aplikací: unikátní klíče; ABF je dostupný a míří na /abf", () => {
  const keys = HWS_APPS.map((app) => app.key);
  assert.equal(new Set(keys).size, keys.length);
  const abf = HWS_APPS.find((app) => app.key === "abf");
  assert.equal(abf?.status, "available");
  assert.equal(abf?.url, "/abf");
});

test("registr aplikací: HWS Easy je zatím jen připravená karta — „Připravujeme“, bez adresy", () => {
  const hwsEasy = HWS_APPS.find((app) => app.key === "hws-easy");
  assert.equal(hwsEasy?.status, "coming_soon");
  assert.equal(hwsEasy?.url, null);
  const [entry] = launcherEntries({ isActive: true, isHwsAdmin: false, apps: { "hws-easy": "user" } });
  assert.equal(entry?.opens, false, "a permitted coming-soon app never opens");
});

test("registr aplikací: každá dostupná aplikace má adresu (jinak by karta nikam nevedla)", () => {
  for (const app of HWS_APPS) if (app.status === "available") assert.ok(app.url && app.url.startsWith("/"), `${app.key} bez adresy`);
});

test("rozcestník: loga skutečně existují v public/logo (žádný rozbitý obrázek)", () => {
  for (const app of HWS_APPS) {
    const publicPath = new URL(`../public${launcherPresentation[app.key].logo}`, import.meta.url);
    assert.equal(existsSync(publicPath), true, `${launcherPresentation[app.key].logo} chybí v public/`);
  }
});

test("rozcestník: jen aplikace s členstvím; bez členství žádná karta; deaktivovaný účet nic", () => {
  assert.deepEqual(launcherEntries({ isActive: true, isHwsAdmin: false, apps: { abf: "user" } }).map((entry) => entry.app.key), ["abf"]);
  assert.deepEqual(launcherEntries({ isActive: true, isHwsAdmin: true, apps: {} }), [], "the HWS admin flag opens no application");
  assert.deepEqual(launcherEntries({ isActive: false, isHwsAdmin: false, apps: { abf: "admin" } }), []);
});

test("app/page.tsx (rozcestník) nerenderuje BoothGenerator — ABF Generator žije pod /abf", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal(/BoothGenerator/u.test(source), false);
  assert.match(source, /Launcher/u);
  const launcher = readFileSync(new URL("../components/Launcher.tsx", import.meta.url), "utf8");
  assert.match(launcher, /user\.isHwsAdmin && \(\s*<Link href="\/sprava-uzivatelu"/u, "Správa uživatelů only for shared administrators");
});

test("app/abf/page.tsx renderuje současný BoothGenerator a zachovává auth gate včetně členství v ABF", () => {
  const source = readFileSync(new URL("../app/abf/page.tsx", import.meta.url), "utf8");
  assert.match(source, /import BoothGenerator from "\.\.\/\.\.\/components\/BoothGenerator"/u);
  assert.match(source, /getPageAuth\(\)/u);
  assert.match(source, /state\.status === "unauthenticated"/u);
  assert.match(source, /redirect\(/u);
  assert.match(source, /!hasAppAccess\(state\.user, "abf"\)/u);
});
