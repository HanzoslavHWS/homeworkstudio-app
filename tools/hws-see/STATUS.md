# HWS SEE — stav implementace (21. 11. 2026, P3 – připravenost na produkci)

Větev: `feature/hws-see-mvp` (z `master` a9ead51) ve worktree `homeworkstudio-app-web` = původní HWS portál (ne HWS APP DEV / `develop`).
**Necommitováno, nic nepushnuto, nenasazeno. Žádný zápis do produkční ani DEV databáze, žádné změny Cloudflare/R2/DNS/Vercel.** Ruční testy běžely v lokálním režimu `SEE_BACKEND=local` s daty mimo repozitář; migrace v izolovaném PGlite.

Dokumentace: architektura `IMPLEMENTATION.md` (§5 iterace 2, **§6 P3**), přesný postup nasazení **`DEPLOYMENT.md`**, CORS šablona `r2-cors.json`, test migrace `migration-dry-run.mjs`.

## P3 — dokončeno

| Oblast | Výsledek | Ověřeno |
|---|---|---|
| **1. Robustnost R2** | timeouty + omezené opakování v klientovi HWS SEE; výpadek → 503 + Retry-After s českou zprávou; upload/ověření/kopírování/mazání bez poškození projektu; překlíčování s ověřením kopie a compare-and-set; opuštěné uploady mimo limity (nic se nemaže); opakování v prohlížeči | 15 testů odolnosti vč. 25 kol náhodného vkládání chyb (R2 i DB), výpadek streamu, DB chyba uprostřed uložení |
| 1. Bezpečnost okamžitého zneplatnění | zrušení přístupu nikdy nezávisí na R2 (epocha + granty), nové klíče neuhodnutelné, R2 silně konzistentní, kopie se použije jen ověřená, souběh nevytvoří neplatný záznam | testy + revize (IMPLEMENTATION §6) |
| **2. 3D viewer** | indikátor po fázích (přístup → X / Y MB → zpracování); 1 automatické opakování + „Zkusit znovu“; kamera 2 mm – 80 km; užší near/far; fullscreen celé prezentace + náhradní režim (iPhone); dotyk, safe-area, větší popisky; PBR/nasvícení zkontrolováno PBR mapou | headless Chrome: 12 MB model na pomalé síti, 3× přerušené stahování → chyba → „Zkusit znovu“ → načteno, 2mm díl a 400m hala 50 km od počátku zarámované, záložní fullscreen + Escape, tah prstem |
| **3. Administrace** | potvrzení při odchodu z editoru i z rozpracovaného „Nový projekt“, záloha konceptu (pokrývá i tlačítko Zpět) s „Obnovit / Zahodit“, štítek „Neuložené změny“, samo-mizející potvrzení, trvalé chyby, varování z R2 i v Projektech, kontrola prázdných názvů, stavy „Publikováno – odkaz blokován“ / „Publikace zrušena“, poslední otevření | prohlížeč: zrušený odchod, obnova po navigaci pryč, „✓ Změny uloženy.“, skrytí po 6 s, chybová hláška; testy přiřazení dokumentů (odebraný model → odkaz zmizí, dokument se nepublikuje) a stavů/filtrů/stránkování v Projektech |
| **4. Nasazení** | `npm run see:env-check` (offline, bez tajných hodnot); `DEPLOYMENT.md` (Supabase DEV → Preview → Production, R2 bucket/token/CORS, Vercel proměnné, smoke test, rollback); bezpečný test migrace; kontrola hlaviček, cookies, CORS, embedu | migrace v PGlite (PostgreSQL 17): **35/35 kontrol** včetně všech 19 migrací repozitáře, CHECK omezení, kaskád, triggeru, `see_record_view`, oprávnění rolí, rollbacku a opětovné aplikace; 11 testů konfigurace nasazení |
| **5. Testy** | nové sady `seeResilience` (15) a `seeDeployment` (11), rozšířený testovací kit (výpadky R2, chybující DB) | viz níže |

**Nalezeno a opraveno během P3**
- Chrome tiše odmítl prefixovaný fullscreen a viewer to považoval za úspěch → nyní se ověřuje skutečný stav a jinak se zapne náhradní režim.
- Next 16 `proxy` ořezává těla požadavků nad 10 MB → lokální upload velkých GLB selhal (server ho správně odmítl kvůli velikosti). Lokální upload routa je vyjmutá z proxy a session ověřuje sama; produkce se netýká (upload jde přímo do R2).
- Před přepisem klíče v DB se nekontrolovalo, že kopie v R2 je úplná, a neznámý výsledek zápisu do DB mohl vést ke smazání používané kopie → ověření kopie + compare-and-set + opětovné načtení záznamu.
- `.gitignore` nechránil `.env.preview.local` apod. (doporučené `vercel env pull`) → přidán vzor `.env*.local`.

## Ověření (skutečně spuštěno, P3)
- `npm run typecheck` — bez chyb.
- `npm test` — **3177 pass / 0 fail / 2 skipped** (3179; přeskočené jsou starší testy mimo HWS SEE). HWS SEE: `seeModule` 11, `seeSecurity` 12, `seeAudit` 23, `seeResilience` 15, `seeDeployment` 11.
- `npm run build` — OK bez varování.
- `node tools/hws-see/migration-dry-run.mjs --pglite <tmp>` — 35/35.
- `npm run see:env-check` — bez proměnných správně hlásí 9 chyb a exit 1; testy ověřují, že úplná konfigurace projde a žádná tajná hodnota se nevypíše.
- HTTP průchod v `next dev` (8/8): **stávající login** (stránka, špatné heslo, správné heslo → HttpOnly/Lax cookie, odhlášení), **launcher s HWS Easy „Připravujeme“** (jediná neaktivní karta), **ABF Generator** za loginem a jeho API stále 401 bez session, příprava testovacích projektů, nedokončený upload hlášen.
- Headless Chrome (SwiftShader): viz tabulka; konzole bez chyb.

## Co zbývá / blokery (vyžadují externí přístupy nebo fyzické zařízení)
1. **Supabase:** migrace nikde nespuštěná — postup v `DEPLOYMENT.md` §1 (DEV v transakci s `rollback`, pak ostře, produkce až po Preview).
2. **Cloudflare R2:** bucket `hws-see-dev/prod` (neveřejný), token jen na bucket s **Put/Get/Head/Copy/Delete**, CORS dle `r2-cors.json` (+ konkrétní Preview doména). Chování proti skutečnému R2 (CopyObject, timeouty, CORS) zatím ověřeno jen s náhradou.
3. **Vercel:** proměnné pro Preview a Production (`DEPLOYMENT.md` §3), u Preview přesměrovat Supabase na DEV projekt; `see:env-check` musí být bez chyb.
4. **Na Preview / fyzickém zařízení ověřit:** nativní fullscreen (headless Chrome ho neumí — ověřen jen náhradní režim), iPhone Safari a Android (dotyk, notch, velké modely), `Partitioned` cookie v cizím iframu, `beforeunload` dialog v reálném prohlížeči, při `stream`/`hybrid` limity velikosti odpovědi.
5. **E-mail** není nakonfigurovaný (jen kopírovatelné texty); **identita** = sdílené heslo (každý přihlášený je editor i správce).
6. Mimo rozsah P3: uložené pohledy, >3 modely, úklid osiřelých R2 objektů (jen se logují), unikátní návštěvy v UI, Cloudflare Worker pro doručování.

## Připravenost
- **Ruční kontrola (code review): ANO.** Kód je kompletní pro P0–P3, typecheck/testy/build zelené, změny mimo modul jsou malé a popsané níže.
- **Preview nasazení: ANO, po splnění blokerů 1–3** (DEV migrace, R2 bucket+token+CORS, Vercel Preview proměnné) — všechny kroky jsou v `DEPLOYMENT.md`, kontrolu proměnných dělá `npm run see:env-check -- --target=preview`.
- **Produkce:** až po úspěšném smoke testu na Preview (§4) a schválení migrace do produkční DB.

## Jak spustit
```bash
npm run dev                                   # běžný vývoj (.env.local s APP_*, SUPABASE_*, R2_*)
SEE_BACKEND=local npm run dev                 # HWS SEE bez cloudu (data v .see-local/ nebo SEE_LOCAL_DIR)
npm test                                      # celá sada
node --no-warnings --test tests/seeModule.test.ts tests/seeSecurity.test.ts tests/seeAudit.test.ts tests/seeResilience.test.ts tests/seeDeployment.test.ts
npm run typecheck
npm run build                                 # přepíše next-env.d.ts → git -c core.autocrlf=false checkout -- next-env.d.ts
npm run see:env-check -- --target=preview     # kontrola proměnných (offline)
node tools/hws-see/migration-dry-run.mjs --pglite <složka s @electric-sql/pglite>
```
Lint skript v repozitáři neexistuje.

## Rozsah změn mimo nový modul
`proxy.ts` (veřejné výjimky jen pro share-link routy HWS SEE, hlavičky jen pro `/see*`, z matcheru vyjmuta pouze lokální `api/see/dev-storage`), `data/launcherApps.ts` (karta HWS SEE), `app/globals.css` (mřížka launcheru na 3 karty), `package.json` (registrace testů, skript `see:env-check`), `.env.example`, `.gitignore` (`.see-local/`, `.env*.local`). **Login, HWS EASY ani ABF nebyly změněny** (ověřeno testy `auth`/`launcher` a HTTP průchodem).

## Historie iterací
- **P0–P1 (iterace 1):** modul, launcher, editor, upload, publikace public/PIN, embed, statistiky.
- **P2 (iterace 2):** KTX2, embed politika per prezentace, bezpečnostní audit (7 oprav), překlíčování, výkon vieweru.
- **P3 (tato iterace):** robustnost R2, viewer (načítání, opakování, kamera, fullscreen, dotyk), administrace (neuložené změny, zprávy, stavy), příprava nasazení, testy.
