import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server.js";
import { handleSeeProjectList } from "../app/api/see/projects/route.ts";
import { handleSeePublicManifest } from "../app/api/see/public/[slug]/route.ts";
import { handleSeePublicUnlock } from "../app/api/see/public/[slug]/unlock/route.ts";
import { isValidEmbedOrigin } from "../domain/seeEmbed.ts";
import { adaptSavedViewDistanceFactor, clippingFor, fitView } from "../domain/seeCameraFit.ts";
import { sessionCookieOptions } from "../lib/auth/session.ts";
import { checkSeeEnvironment, formatSeeEnvReport } from "../lib/see/envCheck.ts";
import { grantCookieOptions } from "../lib/see/http.server.ts";
import { seeResponseHeaders } from "../lib/see/proxyRules.ts";
import { createZarges, json, publish, req, unlock, world } from "./helpers/seeTestKit.ts";

/**
 * HWS SEE deployment configuration: environment check, cookies, response headers, CORS, embed
 * policy and the camera framing used by the viewer. No external service is contacted.
 */

const VALID_ENV = {
  APP_LOGIN_PASSWORD: "a-long-shared-portal-password",
  APP_SESSION_SECRET: "x".repeat(48),
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghijklmnop",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "r2-access-key-id-value",
  R2_SECRET_ACCESS_KEY: "r2-secret-access-key-value-0123456789",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "homeworkstudio-assets",
  SEE_R2_BUCKET_NAME: "hws-see-prod",
};

test("env check: a complete production configuration passes and never prints secret values", () => {
  const findings = checkSeeEnvironment(VALID_ENV, "production");
  assert.deepEqual(findings.filter((finding) => finding.level === "error"), []);
  const report = formatSeeEnvReport(findings, "production");
  for (const secret of [VALID_ENV.APP_LOGIN_PASSWORD, VALID_ENV.APP_SESSION_SECRET, VALID_ENV.SUPABASE_SECRET_KEY, VALID_ENV.R2_ACCESS_KEY_ID, VALID_ENV.R2_SECRET_ACCESS_KEY]) {
    assert.equal(report.includes(secret), false, "secret leaked into the report");
  }
  assert.match(report, /bez chyb/u);
});

test("env check: catches the mistakes that would break or weaken a deployment", () => {
  const level = (env: Record<string, string>, target: "production" | "preview" | "development", variable: string) =>
    checkSeeEnvironment(env, target).find((finding) => finding.variable === variable)?.level;
  assert.equal(level({ ...VALID_ENV, APP_SESSION_SECRET: "short" }, "production", "APP_SESSION_SECRET"), "error");
  assert.equal(level({ ...VALID_ENV, SEE_BACKEND: "local" }, "preview", "SEE_BACKEND"), "error", "local fake must never reach Vercel");
  assert.equal(level({ ...VALID_ENV, SEE_BACKEND: "local" }, "development", "SEE_BACKEND"), "ok");
  const anonJwt = `x.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.y`;
  assert.equal(level({ ...VALID_ENV, SUPABASE_SECRET_KEY: anonJwt }, "production", "SUPABASE_SECRET_KEY"), "error");
  assert.equal(level({ ...VALID_ENV, SUPABASE_SECRET_KEY: "sb_publishable_abc" }, "production", "SUPABASE_SECRET_KEY"), "error");
  assert.equal(level({ ...VALID_ENV, SUPABASE_URL: "http://abc.supabase.co" }, "production", "SUPABASE_URL"), "error");
  assert.equal(level({ ...VALID_ENV, R2_ENDPOINT: "https://other.r2.cloudflarestorage.com" }, "production", "R2_ENDPOINT"), "warn");
  assert.equal(level({ ...VALID_ENV, SEE_R2_BUCKET_NAME: "Bad_Bucket" }, "production", "SEE_R2_BUCKET_NAME"), "error");
  assert.equal(level({ ...VALID_ENV, SEE_FILE_DELIVERY: "proxy" }, "production", "SEE_FILE_DELIVERY"), "error");
  assert.equal(level({ ...VALID_ENV, SEE_FILE_DELIVERY: "stream" }, "production", "SEE_FILE_DELIVERY"), "warn");
  assert.equal(level({ ...VALID_ENV, SEE_REKEY_ON_REVOKE: "false" }, "production", "SEE_REKEY_ON_REVOKE"), "warn");
  assert.equal(level({ ...VALID_ENV, SEE_FILE_URL_TTL_SECONDS: "3600" }, "production", "SEE_FILE_URL_TTL_SECONDS"), "error");
  assert.equal(level({ ...VALID_ENV, SEE_EMBED_FRAME_ANCESTORS: "https://ok.cz *" }, "production", "SEE_EMBED_FRAME_ANCESTORS"), "error");
  assert.equal(level({ ...VALID_ENV, NEXT_PUBLIC_SUPABASE_SECRET_KEY: "x" }, "production", "NEXT_PUBLIC_SUPABASE_SECRET_KEY"), "error");
  assert.equal(level({ ...VALID_ENV, NEXT_PUBLIC_R2_SECRET_ACCESS_KEY: "x" }, "production", "NEXT_PUBLIC_R2_SECRET_ACCESS_KEY"), "error");
  assert.equal(checkSeeEnvironment({}, "production").filter((finding) => finding.level === "error").length, 9);
  assert.equal(checkSeeEnvironment({ APP_LOGIN_PASSWORD: "a-long-password!", APP_SESSION_SECRET: "y".repeat(40), SEE_BACKEND: "local" }, "development").filter((finding) => finding.level === "error").length, 0, "local dev needs no cloud credentials");
});

test("cookies: PIN grant is HttpOnly, Secure, SameSite=None, Partitioned and scoped to one share link in production", () => {
  const response = NextResponse.json({});
  response.cookies.set("hws_see_grant", "token", grantCookieOptions({ secureCookies: true, grantTtlMinutes: 120 }, "A".repeat(32)));
  const header = response.headers.get("set-cookie") ?? "";
  for (const attribute of ["HttpOnly", "Secure", "SameSite=none", "Partitioned", `Path=/api/see/public/${"A".repeat(32)}`, "Max-Age=7200"]) {
    assert.match(header, new RegExp(attribute, "iu"), attribute);
  }
  const local = grantCookieOptions({ secureCookies: false, grantTtlMinutes: 120 }, "B".repeat(32));
  assert.equal(local.sameSite, "lax", "plain-http localhost cannot use SameSite=None");
  assert.equal("partitioned" in local, false);
  const portal = sessionCookieOptions();
  assert.equal(portal.httpOnly, true, "portal session cookie unchanged");
  assert.equal(portal.sameSite, "lax");
  assert.equal(portal.path, "/");
});

test("headers: HWS SEE API responses are never cached, never sniffed and grant no CORS", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "pin" })).body.project.publication!.shareSlug;
  const responses = [
    await handleSeeProjectList(await req("/api/see/projects", { headers: { Origin: "https://evil.example" } }), () => w.deps),
    await handleSeePublicManifest(await req(`/api/see/public/${slug}`, { auth: false, headers: { Origin: "https://evil.example" } }), { slug }, () => w.deps),
    (await unlock(w, slug, "00000000")).response,
  ];
  for (const response of responses) {
    assert.equal(response.headers.get("access-control-allow-origin"), null, "no CORS for foreign sites");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.match(responses[1].headers.get("x-robots-tag") ?? "", /noindex/u);
  const unlockResponse = await handleSeePublicUnlock(await req(`/api/see/public/${slug}/unlock`, { method: "POST", auth: false, body: { pin: "12345678" }, headers: { Origin: "https://evil.example" } }), { slug }, () => w.deps);
  assert.equal(unlockResponse.status, 403, "PIN guessing from a foreign site's script is refused");
});

test("headers: proxy policy matrix for every HWS SEE route type", () => {
  const slug = "Q".repeat(32);
  const matrix: [string, Record<string, string | RegExp>][] = [
    ["/see", { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" }],
    ["/see/projects/abc", { "X-Frame-Options": "DENY", "X-Robots-Tag": /noindex/u }],
    ["/api/see/projects", { "X-Frame-Options": "DENY" }],
    [`/see/p/${slug}`, { "Content-Security-Policy": "frame-ancestors 'self'", "Referrer-Policy": "no-referrer", "X-Robots-Tag": /noindex/u }],
    [`/see/embed/${slug}`, { "Content-Security-Policy": "frame-ancestors 'self' https:", "Referrer-Policy": "no-referrer" }],
    [`/api/see/public/${slug}`, { "Content-Security-Policy": "frame-ancestors 'self'", "X-Robots-Tag": /noindex/u }],
    ["/api/see/content", { "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'", "X-Frame-Options": "DENY" }],
  ];
  for (const [pathname, expected] of matrix) {
    const headers = seeResponseHeaders(pathname, {})!;
    for (const [name, value] of Object.entries(expected)) {
      if (value instanceof RegExp) assert.match(headers[name] ?? "", value, `${pathname} ${name}`);
      else assert.equal(headers[name], value, `${pathname} ${name}`);
    }
  }
  for (const other of ["/", "/abf", "/login", "/api/auth/login", "/api/projects/list"]) assert.equal(seeResponseHeaders(other, {}), undefined, other);
});

test("CORS template for the R2 bucket is exact (no wildcards) and allows only what the app does", () => {
  const rules = JSON.parse(readFileSync(new URL("../tools/hws-see/r2-cors.json", import.meta.url), "utf8")) as { AllowedOrigins: string[]; AllowedMethods: string[]; AllowedHeaders: string[] }[];
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.deepEqual(rule.AllowedOrigins, ["https://app.homeworkstudio.cz"]);
  assert.ok(rule.AllowedOrigins.every((origin) => isValidEmbedOrigin(origin) && !origin.includes("*")));
  assert.deepEqual([...rule.AllowedMethods].sort(), ["GET", "HEAD", "PUT"], "no DELETE/POST from browsers");
  assert.deepEqual(rule.AllowedHeaders, ["Content-Type"], "presigned PUT sends only Content-Type");
});

test("camera framing works for millimetre parts up to building-sized models and every screen shape", () => {
  for (const radius of [0.002, 0.5, 12, 450, 80_000]) {
    for (const aspect of [0.46, 1, 1.78, 2.4]) {
      const view = fitView({ center: [radius * 3, -radius, 1e4], radius, fov: 45, aspect });
      const [px, py, pz] = view.position;
      const distance = Math.hypot(px - radius * 3, py + radius, pz - 1e4);
      const verticalHalf = (45 * Math.PI) / 360;
      const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
      // the bounding sphere fits inside the narrower view cone
      assert.ok(radius / distance <= Math.sin(Math.min(verticalHalf, horizontalHalf)) + 1e-9, `r=${radius} aspect=${aspect}`);
      assert.ok(distance < radius / Math.sin(Math.min(verticalHalf, horizontalHalf)) * 1.2, "not absurdly far away");
      const clip = clippingFor(radius);
      assert.ok(clip.near < distance - radius && clip.far > distance + radius, "whole model inside the clip range");
      assert.ok(clip.far / clip.near <= 12_000, "tight depth range → no z-fighting");
      assert.ok(clip.minDistance > clip.near && clip.maxDistance * 1.5 < clip.far, "zoom limits stay inside the clip range");
    }
  }
  assert.deepEqual(fitView({ center: [0, 0, 0], radius: Number.NaN, fov: 45, aspect: 1 }).target, [0, 0, 0], "degenerate bounds fall back to a unit sphere");
  assert.equal(adaptSavedViewDistanceFactor(1.6), 1);
  assert.equal(adaptSavedViewDistanceFactor(0.5), 2);
  assert.equal(adaptSavedViewDistanceFactor(0.3), 2.2);
});

test("document assignment survives editing: removing a model removes its links, ALL documents stay", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const scenes = zarges.view.scenes.filter((scene) => scene.id !== zarges.inside.id);
  const body = {
    project: { name: zarges.view.project.name, description: "" },
    scenes,
    annotations: [],
    files: zarges.view.files.map((file) => ({ id: file.id, displayName: file.displayName, appliesToAll: file.appliesToAll, sceneIds: file.sceneIds })),
  };
  const saved = await (await import("../app/api/see/projects/[id]/route.ts")).handleSeeProjectSave(await req(`/api/see/projects/${zarges.projectId}`, { method: "PUT", body }), { id: zarges.projectId }, () => w.deps);
  assert.equal(saved.status, 200);
  const view = (await json<{ project: { files: { id: string; appliesToAll: boolean; sceneIds: string[] }[] } }>(saved)).project;
  assert.deepEqual(view.files.find((file) => file.id === zarges.detailId)?.sceneIds, [], "link to the removed model is gone");
  assert.equal(view.files.find((file) => file.id === zarges.manualId)?.appliesToAll, true);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const manifest = await json<{ documents: { id: string }[] }>(await handleSeePublicManifest(await req(`/api/see/public/${slug}`, { auth: false }), { slug }, () => w.deps));
  assert.deepEqual(manifest.documents.map((document) => document.id), [zarges.manualId], "an orphaned model-specific document is not published");
});

test("project list shows states and statistics consistently", async () => {
  const w = world();
  const active = await createZarges(w, "Aktivní projekt");
  const paused = await createZarges(w, "Pozastavený projekt");
  const archived = await createZarges(w, "Archivovaný projekt");
  await publish(w, active.projectId, { action: "publish", mode: "public" });
  await publish(w, paused.projectId, { action: "publish", mode: "pin" });
  const status = await import("../app/api/see/projects/[id]/status/route.ts");
  await status.handleSeeProjectStatus(await req(`/api/see/projects/${paused.projectId}/status`, { method: "POST", body: { action: "pause" } }), { id: paused.projectId }, () => w.deps);
  await status.handleSeeProjectStatus(await req(`/api/see/projects/${archived.projectId}/status`, { method: "POST", body: { action: "archive" } }), { id: archived.projectId }, () => w.deps);
  const list = async (query: string) => json<{ items: { project: { name: string; status: string }; publication?: { status: string; mode: string } }[]; total: number }>(await handleSeeProjectList(await req(`/api/see/projects?${query}`), () => w.deps));
  const all = await list("");
  assert.equal(all.total, 3);
  const byName = Object.fromEntries(all.items.map((item) => [item.project.name, item]));
  assert.equal(byName["Pozastavený projekt"].project.status, "paused");
  assert.deepEqual(byName["Pozastavený projekt"].publication && { status: byName["Pozastavený projekt"].publication.status, mode: byName["Pozastavený projekt"].publication.mode }, { status: "published", mode: "pin" });
  assert.equal(byName["Archivovaný projekt"].publication, undefined);
  assert.equal((await list("status=paused")).total, 1);
  assert.equal((await list("status=archived")).total, 1);
  assert.equal((await list("publication=published")).total, 2);
  assert.equal((await list("publication=draft")).total, 1);
  assert.equal((await list("q=pozastav")).total, 1);
  const paged = await list("limit=5&page=2");
  assert.equal(paged.items.length, 0);
  assert.equal(paged.total, 3);
});

test("proxy: an embed request with an invalid slug never reaches a database lookup", async () => {
  const { proxy } = await import("../proxy.ts");
  const response = await proxy(new NextRequest("http://localhost/see/embed/short"));
  assert.equal(response.status, 307, "not a public route → portal login");
});

test("proxy matcher: only the local-dev upload route bypasses the portal proxy (it checks the session itself)", async () => {
  const { config } = await import("../proxy.ts");
  const [matcher] = config.matcher;
  assert.equal(matcher, "/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico|api/see/dev-storage).*)");
  const pattern = new RegExp(`^${matcher}$`, "u");
  for (const covered of ["/", "/abf", "/login", "/see", "/api/see/projects", "/api/see/public/x", "/api/projects/list"]) assert.equal(pattern.test(covered), true, covered);
  assert.equal(pattern.test("/api/see/dev-storage"), false);
});
