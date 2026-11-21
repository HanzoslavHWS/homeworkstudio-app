# HWS SEE — stav implementace (21. 11. 2026, UI úpravy)

Větev: `feature/hws-see-mvp` (z `master` a9ead51) ve worktree `homeworkstudio-app-web` = původní HWS portál (ne HWS APP DEV / `develop`).
P0–P3 jsou v lokálním commitu `2a533de`; UI úpravy tvoří jeden další lokální commit. **Nic nepushnuto, nenasazeno. Žádný zápis do produkční ani DEV databáze, žádné změny Cloudflare/R2/DNS/Vercel.** Ruční testy běžely v lokálním režimu `SEE_BACKEND=local` s daty mimo repozitář; migrace v izolovaném PGlite.

Dokumentace: zadání `HWS_SEE_UI_UPRAVY.md` (+ `reference-viewer-markup.png`), architektura `IMPLEMENTATION.md` (§5 iterace 2, §6 P3, **§7 UI úpravy**), postup nasazení **`DEPLOYMENT.md`**, CORS šablona `r2-cors.json`, test migrace `migration-dry-run.mjs`.

## UI úpravy — dokončeno

| Bod zadání | Výsledek | Ověřeno |
|---|---|---|
| **A. Libovolný počet modelů** | průvodce začíná 1 modelem + „+ Přidat další model“, přesun ↑/↓, odebrání; editor: přidat, přejmenovat, přesunout, odstranit (poslední ne); stabilní UUID scény; smazání modelu nemaže soubory a vazby řeší explicitně (potvrzení vyjmenuje dokumenty bez přiřazení); dokumenty pro všechny / libovolnou podmnožinu; dynamický přepínač (posun, klávesy, na telefonu `<select>` u > 4 modelů); limit 3 odstraněn z kódu, SQL i textů — zůstal technický strop 60 + kvóta velikosti projektu | testy 1→2→5 a 7 modelů, přesun se zachováním popisků a vazeb, smazání se zachováním souborů, podmnožina 5 modelů, staré projekty beze změny, kontrola zdrojů na „max 3“; prohlížeč: průvodce 1→2→5 + přesun + odebrání, editor 1→2→5 → uložit → reload, prohození, smazání s potvrzením → reload |
| **B. Ikona popisků** | `message-square-text` místo GPS špendlíku, vypnuto = přeškrtnutí + ztlumení, `aria-pressed`, tooltip, `aria-label` | test + prohlížeč (aria-label) |
| **C. Indikátor „N“** | `next.config.ts` jen s `devIndicators: false` | prohlížeč v `next dev`: indikátor se nezobrazuje |
| **D. Rychlé pohledy** | Výchozí/3D, Přední, Zadní, Levý, Pravý, Horní, Spodní; plynulý přechod podle ohraničující koule (2 mm – 400 m, mimo počátek), respektuje omezený pohyb; lišta vpravo nahoře, na mobilu jedno tlačítko „Pohled“; i v celé obrazovce, embedu a editoru | testy vektorů/vzdáleností/easing; prohlížeč: snímky začátek ≠ průběh ≠ konec, nic nepřekrývá, fullscreen, embed, mobil |
| **E. Informační panel** | zapnutí na úrovni projektu, obsah projektu + přepsání pro model (jasné pravidlo), nadpis, formátovaný text bez HTML, obrázek, odkazy; **vždy zavřený po vstupu**, ručně otevřený vydrží přepnutí modelu; 320–420 px, posun, × / Esc; mobil = spodní list; editor se záložkou „Panel“ a náhledem; snapshot jen když je zapnutý; za PINem | testy normalizace, pravidla, publikace jen zapnutého, PIN + nový PIN zneplatní obrázek, odmítnutí nebezpečných odkazů a cizích souborů; prohlížeč: zavřeno → otevřít → přepnout model (obsah modelu) → Esc, šířka 402 px, reload = zavřeno, mobilní spodní list, PIN bez obsahu → po odemčení zavřený panel |
| **F. Obrázek a odkaz u popisku** | JPG/PNG/WebP do 5 MB, MIME + signatura, zmenšení v prohlížeči (1600 px), `object-fit`; doručení stejně jako GLB (local i R2, PIN, zneplatnění, jen soubory snapshotu); odkaz jen `https://` (lokálně i `http://localhost`), nový panel s `noopener noreferrer`; staré popisky platí | testy validace (javascript:, data:, vbscript:, //, http://, přihlašovací údaje, file:), WebP magie, 5 MB, obrázek mimo snapshot = 404, smazaný obrázek vypadne ze snapshotu; prohlížeč: karta s obrázkem a odkazem, celá na obrazovce |
| **G. Testy** | nová sada `seeUiRefinements` (22 testů), rozšířený testovací kit (obrázky), zkušební migrace s novými sloupci | viz níže |

**Nalezeno a opraveno během úprav**
- Na desktopu otevřený panel posunul lištu pohledů přes záložky modelů → lišta s názvem a modely se při otevření panelu zúží.
- Karta popisku: zakrytá značka ztlumila i otevřenou kartu a karta s obrázkem přetékala spodní okraj → ztlumí se jen značka, karta se otevře na volnou stranu, s omezenou výškou.
- Prázdný řádek odkazu v editoru by zablokoval uložení → při ukládání se vynechá.
- U mnoha modelů by viewer přednačítal první modely seznamu → nejdřív sousední modely aktivní scény.
- Turbopack: cesta lokálního backendu (`SEE_LOCAL_DIR`) trasovala do serverového výstupu celý projekt (riziko velikosti nasazení) → `turbopackIgnore`; build bez varování, trasování SEE rout bez `.see-local/`.
- Nestabilní test z P3: změna posledního znaku podpisu lístku se někdy lišila jen ve výplňových bitech base64url, a podpis se tak dekódoval stejně → ověření nyní porovnává kanonický zápis podpisu (žádná alternativní hláskování) a test zkouší všechny varianty posledního znaku.

## Ověření (skutečně spuštěno)
- `npm run typecheck` — bez chyb.
- `npm test` — **3199 pass / 0 fail / 2 skipped** (3201; přeskočené jsou starší testy mimo HWS SEE). HWS SEE: `seeModule` 11, `seeSecurity` 12, `seeAudit` 23, `seeResilience` 15, `seeDeployment` 11, `seeUiRefinements` 22.
- `npm run build` — OK, bez varování.
- `node tools/hws-see/migration-dry-run.mjs --pglite <tmp>` — **42/42** (navíc: `info_panel` výchozí `{}`, 8 scén, druh `image` + WebP, popisek s obrázkem a odkazem, CHECK proti `javascript:` a dlouhému textu odkazu, smazání obrázku nezruší popisek).
- Headless Chrome (SwiftShader) proti lokálnímu `next dev` (`SEE_BACKEND=local`, data jen ve scratchpadu): **42/42 kroků** — průvodce, editor 1→2→5 modelů s reloadem, prohození, smazání, záložka Panel s náhledem, popisek s obrázkem a odkazem, rychlé pohledy s přechodem, panel (výchozí zavřený, otevřít, přepnout model, Esc, reload), karta popisku, celá obrazovka, mobil (pohledy, spodní list), veřejný → PIN → odemčení → zpět veřejný, embed, bez indikátoru „N“.
  - Uživatelův běžící `npm run dev` (port 3000) zůstal nedotčený; kontrola běžela z dočasné kopie zdrojů ve scratchpadu (bez `.env*`, `.git`, `.see-local`).

## Co zbývá / blokery (vyžadují externí přístupy nebo fyzické zařízení)
1. **Supabase:** migrace nikde nespuštěná (je stále jeden soubor a obsahuje i nové sloupce) — postup v `DEPLOYMENT.md` §1.
2. **Cloudflare R2:** bucket, token (Put/Get/Head/Copy/Delete), CORS dle `r2-cors.json`. Obrázky popisků a panelu jdou stejnou cestou jako GLB, proti skutečnému R2 zatím ověřeno jen s náhradou.
3. **Vercel:** proměnné pro Preview a Production (`DEPLOYMENT.md` §3; nové volitelné `SEE_MAX_IMAGE_MB`, `SEE_MAX_PROJECT_MB`), `see:env-check` bez chyb.
4. **Na Preview / fyzickém zařízení ověřit:** nativní fullscreen, iPhone Safari a Android (spodní list panelu, rozbalení pohledů, posun přepínače modelů prstem, zmenšení fotky z telefonu před nahráním), `Partitioned` cookie v cizím iframu, `beforeunload` a potvrzovací dialogy v reálném prohlížeči.
5. **E-mail** není nakonfigurovaný (jen kopírovatelné texty); **identita** = sdílené heslo.
6. Mimo rozsah: uložené vlastní pohledy, úklid osiřelých R2 objektů (jen se logují), unikátní návštěvy v UI, Cloudflare Worker pro doručování.

## Připravenost
- **Ruční kontrola (code review): ANO.** Typecheck, testy, build, zkušební migrace i kontrola v prohlížeči jsou zelené.
- **Preview nasazení: ANO, po splnění blokerů 1–3.**
- **Produkce:** až po úspěšném smoke testu na Preview (`DEPLOYMENT.md` §4) a schválení migrace do produkční DB.

## Jak spustit
```bash
npm run dev                                   # běžný vývoj (.env.local s APP_*, SUPABASE_*, R2_*)
SEE_BACKEND=local npm run dev                 # HWS SEE bez cloudu (data v .see-local/ nebo SEE_LOCAL_DIR)
npm test                                      # celá sada
node --no-warnings --test tests/seeModule.test.ts tests/seeSecurity.test.ts tests/seeAudit.test.ts tests/seeResilience.test.ts tests/seeDeployment.test.ts tests/seeUiRefinements.test.ts
npm run typecheck
npm run build                                 # přepíše next-env.d.ts → git -c core.autocrlf=false checkout -- next-env.d.ts
npm run see:env-check -- --target=preview     # kontrola proměnných (offline)
node tools/hws-see/migration-dry-run.mjs --pglite <složka s @electric-sql/pglite>
```
Lint skript v repozitáři neexistuje.

## Rozsah změn mimo nový modul
`next.config.ts` (nový, **jen** `devIndicators: false`), `proxy.ts` (veřejné výjimky jen pro share-link routy HWS SEE, hlavičky jen pro `/see*`, z matcheru vyjmuta pouze lokální `api/see/dev-storage`), `data/launcherApps.ts` (karta HWS SEE), `app/globals.css` (mřížka launcheru na 3 karty), `package.json` (registrace testů, skript `see:env-check`), `.env.example`, `.gitignore` (`.see-local/`, `.env*.local`). **Login, HWS EASY ani ABF nebyly změněny** (testy `auth`/`launcher` zelené).

## Historie iterací
- **P0–P1 (iterace 1):** modul, launcher, editor, upload, publikace public/PIN, embed, statistiky.
- **P2 (iterace 2):** KTX2, embed politika per prezentace, bezpečnostní audit (7 oprav), překlíčování, výkon vieweru.
- **P3:** robustnost R2, viewer (načítání, opakování, kamera, fullscreen, dotyk), administrace, příprava nasazení, testy — commit `2a533de`.
- **UI úpravy (tato iterace):** libovolný počet modelů, ikona popisků, bez indikátoru „N“, rychlé pohledy, informační panel, obrázek a odkaz u popisku, testy.
