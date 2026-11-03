/**
 * Checks the DEV Cloudflare R2 bucket before testing uploads in the browser.
 *
 *   npm run r2:dev:check                     [-- --origin=http://localhost:3000]
 *
 * 1. reads the R2 config exactly as the app does (lib/storage/r2Config.ts: DEV bucket only),
 * 2. asks R2 for a CORS preflight the way the browser does before a presigned PUT,
 * 3. uploads, reads back and deletes ONE small object under temporary/storage-smoke-test/.
 *
 * Never prints secrets. Refuses to run unless NEXT_PUBLIC_APP_ENV=development. Touches nothing
 * outside temporary/storage-smoke-test/.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CloudflareR2StorageProvider } from "../lib/storage/cloudflareR2.server.ts";
import { readR2Config } from "../lib/storage/r2Config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (existsSync(`${root}.env.local`)) process.loadEnvFile(`${root}.env.local`);
if (process.env.NEXT_PUBLIC_APP_ENV?.trim() !== "development") {
  console.error("✖ Kontrola běží jen ve vývoji (NEXT_PUBLIC_APP_ENV=development v .env.local).");
  process.exit(1);
}
const origin = (process.argv.find((arg) => arg.startsWith("--origin="))?.slice("--origin=".length) ?? "http://localhost:3000").replace(/\/$/u, "");

let failed = false;
const ok = (message: string) => console.log(`✔ ${message}`);
const fail = (message: string) => { failed = true; console.error(`✖ ${message}`); };

let config;
try {
  config = readR2Config(process.env);
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
ok(`Konfigurace: bucket „${config.bucketName}“ (DEV), endpoint ${new URL(config.endpoint).host.replace(/^[^.]+/u, "<účet>")}`);

const provider = new CloudflareR2StorageProvider(config);
const storageKey = `temporary/storage-smoke-test/${crypto.randomUUID()}.txt`;
const body = `HomeworkStudio DEV R2 check ${new Date().toISOString()}`;
let uploaded = false;
try {
  const upload = await provider.createUploadUrl({ storageKey, mimeType: "text/plain", originalFileName: "check.txt" });

  const preflight = await fetch(upload.uploadUrl, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" } });
  const allowOrigin = preflight.headers.get("access-control-allow-origin");
  if (preflight.ok && (allowOrigin === origin || allowOrigin === "*")) ok(`CORS: prohlížeč z ${origin} smí nahrávat (PUT)`);
  else fail(`CORS: bucket nepovoluje PUT z ${origin} (HTTP ${preflight.status}). Nastavte CORS policy podle docs/R2_STORAGE_SETUP.md.`);

  const put = await fetch(upload.uploadUrl, { method: "PUT", headers: { ...upload.headers, Origin: origin }, body });
  if (!put.ok) throw new Error(`Nahrání testovacího objektu selhalo: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  uploaded = true;
  ok("Nahrání přes podepsanou adresu (jako v aplikaci)");

  const metadata = await provider.getMetadata(storageKey);
  if (metadata?.contentLength === Buffer.byteLength(body)) ok("Objekt je v bucketu (HEAD)");
  else fail("Objekt po nahrání v bucketu není nebo má jinou velikost.");

  const downloadUrl = await provider.getDownloadUrl(storageKey, 60);
  const get = await fetch(downloadUrl, { headers: { Origin: origin } });
  const getAllowOrigin = get.headers.get("access-control-allow-origin");
  if (get.ok && (await get.text()) === body) ok("Stažení přes podepsanou adresu (náhledy)");
  else fail(`Stažení selhalo: HTTP ${get.status}.`);
  if (getAllowOrigin === origin || getAllowOrigin === "*") ok(`CORS: prohlížeč z ${origin} smí číst (GET — 3D náhled GLB)`);
  else fail(`CORS: bucket nepovoluje GET z ${origin}; 3D model se v prohlížeči nenačte.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (uploaded) {
    try {
      await provider.deleteObject(storageKey);
      ok("Testovací objekt smazán");
    } catch (error) {
      fail(`Testovací objekt ${storageKey} se nepodařilo smazat (${error instanceof Error ? error.message : String(error)}). Token potřebuje oprávnění Object Read & Write.`);
    }
  }
}
process.exit(failed ? 1 : 0);
