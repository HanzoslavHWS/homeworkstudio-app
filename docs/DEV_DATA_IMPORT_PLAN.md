# DEV-02 — Bezpečné importy a příprava dat (Generator ABF FINAL V1)

Stav k 2026-10-16, větev `develop`.

| | Supabase project ref |
|---|---|
| DEV | `wpbivmobbqcqmyehunog` (19/19 migrací, data jen ze seedů migrací) |
| PROD | `fwchkogtaqaunaxmchtu` (v tomto batchi se ho nic nedotklo) |

V tomto batchi **neproběhl žádný datový import**. Všechny dry-runy jen četly z DEV. Zdrojové soubory zůstaly beze změny (otisky SHA-256 před i po běhu jsou shodné). Starší plánové JSONy ze srpna, které vznikly čtením **produkce**, jsou zachované v `private-imports/_archiv_pred_DEV-02/`.

---

## 1. Přehled skriptů

| Skript | Účel | Zápis do DB | Zápis souborů | Ochrana cíle |
|---|---|---|---|---|
| `scripts/importBatch1.ts` | Veletrhy, ceníky, rozhodnutí o mapování (do `import_rows`) | jen s `--apply` | `private-imports/import-batch1-plan.json` | ✅ `createScriptSupabaseClient` + kontrola v zapisovači |
| `scripts/importBatch2a.ts` | M57, L02, 22 technických služeb, 495 cen technických služeb pro jednotlivé veletrhy | jen s `--apply` | `…/import-batch2a-plan.json` | ✅ totéž |
| `scripts/importBatch2b.ts` | 56 položek z PRICELIST, P86 a jejich mapování (bez `pricing_entries`) | jen s `--apply` | `…/import-batch2b-plan.json` | ✅ totéž |
| `scripts/canonicalizeTypeBooths.ts` | Opravný skript: kostra `variants` u Txx a P87 jako záznam k doplnění | jen s `--apply` | — | ✅ totéž |
| `scripts/importPreviewV66.ts` | Náhled `Ultimátní kalkulace V6.6.xlsm` | nikdy (DB nepoužívá) | `…/import-preview-v6.6.json` (vstup pro 2B) | — |
| `scripts/importDryRun.ts` | Starší obecný náhled importu | nikdy | — | — |
| `scripts/matchAbfCodes.ts` | Párování kódů V6.6 ↔ sklad ABF | nikdy | **přepisuje** `code-matching-report.json/.xlsx` | — (v tomto batchi záměrně nespuštěn) |
| `scripts/supabaseDevMigrate.ts` | Migrace do DEV (`db:dev:*`) | jen migrace | — | vlastní kontrola (connection string, `--confirm`) |
| `scripts/technicalRaster*Diagnostic.ts` (10×) | Diagnostika PDF rastrů | nikdy | jeden zapisuje diagnostické PDF | — |

**Zápisy z uživatelského rozhraní** (neběží jako skripty, ale přes API aplikace a `createSupabaseServerClient`):

- *Administrace → Katalog → Import Excelu* (Produkty, Sluzby): `app/api/catalog-admin/excel-import/*` (jen DEV). Dřívější import ABF kódů (`abf-import`) byl odstraněn ve V1-ADMIN-01.
- *Tiskové plochy → import katalogu*: náhled vytvoří `app/api/print-surfaces/import`, zápis pak provede prohlížeč přes `replaceAll` u tří repozitářů
- běžné ukládání v modulech

V lokálním vývoji je hlídá kontrola aplikace (`checkSupabaseTarget`, viz `docs/DEV_PROD_SETUP.md`). Seedovací skripty mimo migrace v projektu nejsou.

## 2. Bezpečnostní pojistky — výsledek auditu

### Nález (před DEV-02)
Všechny skripty používaly `createSupabaseServerClient`. Ten běh bez `NEXT_PUBLIC_APP_ENV` a bez `NODE_ENV=development` považuje za **produkci bez omezení**, protože tak běží Vercel. Samostatný `node scripts/…` vypadá přesně stejně. Pokud tedy byly v shellu produkční údaje (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`), import s `--apply` **zapsal do produkce bez jakékoli kontroly**. Skripty si navíc `.env.local` samy nenačítaly: chránily je jen tehdy, když je někdo spustil s `--env-file=.env.local`. Věta v `DEV_PROD_SETUP.md` („stejná ochrana platí pro skripty“) proto platila jen podmíněně. Je opravená.

### Nové řešení
`lib/db/scriptSupabase.server.ts` + `checkScriptDatabaseTarget` v `lib/env/supabaseEnvironment.ts`:

1. **Jednotné načtení prostředí.** Každý skript čte proměnné ze shellu i z `.env.local` v kořeni repozitáře. Nezáleží na tom, jestli byl spuštěn s `--env-file`, nebo bez něj.
2. **Nejednoznačnost znamená odmítnutí.** Skript odmítne běžet, když:
   - je stejná proměnná nastavená v shellu jinak než v `.env.local`,
   - je klíč v `.env.local` definovaný dvakrát s různou hodnotou.
3. **Pravidla cíle** (bez produkční výjimky):
   - `NEXT_PUBLIC_APP_ENV` musí být výslovně `development` nebo `preview`; hodnota `production` i chybějící hodnota znamenají odmítnutí,
   - `SUPABASE_EXPECTED_PROJECT_REF` je povinný, musí mít platný formát a nesmí být produkční,
   - ref ze `SUPABASE_URL` nesmí být produkční a musí se rovnat očekávanému refu; lokální stack ani adresa, ze které nejde ref přečíst, nestačí,
   - `SUPABASE_SECRET_KEY` je povinný.
4. **Kontrola proběhne před vytvořením klienta.** U `--apply` se to stane jako první krok v `main()`, ještě před čtením zdrojových souborů.
5. **Druhá vrstva v zapisovačích.** `applyBatch1Plan`, `applyBatch2aPlan`, `applyBatch2bPlan` a `applyCanonicalPlanEntry` mají jako první příkaz `assertScriptDatabaseClient(client)`. Odmítnou každého klienta, který neprošel kontrolou cíle, i kdyby ho někdo vytvořil jinou cestou.
6. **Žádný obchvat.** Kontrola nečte příkazovou řádku a nemá žádný přepínač ani proměnnou typu `--force`. Zápis do produkce ze skriptů není možný. Kdyby byl import do produkce někdy potřeba, je to samostatný úkol.
7. Žádná chybová zpráva neobsahuje hodnotu klíče.

### Testy
`tests/scriptDatabaseGuard.test.ts` (6 testů):

- produkční ref je odmítnut v každé kombinaci prostředí,
- odmítnuta je i chybějící a nejednoznačná konfigurace,
- konflikt shellu s `.env.local` a duplicitní klíče končí odmítnutím,
- `--force` na příkazové řádce nic nemění a klient se pro produkci vůbec nevytvoří,
- všechny čtyři zapisovače odmítnou neověřeného klienta dřív, než se dotknou databáze,
- statická kontrola skriptů: žádný z nich nepoužívá jiného klienta ani přímé REST volání a nemá přepínač obchvatu.

Testy 2A a 2B nově vytvářejí falešné klienty přes stejnou kontrolu s fiktivní DEV konfigurací.

Ruční ověření:

- se současným `.env.local` vrátí kontrola `ok` pro `wpbivmobbqcqmyehunog`,
- se shellovým `SUPABASE_URL` mířícím na produkci skončí `canonicalizeTypeBooths.ts --apply --force` odmítnutím ještě před připojením.

## 3. Inventura zdrojových souborů

| Soubor | Obsah | Co by z něj vzniklo |
|---|---|---|
| `private-imports/Ultimátní kalkulace V6.6.xlsm` | Listy PRICELIST (116 položek ve 13 kategoriích), data sheet (14 veletrhů), CZK/EUR (ceny technických služeb pro jednotlivé veletrhy: 264 CZK, 231 EUR, chybí 58 a 91), náklad (téměř prázdný) | Batch 1: 14 veletrhů, 28 ceníků (CZK a EUR pro každý veletrh), 49 řádků `import_rows`. Batch 2A: 24 položek katalogu, 2 mapování, ceny technických služeb až po Batch 1. Batch 2B: 57 položek a 56 mapování (po 2A) |
| `private-imports/code-matching-report.json` (14. 8.) | Párování 116 položek PRICELIST na sklad ABF: 77 EXACT_SAFE, 23 REVIEW, 16 NO_MATCH. Technické služby: 20/2/1 | Zdroj kódů pro 2A (technické služby) a pro identitu a jednotky v 2B |
| `_IMPORT/KODY.xlsm` | 118 řádků; 84 s ABF kódem, 34 bez kódu; 0 duplicitních ani neplatných kódů | Import z UI: 84 nových karet (12 BOOTH, 23 SERVICE, 49 PRODUCT „k zařazení“), u existujících karet doplnění `abf_code`, oficiálního názvu a jednotky |
| `_IMPORT/rozmery_tisk_1_0.xlsx` (list `verze_1.0`) | 3 realizační firmy (`creativ-expo`, `gendai`, `macik`), 30 typů tiskových ploch, 88 výrobních rozměrů (84 dostupných, 4 nedostupné), 2 varování (`Panel_S_25` bez šířky u Creativ Expo a Macík) | Import z UI: **nahrazení** celého katalogu tiskových ploch (viz oddíl 6) |

Veletrhy z V6.6: `ctm`, `czechbus`, `esalon`, `arch`, `beauty`, `decor`, `fishing`, `interior`, `kids`, `pets`, `gastro`, `holiday`, `svd`, `truck`.

- ID odpovídají kanonickým ID v `data/fairs.ts`, např. `beauty` a `decor`.
- `international-2026` (`data/fairs.ts`) v Excelu není.
- `ctm` nemá datum (needsReview).
- Produkce měla v srpnu 15 veletrhů a 28 ceníků. O jednom veletrhu navíc Excel neví.

## 4. Doporučené pořadí importů do DEV

Každý krok se skládá ze tří fází: dry-run, schválení a `--apply`. Po každém kroku následuje znovu dry-run, který musí vrátit samé `noop`.

1. **Batch 1** — veletrhy a ceníky. Je to předpoklad pro ceny v 2A: dnes je 2A blokovaná preflightem, protože 495 cen nemá cílový veletrh ani ceník.
2. **Batch 2A** — M57, L02 a technické služby. Po kroku 1 znovu spustit dry-run a ověřit, že se ceny technických služeb plánují (očekáváno 264 + 231).
3. **Batch 2B** — položky PRICELIST a P86. Dnes je blokovaná preflightem `m57_not_resolved` (M57 vzniká až ve 2A). **Před spuštěním vyřešit rozhodnutí R3** (16 kódů, které KODY nezná).
4. **Kanonizace typových stánků** — po 2B (Txx už existují) přidá kostru `variants` a P87.
5. **Import ABF kódů (`KODY.xlsm`, UI)** až nakonec. Existující karty propojí přes `internal_code` a doplní kód, oficiální ABF název a jednotku, přitom typ (`kind`) nezmění. Shody jen podle názvu (L40, L55 a I20 z 2A, které nemají kód) nabídne ke ručnímu potvrzení. **Kdyby proběhl jako první**, založil by M57 jako „Produkt / k zařazení“ a Batch 2A by pak skončil konfliktem typu.
6. **Tiskové plochy (`rozmery_tisk_1_0.xlsx`, UI)** — v prázdné DEV je současný import bezpečný. Pro opakované importy je potřeba nejdřív batch B1 (oddíl 9).

## 5. Problematické komponenty a kódy

### 5.1 Rozpory mezi `code-matching-report.json` a `KODY.xlsm`
`KODY.xlsm` je novější a ručně potvrzený zdroj. Report vznikl algoritmicky. Batch 2B ale bere kódy z reportu.

| Řádek | Položka | Report | KODY | Poznámka |
|---|---|---|---|---|
| 123 | Celopolep octanormu – celoplošný tisk – 1 m² | REVIEW **N10** (= pronájem haly 1!) | M95 | Report se zjevně mýlí |
| 160 | Internetové Wi-Fi připojení pro jeden přístroj | REVIEW **I10** (= kabel RJ45, který už má ř. 156) | I20 | Report se zjevně mýlí |
| 19 | Dveře shrnovací, uzamykatelné | REVIEW M07 | M08 | Potvrdit správný kód |
| 41, 42 | Zvyšovací pult zakrytý 100×100 a 50×50 | REVIEW M20 (oba) | M25, M21 | KODY rozlišuje rozměry |
| 17, 18, 24, 86, 124 | Stěna plná S15, Dělící příčka M17, Límec M90, Kuchyňská skřínka M80, Celopolep límce M91 | NO_MATCH | mají kód | KODY doplňuje |
| 55, 65, 66, 69, 70, 74, 102, 125, 126, 150, 155 | M61, M53, M52, M56, M58, M40, M48, M98, M99, L40, L55 | REVIEW | potvrzeno | 2B tyto položky přeskočí, KODY je založí |

**16 položek je v reportu jako EXACT_SAFE, ale KODY pro ně kód nemá:**

- M70 závěs
- M10, M11, M12 podhledy
- M26 čtvrtkruhový pult
- M15 samostojný panel
- M85 chladnička prosklená
- M8D myčka
- M82 kávovar
- M87 kávovar presso
- M83 rychlovarná konvice
- M86 fontána
- M8A, M8B, M8C nádobí
- M75 příhradovina

Batch 2B je dnes založí s těmito kódy jako `internal_code`. Nevíme, jestli jde o vědomé vynechání v KODY, nebo o chybějící řádky (viz R3).

### 5.2 Položky bez ABF kódu (34 v KODY)
Neimportují se. Patří sem mimo jiné:

- dveře křídlové, závěs, podhledy, vitrína uzamykatelná, regál pětipolicový,
- pult 100×50 uzamykatelný, pult s límcem, čtvrtkruhový pult, samostojný panel,
- velké chladničky, myčka, kávovary, konvice, fontána, barel, nádobí,
- příhradovina, úvazový bod, lamino stěny a pulty, fólie ORACAL, TV a příslušenství.

### 5.3 Typy komponent
- KODY zařadí 49 položek z řady M/S jako **Produkt „k zařazení“**. Batch 2B je zařadí věcně: 35 nábytek, 8 konstrukce, 4 ostatní a 11 stánků.
- Když proběhne 2B dřív, typy zůstanou podle 2B (KODY typ nemění).

### 5.4 Jednotky
- Excel má jednotku jen u 16 ze 116 řádků. Report navrhuje u 83 „ks“.
- Zápisy jsou nejednotné: `m²`/`m2`, `bm` vs. prázdné, `den` vs. `ks/d`, `m2/ak`, `m³`/`m3`.
- Všech 22 technických služeb z 2A má problém `missing_unit`.
- Doporučení: před 2B schválit převodní tabulku jednotek (R5).

### 5.5 Názvy
- U 69 z 77 položek EXACT_SAFE se český název z ceníku liší od ABF názvu. ABF názvy jsou psané verzálkami, např. „T04 - TYPOVÝ STÁNEK 2X2 m (STAVBA)“.
- Doporučení: **zobrazovaný název = český název z ceníku**, **oficiální název = ABF název** (`official_name`), anglický název z KODY ukládat do `document.abfImport`. Tak to dělá už import KODY.

### 5.6 Ceny
- 23 položek nemá prodejní cenu CZK ani EUR. Jde o technické služby, jejichž ceny jsou jen pro jednotlivé veletrhy.
- 26 položek nemá nákupní cenu.
- 58 cen v CZK a 91 v EUR chybí; přeskočí se, nic se nedopočítává.
- Batch 2B ukládá základní ceny jen do `document.pricingEntries` (57 položek, 1 bez ceny), nikdy do `pricing_entries`.

### 5.7 Typové stánky a jejich součásti
- T04 až T25 (10 stánků): rozměry 2×2 až 5×5 m jsou z reportu, `needs_review`, `generatorEligible=false`, chybí assety.
- P86 (Kóje 2×2) je aktivní a použitelná v generátoru, obsah bere ze seedu `data/booths.ts`.
- P87 (Kóje 2×3) vznikne kanonizací jako záznam k doplnění (bez výšky, ceny a 3D modelu) a KODY ho pak propojí.
- Součásti (balíčky) typových stánků se v žádném importu nevytvářejí, `catalog_item_package_items` zůstane prázdná (R6).

### 5.8 Historické nebo duplicitní položky
- Duplicitní české názvy ani duplicitní navržené kódy nebyly nalezeny.
- V DEV jsou 2 karty grafických služeb ze seedu migrací a s importy nekolidují.
- Ručně zamítnuté mapování „Rychlovarná konvice → L02“ zůstává zamítnuté (jen záznam v `import_rows`).

## 6. Rizika pro historická data

1. **Import tiskových ploch maže a znovu vkládá celý katalog** (`replaceAll`: firmy → typy ploch → rozměry, každý krok samostatně a bez transakce):
   - `tasks.realization_company_id` má `on delete set null`, takže reimport **tiše odpojí úkoly od realizačních firem**, přestože firma dostane znovu stejné ID,
   - `print_surface_projects.realization_company_id` je FK bez kaskády, takže jakmile na některou firmu odkazuje projekt, mazání a s ním celý import **selže**,
   - když selže vkládání po úspěšném smazání, zůstane katalog prázdný,
   - smazání typu plochy kaskádově smaže jeho výrobní rozměry; typy ploch, které v novém Excelu chybí, zmizí, i když na ně odkazují uložené projekty (odkaz v dokumentu projektu),
   - vyúčtování odkazuje na firmy jen textem, takže přežije, pokud zůstane stejný slug názvu. Přejmenování firmy v Excelu ale vytvoří nové ID.
2. **Opakovaný Batch 1** zachová ručně doplněné údaje veletrhu (dokumenty, logo, ceníky), ale **přepíše název, rok a datumy** hodnotami z Excelu.
3. **Batch 2A a 2B** jsou idempotentní podle přirozených klíčů (`internal_code`, popř. `source_system` + `source_key`). Při rozporu typu nebo mapování se zastaví a nic nepřepíšou. Ruční ceny se nepřepisují, vznikne jen hlášení konfliktu.
4. **Pořadí KODY a 2A:** KODY jako první by zablokoval 2A (M57 s jiným typem). Řeší se dodržením pořadí z oddílu 4.
5. **Dva oddělené seznamy realizačních firem:**
   - veletrhy a ceníky používají zástupná ID `default` a `realization-2`…`realization-4` z `data/organizations.ts`,
   - úkoly, tiskové plochy a vyúčtování používají slugy z katalogu tiskových ploch (`creativ-expo`, `gendai`, `macik`),
   - mezi oběma seznamy není vazba (R7).
6. **Produkce:** plány ze srpna ukazují, že produkce už obsahuje veletrhy, ceníky a část katalogu. Žádný import v tomto plánu na produkci necílí a skripty to ani nedovolí. Převod do produkce bude potřebovat vlastní návrh.

## 7. Co lze bezpečně spustit (po schválení)

| Krok | Bezpečnost v DEV | Podmínka |
|---|---|---|
| Batch 1 `--apply` | ✅ bezpečné (prázdná DEV, idempotentní) | R1 (CTM bez data) |
| Batch 2A `--apply` | ✅ po Batch 1 | nový dry-run musí projít preflightem |
| Batch 2B `--apply` | ⚠️ až po R3 a R5 | jinak do DEV zapíše sporné kódy z reportu |
| Kanonizace typových stánků `--apply` | ✅ po 2B | — |
| Import KODY (UI) | ✅ po 2B a kanonizaci | potvrdit shody podle názvu (L40, L55, I20) |
| Import tiskových ploch (UI) | ✅ jen jednou do prázdné DEV | před dalším importem batch B1 |
| `matchAbfCodes.ts` | ❌ nespouštět | přepisuje zdrojový report |

## 8. Rozhodnutí, která musí potvrdit uživatel

- **R1** CTM nemá v Excelu datum. Importovat bez data (needsReview), nebo datum doplnit ručně?
- **R2** `international-2026`: má v DEV vzniknout jako veletrh mimo Excel?
- **R3** 16 kódů z reportu, které KODY nemá (oddíl 5.1). Importovat s kódem z reportu, bez kódu, nebo vůbec?
- **R4** Rozpory v kódech: M07 vs. M08 (dveře shrnovací), M20 vs. M25/M21 (pulty), N10 vs. M95 a I10 vs. I20. Doporučení: platí KODY.
- **R5** Převodní tabulka jednotek (`m²`→`m2`, `bm`, `ks/d`, `m2/ak`…) a výchozí „ks“ pro položky bez jednotky.
- **R6** Součásti typových stánků T04–T25: kdo a z čeho je doplní (Excel je neobsahuje).
- **R7** Jeden seznam realizačních firem: nahradit zástupná ID z `data/organizations.ts` firmami z katalogu tiskových ploch?
- **R8** Zobrazované názvy: potvrdit pravidlo z oddílu 5.5.
- **R9** Rozměr `Panel_S_25` bez šířky u Creativ Expo a Macík doplnit v Excelu, nebo nechat jako varování.
- **R10** Batch B1 (oddíl 9): schválit návrh a jeho zařazení před první reimport tiskových ploch.

## 9. Návrh batch B1 — bezpečná synchronizace katalogu tiskových ploch

**Cíl:** nahradit `replaceAll` synchronizací, která nic nemaže.

1. **Firmy.** Párovat podle ID (slug):
   - existující firma: aktualizovat `name`, `note` a nastavit `is_active = true`,
   - nová firma: vložit,
   - firma v souboru chybí: nastavit `is_active = false` a **nemazat**.

   Úkoly, projekty i vyúčtování si tak ponechají své vazby. Přejmenování firmy, které změní slug, náhled ukáže jako „nová firma + deaktivace staré“ s možností ruční vazby na existující ID.
2. **Typy tiskových ploch:** stejně (upsert podle `id`, chybějící deaktivovat).
3. **Výrobní rozměry:** upsert podle (`realization_company_id`, `preset_id`). Dvojice, které v souboru chybí, smazat pouze tehdy, když na ně nic neodkazuje (rozměry jsou odvozená data), jinak je označit jako nedostupné.
4. **Atomicita:** celý zápis jednou serverovou operací:
   - nová API route se `createSupabaseServerClient` a validací souboru znovu na serveru,
   - ideálně jedna Postgres funkce (RPC) v transakci, ta je **migrací** a do DEV půjde přes `db:dev:apply`,
   - prohlížeč přestane volat tři samostatné `replaceAll`.
5. **Náhled před zápisem:** počty vytvořených, aktualizovaných, deaktivovaných a nezměněných položek a seznam úkolů, projektů a vyúčtování navázaných na deaktivované firmy. Zápis až po potvrzení.
6. **Testy:**
   - reimport stejného souboru = 0 změn,
   - odebraná firma → `is_active = false` a úkol si drží `realization_company_id`,
   - projekt navázaný na odebraný typ plochy zůstane načitatelný,
   - selhání uprostřed zápisu nic nezmění.
7. **UI:** neaktivní firmy skrýt v nabídkách pro nové záznamy, ale zobrazovat je u existujících.

Až po B1 je bezpečné opakovaně importovat `rozmery_tisk_*.xlsx` v DEV i později v produkci.
