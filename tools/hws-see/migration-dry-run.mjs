// HWS SEE — safe migration dry run in a throw-away, in-memory PostgreSQL (PGlite / WASM).
// Nothing is installed into the project and nothing connects to Supabase.
//
//   1) npm install --prefix <tmp>/pglite @electric-sql/pglite        (outside the repository)
//   2) node tools/hws-see/migration-dry-run.mjs --pglite <tmp>/pglite
//
// Applies ALL repository migrations in order (as Supabase would), then checks the HWS SEE schema,
// constraints, cascades, triggers and see_record_view, runs the rollback script, verifies that no
// other table changed, and applies the migration once more. Exit code 1 on any failure.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const pgliteDir = args[args.indexOf("--pglite") + 1];
if (!pgliteDir || args.indexOf("--pglite") < 0) {
  console.error("Použití: node tools/hws-see/migration-dry-run.mjs --pglite <složka s nainstalovaným @electric-sql/pglite>");
  process.exit(2);
}
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "..", "..");
const pgliteDist = path.join(path.resolve(pgliteDir), "node_modules", "@electric-sql", "pglite", "dist");
const { PGlite } = await import(pathToFileURL(path.join(pgliteDist, "index.js")).href);
// Supabase ships pgcrypto (used by the portal's init schema).
const { pgcrypto } = await import(pathToFileURL(path.join(pgliteDist, "contrib", "pgcrypto.js")).href);

const SEE_MIGRATION = "20261121120000_hws_see.sql";
const db = new PGlite({ extensions: { pgcrypto } });
const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`✓ ${label}`);
  } catch (error) {
    results.push(`✗ ${label}: ${error.message}`);
  }
};
const expectFailure = async (sql, pattern) => {
  try {
    await db.exec(sql);
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`jiná chyba než očekávaná: ${error.message}`);
  }
  throw new Error("příkaz měl selhat, ale prošel");
};
const tables = async () => (await db.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows.map((row) => row.table_name);

// Supabase provides these roles; plain PostgreSQL does not.
await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");

const migrationsDir = path.join(repo, "supabase", "migrations");
const files = readdirSync(migrationsDir).filter((name) => /^\d{14}_.+\.sql$/u.test(name)).sort();
let beforeSee = [];
for (const name of files) {
  if (name === SEE_MIGRATION) {
    beforeSee = await tables();
    await check(`migrace ${name} (v transakci)`, async () => {
      try {
        await db.exec(`begin;\n${readFileSync(path.join(migrationsDir, name), "utf8")}\ncommit;`);
      } catch (error) {
        await db.exec("rollback;").catch(() => undefined);
        throw error;
      }
    });
    continue;
  }
  await check(`existující migrace ${name}`, () => db.exec(readFileSync(path.join(migrationsDir, name), "utf8")));
}

const seeTables = ["see_access_grants", "see_annotations", "see_events", "see_file_scene_links", "see_files", "see_pin_attempts", "see_projects", "see_publications", "see_scenes"];
await check("všech 9 tabulek see_* existuje a nic jiného nepřibylo", async () => {
  const added = (await tables()).filter((name) => !beforeSee.includes(name)).sort();
  if (JSON.stringify(added) !== JSON.stringify(seeTables)) throw new Error(`přibylo: ${added.join(", ")}`);
});
await check("RLS zapnuté na všech tabulkách see_*", async () => {
  const rows = (await db.query("select relname, relrowsecurity from pg_class where relname like 'see_%' and relkind = 'r'")).rows;
  const off = rows.filter((row) => !row.relrowsecurity).map((row) => row.relname);
  if (off.length || rows.length !== 9) throw new Error(`bez RLS: ${off.join(", ")}`);
});
await check("anon / authenticated nesmí volat see_record_view", async () => {
  const rows = (await db.query("select has_function_privilege('anon', 'see_record_view(uuid, uuid, text, boolean, integer)', 'execute') as anon, has_function_privilege('authenticated', 'see_record_view(uuid, uuid, text, boolean, integer)', 'execute') as auth")).rows;
  if (rows[0].anon || rows[0].auth) throw new Error("funkce je volatelná veřejně");
});

const project = "11111111-1111-4111-8111-111111111111";
const publication = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const scene = "44444444-4444-4444-8444-444444444444";
await check("vložení projektu, souboru, scény, odkazu, publikace", async () => {
  await db.exec(`
    insert into see_projects (id, name) values ('${project}', 'ZARGES test');
    insert into see_files (id, project_id, kind, display_name, original_file_name, mime_type, size_bytes, storage_key, status)
      values ('${fileId}', '${project}', 'model', 'closed', 'closed.glb', 'model/gltf-binary', 100, 'hws-see/o/${fileId}.glb', 'ready');
    insert into see_scenes (id, project_id, name, model_file_id) values ('${scene}', '${project}', 'Zavřená', '${fileId}');
    insert into see_file_scene_links (file_id, scene_id) values ('${fileId}', '${scene}');
    insert into see_publications (id, project_id, share_slug, mode, status) values ('${publication}', '${project}', '${"A".repeat(32)}', 'public', 'published');
  `);
});
await check("CHECK: jen režimy public | pin (žádný třetí)", () => expectFailure(`update see_publications set mode = 'password' where id = '${publication}'`, /check/iu));
await check("CHECK: režim pin vyžaduje hash PINu", () => expectFailure(`update see_publications set mode = 'pin' where id = '${publication}'`, /pin_requires_hash/iu));
await check("CHECK: krátký share slug odmítnut", () => expectFailure(`update see_publications set share_slug = 'kratky' where id = '${publication}'`, /check/iu));
await check("CHECK: nejvýše 20 povolených domén embedu", () => expectFailure(`update see_publications set embed_origins = array(select 'https://s' || g || '.cz' from generate_series(1, 21) g) where id = '${publication}'`, /check/iu));
await check("CHECK: nepovolený MIME typ souboru odmítnut", () => expectFailure(`insert into see_files (project_id, kind, display_name, original_file_name, mime_type, size_bytes, storage_key) values ('${project}', 'document', 'x', 'x.exe', 'application/x-msdownload', 1, 'k')`, /check/iu));
await check("UNIQUE: storage_key nelze sdílet dvěma soubory", () => expectFailure(`insert into see_files (project_id, kind, display_name, original_file_name, mime_type, size_bytes, storage_key) values ('${project}', 'model', 'y', 'y.glb', 'model/gltf-binary', 1, 'hws-see/o/${fileId}.glb')`, /duplicate|unique/iu));
await check("trigger updated_at se aktualizuje", async () => {
  const before = (await db.query(`select updated_at from see_projects where id = '${project}'`)).rows[0].updated_at;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await db.exec(`update see_projects set name = 'ZARGES test 2' where id = '${project}'`);
  const after = (await db.query(`select updated_at from see_projects where id = '${project}'`)).rows[0].updated_at;
  if (!(after > before)) throw new Error("updated_at se nezměnil");
});
await check("compare-and-set překlíčování (update … where storage_key = old)", async () => {
  const swapped = await db.query(`update see_files set storage_key = 'hws-see/o/new.glb' where id = '${fileId}' and storage_key = 'hws-see/o/${fileId}.glb' returning id`);
  const conflict = await db.query(`update see_files set storage_key = 'hws-see/o/other.glb' where id = '${fileId}' and storage_key = 'hws-see/o/${fileId}.glb' returning id`);
  if (swapped.rows.length !== 1 || conflict.rows.length !== 0) throw new Error("CAS nefunguje");
});
await check("see_record_view: první otevření se počítá, refresh v okně ne", async () => {
  const call = `select see_record_view('${publication}', '${project}', 'visitor-hash', false, 1800) as counted`;
  const first = (await db.query(call)).rows[0].counted;
  const second = (await db.query(call)).rows[0].counted;
  const count = (await db.query(`select view_count from see_publications where id = '${publication}'`)).rows[0].view_count;
  if (first !== true || second !== false || count !== 1) throw new Error(`first=${first} second=${second} count=${count}`);
});
// UI úpravy: libovolný počet modelů, informační panel, obrázek + odkaz u popisku.
const image = "55555555-5555-4555-8555-555555555555";
const annotation = "66666666-6666-4666-8666-666666666666";
await check("info_panel má výchozí hodnotu {} (panel vypnutý)", async () => {
  const row = (await db.query(`select info_panel from see_projects where id = '${project}'`)).rows[0];
  if (JSON.stringify(row.info_panel) !== "{}") throw new Error(`info_panel = ${JSON.stringify(row.info_panel)}`);
});
await check("libovolný počet modelů: projekt s 8 scénami", async () => {
  await db.exec(`insert into see_scenes (project_id, name, sort_order) select '${project}', 'Model ' || g, g from generate_series(1, 7) g`);
  const n = (await db.query(`select count(*)::int as n from see_scenes where project_id = '${project}'`)).rows[0].n;
  if (n !== 8) throw new Error(`scén: ${n}`);
});
await check("soubor druhu image (WebP) je povolený", () => db.exec(`
  insert into see_files (id, project_id, kind, display_name, original_file_name, mime_type, size_bytes, storage_key, status)
    values ('${image}', '${project}', 'image', 'detail', 'detail.webp', 'image/webp', 100, 'hws-see/o/${image}.webp', 'ready')`));
await check("popisek s obrázkem a https odkazem", () => db.exec(`
  insert into see_annotations (id, scene_id, title, position, image_file_id, link_url, link_label)
    values ('${annotation}', '${scene}', 'Zámek', '[0,0,0]', '${image}', 'https://homeworkstudio.cz/', 'Více informací')`));
await check("CHECK: odkaz javascript: v popisku odmítnut", () => expectFailure(`update see_annotations set link_url = 'javascript:alert(1)' where id = '${annotation}'`, /check/iu));
await check("CHECK: příliš dlouhý text odkazu odmítnut", () => expectFailure(`update see_annotations set link_label = repeat('x', 81) where id = '${annotation}'`, /check/iu));
await check("smazání obrázku nezruší popisek (image_file_id → null)", async () => {
  await db.exec(`delete from see_files where id = '${image}'`);
  const row = (await db.query(`select image_file_id from see_annotations where id = '${annotation}'`)).rows[0];
  if (!row || row.image_file_id !== null) throw new Error(`popisek: ${JSON.stringify(row)}`);
});
await check("kaskáda: smazání projektu odstraní scény, soubory, publikaci i události", async () => {
  await db.exec(`delete from see_projects where id = '${project}'`);
  for (const table of ["see_scenes", "see_files", "see_publications", "see_events", "see_file_scene_links"]) {
    const rows = (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n;
    if (rows !== 0) throw new Error(`${table} má ${rows} řádků`);
  }
});

await check("rollback (supabase/rollbacks/…down.sql) odstraní jen objekty HWS SEE", async () => {
  await db.exec(readFileSync(path.join(repo, "supabase", "rollbacks", "20261121120000_hws_see.down.sql"), "utf8"));
  const after = await tables();
  if (JSON.stringify(after) !== JSON.stringify(beforeSee)) throw new Error("tabulky se liší od stavu před migrací");
  const fn = (await db.query("select count(*)::int as n from pg_proc where proname = 'see_record_view'")).rows[0].n;
  if (fn !== 0) throw new Error("funkce see_record_view zůstala");
});
await check("migraci lze po rollbacku znovu aplikovat", () => db.exec(readFileSync(path.join(migrationsDir, SEE_MIGRATION), "utf8")));

console.log(`HWS SEE – zkušební běh migrace (PGlite, PostgreSQL ${(await db.query("show server_version")).rows[0].server_version}, ${files.length} migrací)\n`);
console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("✗"));
console.log(failed.length ? `\n${failed.length} kontrol selhalo.` : "\nVšechny kontroly prošly.");
process.exitCode = failed.length ? 1 : 0;
