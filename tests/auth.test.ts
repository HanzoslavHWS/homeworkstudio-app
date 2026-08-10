import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  isSessionSecretConfigured,
  sessionCookieOptions,
  verifySessionToken,
} from "../lib/auth/session.ts";
import { passwordsMatch, safeReturnPath } from "../lib/auth/password.ts";
import { proxy } from "../proxy.ts";

const SECRET = "test-session-secret-with-at-least-32-characters";

test("podepsaná session je platná, tampered a expired session nejsou", async () => {
  const now = 1_800_000_000_000;
  const token = await createSessionToken(SECRET, now);

  assert.equal(await verifySessionToken(token, SECRET, now + 1000), true);
  assert.equal(await verifySessionToken(`${token}x`, SECRET, now + 1000), false);
  assert.equal(
    await verifySessionToken(token, SECRET, now + 13 * 60 * 60 * 1000),
    false,
  );
});

test("session cookie používá bezpečné serverové atributy", () => {
  const options = sessionCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.ok(options.maxAge > 0);
});

test("session secret musí mít alespoň 32 znaků", () => {
  assert.equal(isSessionSecretConfigured("kratky"), false);
  assert.equal(isSessionSecretConfigured(SECRET), true);
});

test("porovnání hesla a návratová cesta nepovolí open redirect", () => {
  assert.equal(passwordsMatch("spravne", "spravne"), true);
  assert.equal(passwordsMatch("spatne", "spravne"), false);
  assert.equal(safeReturnPath("/models/chairs/zidle.glb"), "/models/chairs/zidle.glb");
  assert.equal(safeReturnPath("https://example.com"), "/");
  assert.equal(safeReturnPath("//example.com"), "/");
});

test("proxy bez session přesměruje model na login", async () => {
  const previousSecret = process.env.APP_SESSION_SECRET;
  process.env.APP_SESSION_SECRET = SECRET;
  try {
    const response = await proxy(
      new NextRequest("https://app.homeworkstudio.cz/models/chairs/zidle.glb"),
    );
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://app.homeworkstudio.cz/login?next=%2Fmodels%2Fchairs%2Fzidle.glb",
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.APP_SESSION_SECRET;
    } else {
      process.env.APP_SESSION_SECRET = previousSecret;
    }
  }
});

test("proxy s platnou HttpOnly session povolí aplikaci i model", async () => {
  const previousSecret = process.env.APP_SESSION_SECRET;
  process.env.APP_SESSION_SECRET = SECRET;
  try {
    const token = await createSessionToken(SECRET);
    for (const url of [
      "https://app.homeworkstudio.cz/",
      "https://app.homeworkstudio.cz/models/chairs/zidle.glb",
    ]) {
      const response = await proxy(
        new NextRequest(url, {
          headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-middleware-next"), "1");
    }
  } finally {
    if (previousSecret === undefined) {
      delete process.env.APP_SESSION_SECRET;
    } else {
      process.env.APP_SESSION_SECRET = previousSecret;
    }
  }
});
