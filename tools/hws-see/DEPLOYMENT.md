# HWS SEE — postup nasazení (Preview → Production)

Platí pro větev `feature/hws-see-mvp` repozitáře **homeworkstudio-app-web** (živý portál na Vercelu). Nic z tohoto postupu dosud nebylo provedeno — vše vyžaduje přístupy k Supabase, Cloudflare a Vercelu a schválení.

Pořadí: **0 kontrola kódu → 1 Supabase DEV → 2 R2 DEV → 3 Vercel Preview → 4 smoke test na Preview → 5 produkce.** Každý krok má kontrolu a cestu zpět.

---

## 0. Lokální kontrola (bez externích služeb)
```bash
npm run typecheck
npm test
npm run build            # pak vrátit next-env.d.ts: git -c core.autocrlf=false checkout -- next-env.d.ts
```
Zkušební běh migrace v izolovaném PostgreSQL 17 (PGlite, mimo repozitář):
```bash
npm install --prefix /tmp/hws-see-pglite @electric-sql/pglite   # Windows: %TEMP%\hws-see-pglite
node tools/hws-see/migration-dry-run.mjs --pglite /tmp/hws-see-pglite
```
Musí skončit `Všechny kontroly prošly.` (aplikuje všech 19 migrací repozitáře, ověří omezení, kaskády, trigger, `see_record_view`, oprávnění rolí, rollback a opětovnou aplikaci).

## 1. Supabase — nejdřív DEV projekt
1. Zkontrolujte, že poslední migrace v DEV odpovídá `supabase/migrations/20261005120000_customer_catalog_presets.sql` (HWS SEE předpokládá funkci `set_updated_at()` z init schématu).
2. **Bezpečný test přímo v DEV (bez trvalé změny):** SQL Editor → vložte
   ```sql
   begin;
   -- obsah supabase/migrations/20261121120000_hws_see.sql
   select count(*) from information_schema.tables where table_name like 'see_%';   -- čekáno 9
   rollback;
   ```
   Pokud cokoli selže, transakce se vrátí a databáze zůstane beze změny.
3. Ostré spuštění v DEV: stejný obsah bez `begin/rollback` (nebo `supabase db push` proti DEV projektu). Kontrola:
   ```sql
   select relname, relrowsecurity from pg_class where relname like 'see_%' and relkind = 'r';   -- 9× true
   select has_function_privilege('anon', 'see_record_view(uuid, uuid, text, boolean, integer)', 'execute');   -- false
   ```
4. Rollback (jen pokud je potřeba, ztratí data HWS SEE): `supabase/rollbacks/20261121120000_hws_see.down.sql`. Nemaže žádnou jinou tabulku ani R2 objekty.
5. Produkce: stejné kroky 2–3 až po úspěšném Preview testu (krok 4) a se schválením. **Nikdy nespouštějte migraci automaticky v build kroku.**

> Migrace byla v iteraci 2 doplněna o `see_files.model_info` a `see_publications.embed_policy/embed_origins`. Pokud by ji někdo spustil ve starší verzi, je potřeba doplňková migrace `alter table … add column …` — ověřte podle tabulky výše.

## 2. Cloudflare R2
1. **Bucket:** R2 → Create bucket → `hws-see-dev` (a později `hws-see-prod`). Location: Automatic / EU dle zbytku portálu. **Public access: vypnuto** (žádná r2.dev ani vlastní doména).
2. **API token:** R2 → Manage API tokens → Create → *Object Read & Write* → **Apply to specific buckets only:** `hws-see-dev` (resp. `hws-see-prod`). Token musí umět PutObject, GetObject, HeadObject, **CopyObject a DeleteObject** (překlíčování při zrušení přístupu). TTL tokenu dle firemní politiky.
   - Alternativa bez nového tokenu: ponechat `SEE_R2_BUCKET_NAME` prázdné — HWS SEE pak použije sdílený bucket portálu s prefixem `hws-see/`. Doporučen je ale samostatný bucket (oddělená práva a úklid).
3. **CORS** (Settings → CORS policy) — přesně šablona `tools/hws-see/r2-cors.json`; pro DEV/Preview přidejte konkrétní stabilní Preview doménu (ne wildcard). Bez CORS selže přímý upload z prohlížeče a načtení GLB.
4. Kontrola: nahrání malého GLB přes editor na Preview (krok 4) — v bucketu vznikne objekt `hws-see/o/<uuid>.glb`; po „Zrušit publikaci“ má objekt nový klíč a starý zmizí.

## 3. Vercel (Preview i Production zvlášť)
Settings → Environment Variables. Stávající proměnné portálu (`APP_LOGIN_PASSWORD`, `APP_SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `R2_*`) **neměnit**. Nové (Preview → DEV hodnoty, Production → produkční):

| Proměnná | Preview | Production | Poznámka |
|---|---|---|---|
| `SEE_R2_BUCKET_NAME` | `hws-see-dev` | `hws-see-prod` | prázdné = sdílený bucket + prefix |
| `SEE_FILE_DELIVERY` | `signed-url` | `signed-url` | `hybrid`/`stream` až po ověření limitů |
| `SEE_REKEY_ON_REVOKE` | `true` | `true` | okamžité zneplatnění vydaných URL |
| `SEE_FILE_URL_TTL_SECONDS` | `60` | `60` | 30–300 |
| `SEE_PIN_GRANT_TTL_MINUTES` | `120` | `120` | 5–720 |
| `SEE_MAX_MODEL_MB` / `SEE_MAX_DOCUMENT_MB` | `200` / `50` | dle potřeby | |
| `SEE_MAX_IMAGE_MB` / `SEE_MAX_PROJECT_MB` | `5` / `3000` | `5` / dle kapacity R2 | obrázky popisků a panelu (1–20) / celková kvóta projektu (413 při překročení) |
| `SEE_EMBED_FRAME_ANCESTORS` | prázdné | prázdné nebo seznam webů | výchozí `'self' https:` |
| `SEE_BACKEND` | **nenastavovat** | **nenastavovat** | jen lokální vývoj |

Pozor: Preview pod stávajícími proměnnými míří na **produkční** Supabase/R2 portálu, pokud nejsou pro Preview přepsané. Pro Preview proto nastavte `SUPABASE_URL`/`SUPABASE_SECRET_KEY` na **DEV projekt** (nebo Preview nepouštějte na HWS SEE).

Kontrola před deployem (offline, nevypisuje tajné hodnoty):
```bash
vercel env pull .env.preview.local --environment=preview     # jen lokálně, soubor je v .gitignore (.env*.local)
node --env-file=.env.preview.local --no-warnings scripts/hwsSeeEnvCheck.ts --target=preview
```
Výsledek musí být `bez chyb`.

## 4. Smoke test na Preview (ručně, anonymní okno pro veřejné části)
1. Login sdíleným heslem → launcher ukazuje HWS Easy (Připravujeme), HWS SEE, ABF Generator; ABF se otevře.
2. HWS SEE → Nový projekt (začíná jedním modelem) → „+ Přidat další model“ ×4 (5 modelů) + PDF (ALL) + JPG (jen 3. model) → editor; popisek s obrázkem a https odkazem, uložení kamery, přesun a smazání modelu, reload.
   - Záložka Panel: zapnout, vyplnit text/obrázek/odkaz, u jednoho modelu vlastní obsah → náhled.
3. Publikovat veřejně → anonymní okno: model, popisky, download (3. model: PDF + JPG, ostatní jen PDF).
   - Panel je po otevření **zavřený**; šipka ho otevře, Esc zavře; rychlé pohledy vpravo nahoře (Přední/Zadní/… s plynulým přechodem); karta popisku s obrázkem a odkazem (otevře se v nové kartě).
4. Přepnout na PIN → anonymní okno: bez PINu nic; špatný PIN → zbývající pokusy; správný PIN → model.
5. Embed na testovací HTTPS stránce (např. CodePen) s výchozí politikou → zobrazí; nastavit „Jen vybrané weby“ bez této domény → prohlížeč iframe zablokuje.
6. Pozastavit → odkaz, embed i download hlásí pozastavení; Obnovit → funguje (PIN znovu).
7. R2: v bucketu se po zrušení publikace změnily klíče objektů (překlíčování); v editoru se neukázalo varování.
8. Fyzický telefon (iOS Safari + Android Chrome): ovládání prsty, celá obrazovka (na iPhonu náhradní režim), načítání velkého modelu.
9. `Partitioned` cookie: PIN prezentace v iframe na cizí doméně → odemknutí PINem funguje.

## 5. Produkce
1. Merge `feature/hws-see-mvp` do `master` až po review a úspěšném Preview.
2. Migrace do produkční Supabase (krok 1.2 → 1.3) **před** deployem kódu (kód bez tabulek vrací u HWS SEE 502, ABF neovlivní).
3. R2 `hws-see-prod` + token + CORS (krok 2), Vercel Production proměnné (krok 3), `scripts/hwsSeeEnvCheck.ts --target=production` bez chyb.
4. Push `master` = produkční deploy (Vercel). Smoke test kroky 1–6 na produkci s testovacím projektem, pak jej smazat.

## Rollback
- Kód: redeploy předchozího produkčního buildu ve Vercelu (Instant Rollback) — HWS SEE zmizí z launcheru, ABF/Easy/login beze změny.
- Data: tabulky `see_*` mohou zůstat (nikoho neovlivní); úplné odstranění jen se schválením přes rollback skript.
- R2: bucket `hws-see-*` lze ponechat; objekty nejsou veřejné.
