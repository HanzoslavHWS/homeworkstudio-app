# HomeworkStudio / Generator_ABF — architektonický audit

Stav ke dni 14. 10. 2026, větev `master` (poslední commit `5f405e0`) + neuncommitnutý modul Kontrola vyúčtování (batch 1).

Audit vychází ze zdrojového kódu a migrací v repozitáři. **Neověřoval jsem živou databázi, nastavení Vercelu ani to, které migrace jsou v produkci skutečně aplikované** — tam, kde na tom závěr závisí, je to výslovně uvedeno. Nic v aplikaci ani v databázi se tímto auditem nezměnilo.

Značení závažnosti: **K** = kritické (ztráta dat, bezpečnost, rozbitý tok), **D** = důležité (nekonzistence, budoucí chyby), **Ko** = kosmetické / údržba.

---

## 1. Skutečný aktuální stav aplikace

### 1.1 Technologie a běh

| Oblast | Stav | Důkaz |
|---|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript 7 (`strict: false`) | `package.json`, `tsconfig.json` |
| Databáze | Supabase Postgres, přístup **jen ze serveru** přes service-role klíč | `lib/db/supabase.server.ts` (`SUPABASE_SECRET_KEY`) |
| Soubory | Jeden privátní Cloudflare R2 bucket, v DB jen `storageKey` | `lib/storage/cloudflareR2.server.ts`, `docs/R2_STORAGE_SETUP.md` |
| AI | OpenAI (obrázky vizualizací, texty e-mailů), volitelné | `lib/ai/*`, `.env.example` |
| Nasazení | Vercel (podle `.env.example` a `docs/R2_STORAGE_SETUP.md`); v repu není `vercel.json` ani `next.config.*` | kořen repozitáře |
| Migrace | 19 SQL souborů v `supabase/migrations/`; každý má hlavičku „NOT applied … apply manually“. Projekt je přes Supabase CLI napojený na vzdálený projekt (`supabase/.temp/project-ref`) | `supabase/migrations/*.sql` |
| Testy | `node --test` nad explicitním seznamem souborů v `package.json` (aktuálně 3030 testů, všechny procházejí); **žádné CI** (`.github` neexistuje) | `package.json` `scripts.test` |
| Lokální data | `_IMPORT/` a `private-imports/` jsou v `.gitignore` | `.gitignore` |

### 1.2 Struktura UI

Aplikace má dvě stránky: launcher (`app/page.tsx`, `data/launcherApps.ts`) a `/abf`. Celý pracovní prostor `/abf` je **jedna klientská komponenta** `components/BoothGenerator.tsx` (4 998 řádků). Přepínání modulů je stav `workspaceSection` (`BoothGenerator.tsx:351`), ne routing — moduly nemají vlastní URL, nejde na ně odkázat ani je samostatně chránit.

Navigace (`components/AppSidebar.tsx`): Nový projekt, Projekty, Úkoly, Knihovna stánků, Katalog komponent, Katalog (zákaznický), Výstavy/eventy, Ceníky, Správa cen, E-maily, Tiskové plochy, Technické rastry, Kontrola vyúčtování.

### 1.3 Perzistence

`BoothGenerator.tsx:556–660` + `lib/db/persistenceMode.client.ts`:

- **db** — API odpoví → vše jde přes `/api/*` do Supabase.
- **local-fallback** — jen ve vývoji při 503 (Supabase nenakonfigurovaný): projekty, eventy a ceníky do `localStorage` (`domain/repository.ts`, `domain/eventRepository.ts`, `domain/priceListRepository.ts`).
- **unavailable** — produkce bez DB; nic se tiše neukládá lokálně (dobře navržené).

Ostatní moduly (úkoly, tiskové plochy, rastry, e-maily, katalog, vyúčtování) fungují jen s DB.

### 1.4 Autentizace a API

- **Jedno sdílené heslo** `APP_LOGIN_PASSWORD` → podepsaná cookie `homeworkstudio_session` (HMAC-SHA256, platnost 12 h). Payload obsahuje jen `{ version, expiresAt }` — **žádnou identitu** (`lib/auth/session.ts`, `app/api/auth/login/route.ts`).
- `proxy.ts` (Next 16 middleware) pustí bez session jen `/login` a `/api/auth/login`, ostatní vrací 401 / redirect.
- **Každá API route kontroluje session znovu** (53 rout přímo `isSessionRequestAuthorized` nebo přes wrapper; Kontrola vyúčtování přes `guarded()` v `lib/settlement/settlementApi.server.ts`). Obrana do hloubky je tedy konzistentní — ale ověřuje jen „někdo zná heslo“.
- Autor změn je **volný text z prohlížeče** (`actorName` v `localStorage`, `components/workflow/tasks/useTaskStore.ts:7`), posílaný klientem → `created_by`, `actor_name`, `verified_by`. `email_history.user_id` existuje, ale nic ho nevyplňuje.

### 1.5 Moduly a stav dokončenosti

| Modul | Hlavní soubory | Úložiště | Stav |
|---|---|---|---|
| Generátor stánků (projekty) | `BoothGenerator.tsx`, `components/configurator/*`, `components/workflow/WorkflowSteps.tsx` | `projects` (JSONB `document`) | Funkční; monolit, směs statických a DB katalogů (viz D3) |
| Knihovna stánků / Katalog komponent | `ComponentAdminPage.tsx` (1 569 ř.), `BoothAdminPage.tsx`, `domain/catalogItemsAdmin.ts` | `catalog_items`, `catalog_item_package_items` | Funkční, dobře chráněné (archivace místo mazání, guard proti hard-delete) |
| Import ABF kódů (KODY) | — | `catalog_items`, `import_batches` (historické záznamy) | Odstraněno ve V1-ADMIN-01; nahrazuje Import Excelu |
| Zákaznický katalog | `CustomerCatalogPage.tsx`, `lib/customerCatalogPdf.ts` | `customer_catalog_presets` + čte katalog/ceny | Funkční |
| Výstavy / eventy | `CatalogManagementPages.tsx`, `domain/organizations.ts` | `events` | Funkční; legacy aliasy ID (D2) |
| Ceníky / Správa cen | `PricingAdminPages.tsx`, `domain/pricingAdmin.ts` | `price_lists`, `pricing_entries` | Funkční; dvojí zdroj základních cen (D4) |
| E-maily | `EmailsPage.tsx`, `domain/email*.ts` | `email_templates`, `email_history` | Funkční; Outlook koncept je jen „feasibility layer“ bez napojení na Graph (`lib/mail/outlookDraftProvider.server.ts`) |
| Tiskové plochy | `components/workflow/printSurfaces/*` | `print_surface_*` (5 tabulek) | Funkční; **rizikový import katalogu** (K1) |
| Technické rastry | `components/workflow/technicalRasters/*`, `domain/technicalRaster*.ts` | `technical_raster_projects` (JSONB) | Funkční, rozsáhlé; realizačky jen volným textem (D1) |
| Úkoly / Kalendář | `components/workflow/tasks/*`, `domain/taskService.ts` | `tasks`, `task_*`, `stand_checklist_*` | Funkční |
| Kontrola vyúčtování | `components/workflow/settlement/*`, `domain/settlement*.ts` | `settlement_*`, `catalog_item_names` | Batch 1 hotový v kódu; **migrace `20261013120000` neaplikovaná, necommitnuté** |
| AI vizualizace | `AiVisualizationPanel.tsx`, `lib/ai/*` | R2 | Funkční při nastaveném `OPENAI_API_KEY` |

---

## 2. Mapa modulů a závislostí

```
                         ┌──────────────── events (veletrhy) ────────────────┐
                         │                                                    │
 Generátor ──projects.event_id──┐        Tiskové plochy ──event_id──┐         │
   │  document.boothId ─────────┼─► catalog_items ◄── Katalog/Knihovna stánků │
   │  document.sceneObjects[]   │       ▲   ▲   ▲                             │
   │  (statické id z data/      │       │   │   └── Kontrola vyúčtování        │
   │   components.ts!)          │       │   │        (catalog_item_names,     │
   │  document.realizationProfileId     │   │         settlement_vendor_*)    │
   │  (statický seznam!)        │       │   └── pricing_entries ◄── Ceníky ───┤
   │                            │       │            │ price_list_id          │
   └──── technical pricing ─────┼───────┘            ▼                        │
                                │                price_lists ── event_id ─────┤
 Technické rastry ─event_id─────┘  (stands[].realizationCompany = volný text) │
 Úkoly ──event_id, realization_company_id, source_type/source_id ─────────────┤
 E-maily ──event_id, template_id ─────────────────────────────────────────────┘

 print_surface_realization_companies ◄── print_surface_projects (tvrdý FK)
                                     ◄── print_surface_production_dimensions (FK cascade)
                                     ◄── tasks (FK set null)
                                     ◄·· settlement_checks / mappings / rules (měkká reference)
```

Společné „klíče“, na kterých se moduly potkávají:

- **Veletrh** = `events.id` (text). Všechny DB moduly ho používají jako FK.
- **Stánek** = `event_id` + číslo stánku. Neexistuje tabulka stánků; normalizace je ve dvou funkcích: `normalizeStandNumber` (`domain/technicalStandNumber.ts`, jen mezery) a `settlementStandKey` (`domain/settlementCheck.ts`, navíc úvodní nuly a velikost písmen). Úkoly a checklist používají první, vyúčtování druhou → `4C07` ≠ `4C7` mezi moduly (D6).
- **Komponenta** = `catalog_items.id` (uuid), byznys identity `internal_code` a `abf_code`.
- **Realizační firma** = čtyři nezávislé reprezentace (D1).

---

## 3. Databázové tabulky a jejich vlastníci

Vlastník = modul, který tabulku zakládá a zapisuje; konzumenti jen čtou. Zdroj: `create table` v migracích a `.from("…")` v `lib/db/*.ts`.

| Tabulka | Migrace | Vlastník (zápis) | Konzumenti (čtení) |
|---|---|---|---|
| `events` | init | Výstavy/eventy (`eventRepository.supabase.ts`), importy batch 1 | všechny moduly (FK), `eventIdValidation.server.ts` |
| `projects` | init | Generátor (`projectRepository.supabase.ts`) | delete-guard katalogu (trigger) |
| `catalog_items` | init + 20260818, 20261001 | Katalog komponent (`catalogItemsAdmin.supabase.ts`), KODY import, importy 2A/2B, `typeBoothCanonicalization` | generátor, ceníky, zákaznický katalog, tech. ceny, vyúčtování |
| `catalog_item_package_items` | 20261001 | Knihovna stánků (balíčky) | katalog |
| `price_lists` | init | Ceníky (`priceListRepository`, `pricingAdmin`), import batch 1 | generátor, zákaznický katalog |
| `pricing_entries` | init + 20260814, 20260825 | Správa cen, import 2A, SQL seed graphics | generátor (tech. služby), zákaznický katalog |
| `import_batches`, `import_rows` | init | importy 1/2A/2B, KODY | — (audit importů) |
| `catalog_mappings` | init | importy 2A/2B | importy 2A/2B |
| `email_templates`, `email_history` | 20260901* | E-maily | — |
| `print_surface_realization_companies` | 20260906 | Tiskové plochy — import Excelu (`replaceAll`) | tiskové plochy, úkoly, vyúčtování |
| `print_surface_presets`, `print_surface_production_dimensions` | 20260906 | Tiskové plochy — import Excelu | tiskové plochy |
| `print_surface_projects`, `print_surface_exports` | 20260906, 20260907* | Tiskové plochy | úkoly (`source_id`, bez FK) |
| `technical_raster_projects` | 20260907170000 | Technické rastry | úkoly (`source_id`) |
| `task_categories`, `task_recurring_rules`, `tasks`, `task_history`, `stand_checklist_templates`, `stand_checklist_entries` | 20260925 | Úkoly | — |
| `customer_catalog_presets` | 20261005 | Zákaznický katalog | — |
| `catalog_item_names`, `settlement_*` (9 tabulek) | 20261013 (neaplikováno) | Kontrola vyúčtování | — |

Všechny tabulky mají `enable row level security` **bez jediné policy** (init schema, sekce 32 a stejný vzor ve všech dalších migracích).

---

## 4. Nalezené duplicity, nekonzistence a rizika

### K1 — Import katalogu Tiskových ploch může selhat, smazat data nebo odpojit úkoly *(kritické)*

`PrintSurfaceCatalogImportPanel.tsx:78–80` volá postupně `replaceAll` pro firmy, presety a rozměry; každé `replaceAll` je **delete-all + insert, bez transakce** (`lib/db/realizationCompanyRepository.supabase.ts:24`, `printSurfacePresetRepository.supabase.ts:41`, `printSurfaceProductionDimensionRepository.supabase.ts:44`). Důsledky podle schématu `20260906150000_print_surfaces.sql` a `20260925120000_tasks.sql`:

1. `print_surface_projects.realization_company_id` má **tvrdý FK bez `on delete`** (ř. 90) → jakmile kterýkoli projekt tiskových ploch odkazuje na firmu, smazání všech firem selže a **import přestane fungovat**.
2. `tasks.realization_company_id … on delete set null` (tasks.sql ř. 87) → pokud smazání projde (žádný projekt tiskových ploch zatím firmu nepoužívá), **všem úkolům se tiše vymaže vazba na realizačku**, i když se firma vzápětí znovu vloží se stejným ID.
3. `print_surface_production_dimensions … on delete cascade` → rozměry zmizí spolu s firmami; když pak selže insert, katalog zůstane prázdný.
4. Selhání mezi kroky (firmy nahrazeny, presety ne) nechá katalog v nekonzistentním stavu.
5. `app/api/print-surfaces/catalog/route.ts:71–81` předává tělo požadavku do repozitářů **bez validace** (žádný whitelist polí).

Neověřeno: zda už v produkci existuje projekt tiskových ploch s vyplněnou realizačkou (pak je bod 1 už aktivní) a kolik úkolů má realizačku (rozsah bodu 2).

### K2 — Login není autorizace *(kritické pro plánované role, aktuálně „známé riziko“)*

- Jedno sdílené heslo, cookie bez identity (`lib/auth/session.ts:4–7`). Kdo zná heslo, má **plná práva ke všemu**: editace katalogu a cen, mazání projektů, import ceníků, generování AI obrázků na účet firmy.
- Session nejde odvolat (bezstavový token; jediná možnost je změnit `APP_SESSION_SECRET` a odhlásit všechny). Odchod kolegy = změna hesla pro všechny.
- Login nemá omezení počtu pokusů (`app/api/auth/login/route.ts`).
- RLS „bez policy“ jen brání anonymnímu klíči. Service-role klíč RLS obchází **záměrně**, takže databáze sama **nevynucuje nic**; veškerá ochrana stojí na tom, že každá route zavolá `isSessionRequestAuthorized` (dnes ano, ale nic to nehlídá — nová route bez kontroly by byla chráněná už jen `proxy.ts`).
- Auditní stopa je slabá: `created_by` / `actor_name` / `verified_by` jsou texty, které posílá klient a které si kdokoli může vyplnit libovolně. Historie existuje jen u úkolů (`task_history`); katalog, ceny, eventy a projekty historii změn nemají (jen `updated_at`).

### D1 — Realizační firma má čtyři nezávislé evidence *(důležité)*

| # | Kde | ID | Použití |
|---|---|---|---|
| 1 | `data/realizationProfiles.ts` | `default`, `realization-2`…`realization-4` | Generátor: výběr „realizačního profilu“ (`BoothGenerator.tsx:811, 3158`), ukládá se do `projects.document.realizationProfileId` (`domain/project.ts`) |
| 2 | `data/organizations.ts:131` + typ `domain/organizations.ts:168` | stejné fiktivní ID | `price_lists.realization_company_id`, `pricing_entries.realization_company_id` (měkké reference) |
| 3 | `print_surface_realization_companies` + `domain/realizationCompany.ts` | slug z hlavičky Excelu | tiskové plochy, úkoly, vyúčtování |
| 4 | `technical_raster_projects.document.stands[].realizationCompany` | volný text | technické rastry (`domain/technicalRaster.ts:810`) |

Jediná skutečná evidence je č. 3, ale je pojmenovaná jako součást Tiskových ploch a spravuje ji jen import Excelu (K1). Generátor a ceníky pracují s fiktivním seznamem.

### D2 — Veletrhy mají DB zdroj a dva statické stíny

- DB: `events` (`eventRepository.supabase.ts`).
- `data/organizations.ts` `exhibitions` — počáteční stav `useState([...exhibitions])` (`BoothGenerator.tsx:355`) před načtením DB a seed pro localStorage fallback (`:564`).
- `data/fairs.ts` (`beauty`, `decor`, `international-2026`) — `selectedFair` se hledá **nejdřív ve statickém seznamu** a teprve potom v DB eventu (`BoothGenerator.tsx:799–809`). Statický záznam tak může přebít název, ceník a logo z DB.
- Legacy ID: `domain/eventIdentity.ts` mapuje `for-beauty-autumn-2026 → beauty` atd.; server je při zápisu převádí (`lib/db/eventIdValidation.server.ts`), ale staré ID mohou stále ležet v JSONB dokumentech.
- Vazba veletrh ↔ ceník je dvakrát: `events.document.priceListIds` (autoritativní) a `price_lists.event_id` (kód sám uvádí jako „secondary/denormalized“, `domain/organizations.ts:181`).

### D3 — Katalog: DB katalog vedle statického katalogu

- DB `catalog_items` je hlavní katalog (admin, ceny, typové stánky, komponenty stánku).
- `data/components.ts` (413 ř.) je **statický katalog**, který dál používají `ComponentLibrary.tsx`, `PricingBar.tsx`, `OrderImportPanel.tsx`, `WorkflowSteps.tsx`, `AdminPages.tsx` a `BoothGenerator.tsx` (`componentCatalogItems`).
- Uložené projekty odkazují na statická ID (`chair-basic`, `technical-electrical`) a typovku přes legacy `koje-2x2` — výslovně zjištěno v auditu v `20261001120000_catalog_item_types_abf_codes_packages.sql` (hlavička). Delete-guard katalogu proto prohledává JSON projektů textovým `LIKE`.
- Identifikátory: `id` (uuid), `internal_code` (stabilní, neměnný), `abf_code` (ABF, oddělený od 20261001), `document.id` (legacy), `document.sourceKey`. Pravidla jsou dobře zdokumentovaná, ale konzumenti používají různé klíče.

### D4 — Dva zdroje základních cen

- Tabulka `pricing_entries` (bez `price_list_id`/`event_id` = základní cena, komentář v init schématu ř. 101–103) — zapisuje ji import 2A a Správa cen.
- `catalog_items.document.pricingEntries` — čte ho Katalog komponent pro zobrazení základní ceny (`domain/catalogItemsAdmin.ts` `documentBasePricing`) a generátor přes `getBasePricingEntry` (`domain/catalog.ts`). Import 2A přitom do dokumentu zapisuje `pricingEntries: []` (`domain/importBatch2a.ts:259`).
- Pravděpodobný důsledek (neověřeno na datech): u importovaných položek ukazuje admin katalogu prázdnou základní cenu, přestože v `pricing_entries` je.

### D5 — Tři mechanismy mapování názvů

- `catalog_mappings` (init): Excel řádek → katalogová položka, jen pro importy 2A/2B.
- `catalog_item_names` (20261013): další názvy ABF u komponenty.
- `settlement_vendor_mappings` (20261013): názvy realizačky → komponenta.
- Navíc `domain/catalogMapping.ts`, `domain/abfCodeMatching.ts`, `domain/technicalServiceProductMapping.ts` (statická konfigurace) a vlastní normalizace názvů (`normalizeCatalogName` vs. `normalizeSettlementText` — první neodstraňuje diakritiku).

Mechanismy mají různé účely, ale stejný problém („jak se tahle věc jmenuje v cizím zdroji“) řeší každý po svém.

### D6 — Číslo stánku se normalizuje dvěma způsoby

`normalizeStandNumber` (úkoly, checklist, rastry) mění jen mezery; `settlementStandKey` sjednocuje i `4C07`/`4C7` a velikost písmen. Úkol založený ze stánku `4C07` se tak nespojí s výsledkem kontroly stánku `4C7`.

### D7 — Vícekrokové zápisy bez transakce

PostgREST nemá transakce přes více příkazů. Kromě K1 se to týká i `saveCatalogPackageItems` (upsert + mazání po řádcích), importů 1/2A/2B a ukládání úkolu s historií. Kontrola vyúčtování to řeší kompenzací (stav `importing`, cascade delete) — ostatní moduly ne. Bezpečné řešení jsou Postgres funkce (RPC) volané jedním požadavkem.

### D8 — Neaplikované a neověřené migrace

Není zdroj pravdy o tom, které migrace jsou v produkci (žádná tabulka verzí v repu, jen ruční aplikace). Kód má fallbacky pro neaplikovanou migraci katalogu (`CatalogSchemaNotMigratedError`), což je správné, ale stav produkce je potřeba zjistit (`supabase migration list`) před každým dalším batchem.

### Ko — údržba

- `BoothGenerator.tsx` má 4 998 řádků a drží stav všech modulů → každá změna navigace nebo modulu sahá do jednoho souboru.
- Seznam testů je ručně vypsaný v `package.json`; nový test, který se tam zapomene přidat, se nikdy nespustí. Žádné CI.
- Kódování: `docs/R2_STORAGE_SETUP.md` a `data/*.ts` se při čtení přes PowerShell zobrazují jako mojibake; ověřit, že jsou soubory konzistentně UTF-8 (v prohlížeči se aplikace zobrazuje správně).
- Neuncommitnutý stav: `.claude/worktrees/agent-ad8fee78cee1d6e87` je v `git status` jako smazaný; vznikl mimo práci na aplikaci.

---

## 5. Návrh cílové architektury

### 5.1 Principy

1. **Jedna evidence na jeden pojem**, moduly jsou pohledy. Žádný modul si nezakládá vlastní seznam firem, veletrhů ani komponent.
2. **Rozšiřovat, nepřepisovat** (expand → migrate → contract): nová struktura vedle staré, převod dat se kontrolou, teprve pak odstranění staré.
3. **Oprávnění vynucuje server** v každé route jednou společnou funkcí; databáze je druhá vrstva.
4. **Každá důležitá změna má záznam v historii** se skutečnou identitou uživatele.

### 5.2 Sdílené jádro (core)

| Evidence | Cílový zdroj | Poznámka |
|---|---|---|
| Uživatelé, role, oprávnění | `app_users` (+ Supabase Auth nebo vlastní hesla), `app_roles`, `app_role_permissions` | viz 5.3 |
| Historie změn | `audit_log` | viz 5.4 |
| Veletrhy | `events` (beze změny) | statické `data/fairs.ts`, `data/organizations.ts.exhibitions` jen jako seed pro vývoj |
| Realizační firmy | neutrální `realization_companies` | převzít data z `print_surface_realization_companies` se stejnými ID; tiskové plochy mají vlastní jen rozměry |
| Katalog | `catalog_items` (+ `catalog_item_package_items`) | `data/components.ts` postupně nahradit; staré ID zachovat jako aliasy |
| Názvy z cizích zdrojů | `catalog_item_names` rozšířit o `source` (ABF, realizačka X, import Y) | `catalog_mappings` a `settlement_vendor_mappings` se na něj postupně napojí, ne smažou |
| Ceníky a ceny | `price_lists` + `pricing_entries` jako jediný zdroj | `document.pricingEntries` jen pro čtení, pak odstranit |
| Stánek | zatím bez tabulky; **jedna** normalizační funkce pro celý systém | tabulka `event_stands` až s modulem Realizace a podklady |
| Soubory | R2 (beze změny) + jednotná evidence `assets` až s modulem podkladů | |

### 5.3 Uživatelé a oprávnění

**Doporučení:** Supabase Auth (e-mail + heslo, pozvánky, reset hesla) + tabulka `app_users` s rolí. Alternativa je vlastní tabulka uživatelů s hashem hesla (argon2/bcrypt) — méně závislostí, ale reset hesla a pozvánky by se psaly ručně. Rozhodnutí je otázka Q1.

Role (výchozí matice, k potvrzení — Q2):

| Oprávnění | Superadmin | Administrátor | Technik | Prohlížení |
|---|:-:|:-:|:-:|:-:|
| Správa uživatelů a rolí | ✔ | — | — | — |
| Katalog, ceníky, veletrhy, realizačky — editace | ✔ | ✔ | — | — |
| Importy (KODY, ceníky, katalog tiskových ploch) | ✔ | ✔ | — | — |
| Pravidla realizaček — aktivace | ✔ | ✔ | — | — |
| Pracovní moduly (generátor, rastry, tiskové plochy, vyúčtování, úkoly, e-maily) — práce | ✔ | ✔ | ✔ | — |
| AI generování (placené) | ✔ | ✔ | ✔ (limit) | — |
| Mazání projektů / kontrol | ✔ | ✔ | jen vlastní | — |
| Čtení všeho | ✔ | ✔ | ✔ | ✔ |

Oprávnění jako jemné klíče (`catalog.edit`, `pricing.edit`, `settlement.rules.activate`, `ai.generate`, …); role je jen pojmenovaná sada klíčů, takže pozdější jemnější nastavení pro modul nevyžaduje změnu kódu.

**Vynucení:**

1. Session cookie ponese `userId` (Supabase JWT nebo vlastní podepsaný token s ID a verzí session → jde odvolat).
2. Každá route: `const user = await requirePermission(request, "catalog.edit")` — jedna funkce v `lib/auth/`, která vrací uživatele, nebo 401/403. Autor změn (`created_by` atd.) se bere **ze session, nikdy z těla požadavku**.
3. Test, který projde všechny `app/api/**/route.ts` a selže, pokud route nevolá `requirePermission` (strážce proti zapomenuté kontrole).
4. **RLS:** dokud server používá service-role klíč, RLS bez policy zůstává správně (deny-all pro všechny ostatní). Skutečné RLS policy mají smysl teprve, až server začne do DB chodit s JWT uživatele — doporučuji to jako pozdější krok jen pro citlivé tabulky (uživatelé, audit, ceny), ne hned pro všechno. Rozhodnutí Q3.
5. Rate limit na login (např. 5 pokusů / 15 min na IP + účet) a na AI routy.

### 5.4 Historie změn

Tabulka `audit_log (id, occurred_at, user_id, action, entity_type, entity_id, summary, before jsonb, after jsonb, request_id)`, zapisovaná serverovým helperem ve stejném RPC jako změna (aby záznam nemohl chybět). `task_history` zůstává (má vlastní UI), do budoucna se může plnit stejným helperem. Pro katalog a ceny stačí diff změněných polí.

### 5.5 Centrální administrace

```
Administrace                       ← nová sekce, vlastní URL (/abf/admin/...)
├─ Komponenty a katalog            = dnešní Katalog komponent + Knihovna stánků (stejná data catalog_items)
│   └─ karta komponenty: kódy, názvy ABF (catalog_item_names), názvy realizaček (pohled), ceny (pohled)
├─ Ceníky                          = dnešní Ceníky + Správa cen sloučené do jednoho místa
├─ Veletrhy                        = dnešní Výstavy / eventy
├─ Realizační firmy                = NOVÉ — správa realization_companies (dnes jen import Excelu)
│   └─ u firmy: rozměry tiskových ploch, slovník názvů, pravidla vyúčtování (pohledy)
├─ Slovníky a pravidla             = slovníky realizaček, aliasy ABF, pravidla (dnes v modulu vyúčtování)
├─ Uživatelé a oprávnění           = NOVÉ
└─ Historie změn                   = NOVÉ (audit_log, filtr podle entity a uživatele)
```

Pracovní moduly zůstávají v hlavní navigaci; „Katalog“ (zákaznický PDF výstup) je výstupní modul, ne administrace.

### 5.6 Pracovní moduly — bezpečné propojení

| Modul | Čte ze sdíleného jádra | Zapisuje | Poznámka |
|---|---|---|---|
| Generátor stánků | veletrhy, katalog, ceny, realizačky | `projects` | nahradit `realizationProfileId` odkazem na `realization_companies`; statické ID komponent převést přes aliasy |
| Technické rastry | veletrhy, katalog (jen symboly/legenda tech. služeb) | `technical_raster_projects` | **bez cenové logiky**; realizačka u stánku jako volitelný odkaz na `realization_companies` + zachovaný původní text |
| Tiskové plochy | veletrhy, realizačky | `print_surface_*` | import katalogu převést na upsert (K1) |
| Kontrola vyúčtování | veletrhy, realizačky, katalog | `settlement_*`, slovníky | po zavedení `realization_companies` přepnout měkkou referenci na FK |
| E-maily | veletrhy, uživatel (odesílatel) | `email_*` | vyplňovat `user_id` |
| Úkoly / Kalendář | veletrhy, realizačky, stánky, uživatelé (řešitel) | `tasks*` | `assignee_name` → `assignee_user_id` se zachovaným textem |

Vazby mezi moduly zůstávají přes ID (event, realizačka, komponenta, stánek, `source_type`/`source_id`), nikdy přes sdílení dokumentů.

### 5.7 Budoucí moduly

**Realizace a podklady**

- Potřebuje: veletrhy, realizačky, stánky (zde vzniká tabulka `event_stands`: event + normalizované číslo + firma vystavovatele), R2 a evidenci souborů, uživatele, audit.
- Lokální organizace souborů (`GRAFIKA/PODKLADY/<ČÍSLO STÁNKU> <FIRMA>/`): prohlížeč umí zapisovat do lokální složky jen přes File System Access API (Chrome/Edge, po výslovném povolení složky uživatelem). Pro hromadné třídění, sledování sdílených disků a práci s SKP doporučuji **malou Windows pomocnou aplikaci**, která volá stejné API s uživatelským tokenem. Rozhodnutí Q8.
- Realizační listy A4: generovat serverově/klientsky stejně jako dnešní PDF exporty (`lib/printSurfacePdf.ts`, `lib/presentationPdf.ts`), data čerpat z generátoru, tiskových ploch a rastrů přes ID stánku.

**Znalostní centrum / FAQ**

- Vlastní tabulky (`kb_articles`, `kb_revisions`, `kb_attachments`, `kb_checklists`), revize se stavem koncept → ke schválení → schváleno.
- Sdílí jen: uživatele a role (autor, schvalovatel), audit, R2 pro obrázky/přílohy, fulltext (Postgres `tsvector` s českou konfigurací — ověřit dostupnost slovníku, jinak `unaccent` + trigramy).
- Na pracovních modulech nezávisí; volitelné odkazy (článek ↔ komponenta / realizačka) jen jako tagy.
- Budoucí AI vyhledávání pouze nad **schválenými revizemi** (embeddingy v `pgvector`), s odkazem na zdrojový článek v každé odpovědi.

---

## 6. Konkrétní postup sjednocení bez ztráty dat

Obecný vzor pro každou evidenci:

1. **Inventura** — read-only SQL dotazy nad produkcí (počty, hodnoty ID, osiřelé reference). Výsledek do dokumentu, ne do DB.
2. **Expand** — nová tabulka/sloupec vedle staré, nic se nemaže.
3. **Převod** — idempotentní skript/migrace, která zachová původní hodnotu (např. `legacy_id`, `source_text`) a vypíše vše, co nešlo převést.
4. **Přepnutí čtení** — kód čte novou strukturu, stará zůstává jako záloha.
5. **Kontrola** — porovnávací dotaz staré vs. nové, ruční kontrola nejasných.
6. **Contract** — odstranění staré struktury až po samostatném schválení (vlastní batch).

Konkrétně:

- **Realizační firmy:** `realization_companies` založit se **stejnými ID** jako `print_surface_realization_companies` (slugy). Fiktivní `default`, `realization-2…4` převést mapovací tabulkou, kterou potvrdí člověk (Q5); hodnoty v `projects.document.realizationProfileId` a `pricing_entries.realization_company_id` přepsat až po potvrzení. Text u stánků rastrů nechat a doplnit volitelné `realizationCompanyId`.
- **Veletrhy:** inventura legacy ID v JSONB (`projects.document.fairId`, rastry, tiskové plochy); převod přes existující `LEGACY_EVENT_ID_ALIASES`; `data/fairs.ts` vyřadit z produkční cesty (jen dev seed).
- **Základní ceny:** porovnat `document.pricingEntries` s `pricing_entries` (bez price listu); rozdíly vypsat; konfliktní řešit ručně; pak číst jen z tabulky.
- **Statický katalog:** ke každému statickému ID (`chair-basic` …) přiřadit `catalog_items.id` (aliasy v `catalog_item_names` se `source = 'legacy_static_id'` nebo v `document`); generátor čte DB; staré projekty se při otevření mapují přes alias, dokument se přepisuje jen při uložení.
- **Názvy/mapování:** `catalog_item_names` rozšířit o zdroj; `catalog_mappings` nechat pro import (má jiný klíč — list + kategorie), jen ho zobrazit ve stejné administraci.

---

## 7. Implementační batche

Pořadí je záměrné: nejdřív zastavit ztrátu dat, pak identita uživatelů (na ní stojí audit i role), pak sjednocování evidencí.

| # | Batch | Obsah | Typ |
|---|---|---|---|
| **B0** | Inventura produkce (read-only) | `supabase migration list`; dotazy na počty a reference z kapitoly 6; zda se K1 už v produkci projevuje | ověření |
| **B1** | Oprava importu katalogu tiskových ploch (K1) | firmy/presety/rozměry přes upsert + smazání jen chybějících, které nikdo neodkazuje; celé v jedné Postgres funkci (transakce); validace těla požadavku; náhled „co se smaže“ | **kritická oprava** |
| **B2** | Uživatelé a session s identitou | `app_users`, přihlášení jménem/e-mailem, session s `userId` a možností odvolání, rate limit loginu; dočasně všichni Superadmin | **kritická** (bezpečnost) |
| **B3** | Role a oprávnění | `requirePermission` ve všech routách, matice rolí, správa uživatelů v administraci, test proti route bez kontroly; autor změn ze session | **kritická** |
| **B4** | Historie změn | `audit_log` + zápis z katalogu, cen, eventů, realizaček, pravidel; stránka Historie | důležité |
| **B5** | Realizační firmy | `realization_companies`, převod, správa v administraci, přepojení tiskových ploch/úkolů/vyúčtování, mapování fiktivních profilů | důležité |
| **B6** | Veletrhy | jediný zdroj (`events`), odstranění priority `data/fairs.ts`, převod legacy ID v dokumentech | důležité |
| **B7** | Ceny | jediný zdroj základních cen, sloučení Ceníky + Správa cen | důležité |
| **B8** | Statický katalog → DB | aliasy statických ID, generátor čte DB katalog | důležité, rizikové |
| **B9** | Jednotné číslo stánku + názvy | jedna normalizace stánku pro všechny moduly; `catalog_item_names` se zdrojem | důležité |
| **B10** | Administrace a routing | sekce Administrace s vlastními URL; vyčlenění modulů z `BoothGenerator.tsx` po jednom | údržba |
| **B11** | CI a testy | GitHub Actions (typecheck, test, build), automatické vyhledání testů místo ručního seznamu | údržba |
| **B12+** | Realizace a podklady; Znalostní centrum | až po B2–B5 | nové moduly |

Kontrola vyúčtování (batch 1) je hotová v kódu; před B5 doporučuji ji commitnout a aplikovat její migraci, aby B5 počítal i s jejími tabulkami.

---

## 8. Rizika batchů a doporučené ověření

| Batch | Hlavní riziko | Ověření před nasazením |
|---|---|---|
| B0 | žádné (jen čtení) — pozor jen na spuštění dotazů s právem zápisu | dotazy spouštět read-only rolí nebo v SQL editoru bez DML |
| B1 | upsert změní chování importu (firma, která z Excelu zmizí, zůstane) | test na kopii DB s projektem tiskových ploch a úkolem s realizačkou; porovnat počty před/po; náhled smazání |
| B2 | uzamčení všech uživatelů, ztráta přístupu | zachovat dočasně staré heslo jako nouzový přístup Superadmina; feature flag; test přihlášení/odhlášení/odvolání |
| B3 | route bez oprávnění nebo naopak zablokovaný běžný tok | automatický test všech rout; seznam akcí po rolích odsouhlasit předem; nasazení nejdřív s logováním odmítnutí místo blokování |
| B4 | zpomalení zápisů, citlivá data v historii | audit jen změněných polí; nezapisovat nákupní ceny do souhrnu pro role bez práva |
| B5 | rozpojení vazeb tiskových ploch, úkolů a vyúčtování | stejná ID jako dnes; porovnávací dotaz počtu vazeb před/po; mapování fiktivních profilů jen po ručním potvrzení |
| B6 | staré projekty se otevřou bez veletrhu | převod jen přes zdokumentované aliasy; seznam neznámých ID k ručnímu řešení |
| B7 | jiné ceny v generátoru a zákaznickém katalogu | report rozdílů obou zdrojů před přepnutím; kontrola vzorku projektů (součty před/po) |
| B8 | změna vzhledu/ceny uložených projektů | snapshot test: vybrané uložené projekty vykreslit a spočítat před a po; dokument přepisovat jen při uložení |
| B9 | sloučení dvou různých stánků (např. `3A38` a `3A38a`) | tabulka všech čísel stánků a jejich klíčů z produkce před přepnutím |
| B10 | regrese v UI | po jednom modulu, existující testy + ruční průchod |
| B11 | nízké | — |

Pro každý batch s migrací: nejdřív na kopii produkční DB (Supabase branch nebo lokální `supabase start` s dumpem), záloha před aplikací, migrace výhradně aditivní, kontrakce vždy samostatně.

---

## 9. Kritické opravy vs. kosmetika

**Kritické (řešit nejdřív):**
- K1 — import katalogu tiskových ploch (blokace importu / tichá ztráta vazeb úkolů / prázdný katalog při chybě). → B1
- K2 — chybějící identita, role a důvěryhodný autor změn; neomezený login; neodvolatelné session. → B2, B3

**Důležité (nekonzistence, budoucí chyby):**
- D1 čtyři evidence realizačních firem → B5
- D2 statické veletrhy s prioritou nad DB, legacy ID → B6
- D3 statický katalog vedle DB → B8
- D4 dva zdroje základních cen → B7
- D5 tři mechanismy mapování názvů → B9
- D6 dvě normalizace čísla stánku → B9
- D7 vícekrokové zápisy bez transakce → postupně v B1, B4, B5
- D8 neznámý stav migrací v produkci → B0

**Kosmetické / údržba:**
- monolit `BoothGenerator.tsx` → B10
- ruční seznam testů, chybějící CI → B11
- kódování dokumentace a datových souborů, úklid `git status`

---

## 10. Otázky k rozhodnutí před implementací

1. **Přihlašování:** Supabase Auth (pozvánky, reset hesla e-mailem), nebo vlastní tabulka uživatelů? Je k dispozici firemní Microsoft 365 a chcete SSO (souvisí i s Outlook koncepty v E-mailech)?
2. **Role:** platí matice v 5.3? Má Technik mazat jen vlastní záznamy? Kdo smí aktivovat pravidla vyúčtování a spouštět importy?
3. **RLS:** stačí vynucení oprávnění na serveru (service-role + deny-all RLS), nebo chcete skutečné RLS policy s JWT uživatele alespoň pro citlivé tabulky?
4. **Nákupní ceny:** kdo je smí vidět? (dnes je vidí každý přihlášený v Správě cen)
5. **Realizační firmy:** co znamenají fiktivní profily `default`, `realization-2…4` v uložených projektech a cenících — jsou to skutečné firmy, nebo je lze zahodit?
6. **Import Excelu tiskových ploch:** má firma, která z Excelu zmizí, zůstat (deaktivovaná), nebo se smazat, pokud na ni nic neodkazuje?
7. **Veletrhy:** jsou `international-2026` a další statické záznamy v `data/fairs.ts` ještě potřeba?
8. **Realizace a podklady:** stačí práce v prohlížeči (Chrome/Edge, File System Access API), nebo je cílem lokální Windows aplikace pracující se sdíleným diskem?
9. **Znalostní centrum:** kdo schvaluje články; má být část obsahu viditelná i pro roli Prohlížení?
10. **Provoz:** je produkční databáze jen jedna (bez staging)? Lze pro ověřování migrací používat Supabase branching nebo kopii DB?
11. **Kontrola vyúčtování:** commitnout a aplikovat migraci `20261013120000` před B5, nebo počkat na sjednocení realizačních firem?
