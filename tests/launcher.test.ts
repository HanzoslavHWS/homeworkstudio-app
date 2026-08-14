import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { launcherApps } from "../data/launcherApps.ts";

test("launcherApps: každá položka má unikátní id", () => {
  const ids = launcherApps.map((app) => app.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("launcherApps: ABF Generator je enabled/ready a míří na /abf", () => {
  const abf = launcherApps.find((app) => app.id === "abf-generator");
  assert.equal(abf?.status, "ready");
  assert.equal(abf?.enabled, true);
  assert.equal(abf?.route, "/abf");
});

test("launcherApps: HWS Easy je zatím coming-soon a disabled, bez funkční route", () => {
  const hwsEasy = launcherApps.find((app) => app.id === "hws-easy");
  assert.equal(hwsEasy?.status, "coming-soon");
  assert.equal(hwsEasy?.enabled, false);
});

test("launcherApps: každé enabled/ready app má neprázdnou route (jinak by karta nikam nevedla)", () => {
  for (const app of launcherApps) {
    if (app.enabled && app.status === "ready") {
      assert.notEqual(app.route.trim(), "", `${app.id} má prázdnou route`);
    }
  }
});

test("launcherApps: loga skutečně existují v public/logo (žádný rozbitý obrázek na launcheru)", () => {
  for (const app of launcherApps) {
    const publicPath = new URL(`../public${app.logo}`, import.meta.url);
    assert.equal(existsSync(publicPath), true, `${app.logo} chybí v public/`);
  }
});

test("app/page.tsx (launcher) už nerenderuje BoothGenerator přímo — ABF Generator žije pod /abf", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal(/BoothGenerator/u.test(source), false);
  assert.match(source, /Launcher/u);
});

test("app/abf/page.tsx renderuje současný BoothGenerator beze změny komponenty a zachovává auth gate", () => {
  const source = readFileSync(new URL("../app/abf/page.tsx", import.meta.url), "utf8");
  assert.match(source, /import BoothGenerator from "\.\.\/\.\.\/components\/BoothGenerator"/u);
  assert.match(source, /verifySessionToken/u);
  assert.match(source, /redirect\(/u);
});
