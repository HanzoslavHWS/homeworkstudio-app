# Technické rastry — import technických výjezdů z Excelu (.xlsx)

Pracovní dokument hotfixu pro prozatímní WEB verzi (větev `hotfix/raster-excel-import` z `master`, 29. 10. 2026).
Rozsah: jen import technických služeb do Technických rastrů. PDF import zůstává, katalog komponent a XML se neřeší.

## 1. Současný PDF import (zachován; jediná změna: opakované hlavičky stránek, viz 4.)

1. `TechnicalServiceImportPanel.tsx` — uživatel zvolí kategorii a PDF; PDF se zpracuje **v prohlížeči** (`loadPdfDocument` → `extractPdfTextItems`).
2. Parser kategorie (`domain/technicalReportParsers/*`) → `buildParsedTechnicalReport(category, items)`:
   - `parseGenericStandTable(items)` — rekonstrukce tabulky z pozic textu (hlavička = sloupce, řádek se zápisem čísla stánku = data, ostatní řádky = poznámky);
   - `buildParsedTechnicalReportFromTable(category, table)` — **společná část nezávislá na formátu**: množství (`evaluateNumericCellValue`), nejednoznačné složené hodnoty → varování, poznámky, „BEZ“ u elektřiny.
3. Náhled importu → `handleConfirmImport` (`TechnicalRasterEditorPage.tsx`): nahrání souboru jako asset `technical-raster-import` (R2), záznam `TechnicalRasterImport` a `mergeTechnicalRasterImportWithDiff` (párování podle čísla stánku, inkrementální reimport).
4. Uložení projektu: tabulka `technical_raster_projects` (importy jsou součástí dat projektu) — **bez změny schématu DB**.

Původní soubor importu se po uložení už nikdy znovu neotevírá (jen archiv) — uložit tam .xlsx nic nerozbije.

## 2. Základ (nezávislý na podobě vzorových souborů)

| Soubor | Účel |
|---|---|
| `domain/technicalReportParsers/technicalReportParser.ts` | `buildParsedTechnicalReportFromTable` vyčleněno z `buildParsedTechnicalReport` (čistý refaktor, PDF výstup identický — test). Excel bude plnit stejnou `GenericTableParseResult` → stejný `ParsedTechnicalReport` → stejné párování. |
| `domain/technicalReportWorkbook.ts` | Model sešitu bez knihovny: všechny listy v pořadí (i skryté), typované buňky, souhrn listů, kontrola nejednoznačností. |
| `lib/import/technicalReportWorkbookReader.server.ts` | Adaptér exceljs; znovu používá `readWorkbookFromBufferTolerant` (makra se nespouští, tolerance VML). |
| `tests/technicalReportWorkbook*.test.ts`, `tests/technicalReportParsers.test.ts` | Testy (syntetické sešity, žádná reálná data v Gitu). |

### Proč vlastní čtení buněk místo `extractSheetGrid`

Prázdná buňka znamená u výjezdu „neobjednáno“ (= 0). `extractSheetGrid` (ceníky, tiskové plochy) ale:
- chybu Excelu (`#REF!`, `#N/A`) a vzorec bez uložené hodnoty vrací jako `null` → tiše by z nich byla nula;
- u sloučených buněk opakuje hodnotu ve všech buňkách oblasti → množství by se započítalo vícekrát (ověřeno testem).

Proto má každá buňka s neznámou hodnotou vlastní druh (`error`, `formulaWithoutResult`, `mergedContinuation`, `unsupported`) a `technicalWorkbookCellRawText` ji **odmítne převést na text**. `extractSheetGrid` zůstává beze změny.

### Kontroly (`auditTechnicalWorkbook`)

Nad celým sešitem, bez ohledu na mapování: žádný list / žádná data, prázdný list, skrytý list/řádek/sloupec s daty, sloučené oblasti, chybové buňky, vzorce bez hodnoty, nepodporovaný obsah, list nad limitem (5000 řádků × 200 sloupců → `truncated`, nikdy tiše zkrácený).

## 3. Analýza vzorů (FOR BEAUTY 2026, 29. 10. 2026)

Vzory: `_IMPORT/TEST_TECHNICKYCH_VYJEZDU/FOR_BEAUTY_2026/{PDF,EXCEL,CSV}` — elektřina, internet, voda, úklid (odpad nebyl objednán). Mimo Git.

### Struktura Excelu (všechny 4 typy stejná)

- Jeden list `List1`, žádné sloučené buňky, skryté řádky/sloupce, vzorce ani chyby; množství jsou číselné buňky (i nuly).
- Úvod: titul („Přehled - …“), „Firma:“, „Zakázka:“, „Výraz:“, „Třídění: … stánku …“ (pozor — obsahuje slovo „stánku“, není to hlavička).
- Hlavička: buňka „Stánek“ (elektřina) / „Číslo stánku“, 1–3 řádky nad sebou (internet má „Pevná IP“/„Internet“/„WIFI“ na třetím řádku).
- Řádek stánku: číslo stánku (sloupec C, u elektřiny D), firma, pak jedna číselná buňka na službu.
- Skupiny/součty: „** Sekce: 3A“, „HALA 3“, „** SEKTOR 3A“, „** Mezisoučet…“, „Celkem:“, patička „Výtisk sestavil(a)…“.
- **Hlavička a hodnoty nejsou ve stejném sloupci** (voda: hlavičky I/J/L, hodnoty H/J/K; elektřina: hodnota O leží přesně mezi hlavičkami N a P). Stabilní je jen **pořadí** — počet sloupců s hodnotami = počet služeb v hlavičce.
- „Celkem“ u internetu má součet sloupce N ve sloupci O; u elektřiny je „Celkem“ zalomené do dvou řádků (první polovina v řádku bez popisu).
- Úklid: řádek pořadatele (Denní úklid 18) **bez čísla stánku** a za ním poznámka o doobjednávce úklidu.

### Porovnání formátů (stánek po stánku, `npm run test:technical-raster-excel-real`)

| Typ | Stánky Excel / PDF | Služby Excel / PDF | „BEZ“ | Rozdíly | Součet vs. „Celkem“ |
|---|---|---|---|---|---|
| Elektřina (17 služeb) | 186 / 186 | 163 / 163 | 46 / 46 | 0 | souhlasí |
| Internet (8 služeb) | 44 / 44 | 55 / 55 | — | 0 | souhlasí |
| Voda (3 služby) | 3 / 3 | 4 / 4 | — | 0 | souhlasí |
| Úklid (2 služby) | 36 / 36 | 36 / 36 | — | 0 | souhlasí (vč. řádku bez stánku) |

Názvy služeb z Excelu jsou znak po znaku shodné s PDF → párování na produkty a export beze změny.

Co Excel dává navíc oproti PDF:
- PDF při zalomení stránky přidá opakovanou hlavičku jako falešnou „poznámku“ k poslednímu stánku na stránce (elektřina 3A48, 3C13, 4B10; internet 4B33). Excel je jedna souvislá tabulka — tento problém nemá. *(Opraveno v PDF parseru — viz níže.)*
- PDF řádek bez čísla stánku (úklid, 18 ks) a jeho poznámku tiše zahodí; Excel je nahlásí.
- Excel umožňuje kontrolu proti řádku „Celkem“.

### CSV (jen analýza — neimplementováno, nedoporučeno)

- Kódování: UTF-8 BOM, ale obsah je **Windows-1250** (ř = 0xF8) — běžné čtení jako UTF-8 rozbije diakritiku.
- **Neescapované uvozovky**: název firmy s uvozovkou uvnitř (stánek 4B07, tvar `,,Název, něco" s.r.o.`) rozbije CSV — dalších 48 řádků elektřiny splyne do jedné buňky.
- CSV je stránkový export jako PDF (elektřina 4 strany): opakované hlavičky a patičky, **na každé straně jinak posunuté sloupce** (číslo stánku jednou ve 4., jindy ve 3. sloupci).
- Excel nese stejná data bez těchto vad → CSV jako třetí formát nepřináší nic, jen riziko. UI CSV odmítne se srozumitelnou hláškou.

## 4. Implementace Excel importu

| Soubor | Co dělá |
|---|---|
| `domain/technicalReportExcelTable.ts` | List sešitu → `GenericTableParseResult` (stejný jako z PDF) → `buildParsedTechnicalReportFromTable` → `ParsedTechnicalReport`. Hlavička podle „Stánek“/„Číslo stánku“, služby párované se sloupci hodnot **podle pořadí** a jen při shodném počtu (jinak se nic neimportuje a hlásí se rozdíl), kontrolní report (`TechnicalExcelImportCheck`). |
| `app/api/technical-rasters/import-excel/route.ts` | Jen parsování (přihlášení, kategorie, soubor) — nic neukládá. Vrací `report`, `check`, `detectedCategory`. |
| `TechnicalServiceImportPanel.tsx` | Přijme PDF i .xlsx; PDF cesta beze změny; .xlsx → route; CSV/.xls → hláška. |
| `TechnicalExcelImportCheckSummary.tsx`, `TechnicalRasterEditorPage.tsx` | V náhledu blok „Kontrola Excelu“ (list, mapování sloupců, výsledek součtů); `parserVersion` `xlsx-v1` u Excelu. |
| `domain/assets.ts` | `technical-raster-import` povoluje i xlsx MIME. |
| `scripts/technicalRasterExcelRealDiagnostic.ts` | Lokální porovnání Excel × PDF na reálných souborech (skip-safe, mimo `npm test`). |

Upozornění v náhledu (s listem, řádkem a buňkou): řádek s množstvím bez čísla stánku, nepřiřaditelná poznámka, neznámá hodnota buňky (chyba Excelu, vzorec bez hodnoty, sloučená buňka) — nikdy jako 0, text/záporné/necelé množství, nesoulad s „Celkem“, stánek vícekrát, nesoulad počtu sloupců, další listy s daty, skryté řádky/sloupce a sloučené buňky v datech.

Testy: `tests/technicalReportExcelTable.test.ts`, `tests/technicalReportExcelImportRoute.test.ts` na anonymizovaných kopiích přesného rozložení buněk vzorů (`tests/technicalReportExcelFixtures.ts`).

### Oprava PDF: opakované hlavičky stránek

`parseGenericStandTable` přeskočí řádek, který je textově shodný s rozpoznanou hlavičkou (obě řádky dvouřádkové hlavičky). Reálné vzory: elektřina 6 → 0 falešných poznámek, internet 2 → 0; stánky, služby a množství beze změny. Skutečná poznámka (i když zmiňuje název sloupce) zůstává. Regresní testy v `tests/technicalReportTableParsing.test.ts`.

### Ověření v prohlížeči (lokálně, 29. 10. 2026)

`next dev` bez `.env` (žádné Supabase ani R2), jen dočasné lokální heslo/session; Chrome přes playwright-core ze scratchpadu. API projektů a katalogu nahrazeno v testu pamětí prohlížeče (nic se nikam nezapisuje); Excel parsování šlo přes skutečnou route.

| Ověřeno | Výsledek |
|---|---|
| Excel import 4 typů | náhled: 186/163, 44/55, 3/4, 36/36 (stánky/služby); Kontrola Excelu se sloupci a „součty souhlasí“; úklid 2 upozornění |
| PDF import 4 typů | stejné počty, bez bloku Kontrola Excelu, bez falešných poznámek |
| Uložení importu (simulovaný úspěšný upload) | `parserVersion` `xlsx-v1`, MIME xlsx, 186 stánků / 163 služeb v projektu |
| PDF stejného přehledu jako aktualizace Excelu | „Beze změny 163, Nové 0, Změna množství 0“ — formáty jsou zaměnitelné |
| Poznámka (upravená kopie Excelu ve scratchpadu) | náhled, uložený stánek i detail stánku (sekce POZNÁMKA) |
| Párování s katalogem | sloučený projekt z PDF a z Excelu identický (prázdný i ukázkový mapping); mapování produktů je dnes záměrně prázdné → všude „Neznámý produkt“, symboly bez fallbacku |
| Chyba R2 (skutečná presign route bez R2 → 503) | projekt se nezměnil, nic se neuložilo, náhled zůstal otevřený. **Opraveno:** chyba se dřív zapsala jen do kroku „Rastr“ (na kroku Technické služby se nic nestalo) — nyní je hláška přímo v náhledu, tlačítko se během uploadu zablokuje |
| Chyba uložení projektu (server 500) | uložený projekt beze změny, UI ukáže „Chyba ukládání“ |

Neověřeno lokálně: skutečný upload do R2 a uložení do Supabase; rastrové plátno (PDF rastru FOR BEAUTY není mezi vzory).

### Po nasazení ověřit (produkce, testovací projekt)

1. Technické rastry → testovací projekt s rastrem haly → Technické služby → nahrát `.xlsx` elektřiny: náhled, Kontrola Excelu „součty souhlasí“.
2. Potvrdit import → v Historii importů nový záznam; stáhnout soubor importu (ověří uložení `.xlsx` do R2 s MIME xlsx — presign povoluje nový MIME).
3. Obnovit stránku → import a stánky zůstaly (uložení do Supabase).
4. Nahrát PDF stejného přehledu jako aktualizaci → „Beze změny“ u všech služeb, umístění zachována.
5. PDF import jiné kategorie beze změny funguje; u vícestránkového PDF žádné poznámky s textem hlavičky.
6. Kontrola, že stávající projekty se otevřou a jejich dřívější PDF importy jsou beze změny.

## 5. Bezpečnost nasazení

- Práce jen ve worktree `../homeworkstudio-app-web`; `develop` a jeho neuložené změny se nemění.
- Bez migrace, produkční DB se nemění.
- Hotfix větev se **nepushuje** (na `master` není `vercel.json`, push jiné větve by spustil Preview s neověřenými proměnnými). Po schválení: lokální merge do `master`, push `master` = produkční nasazení, návrat přes Vercel *Instant Rollback*.
- Potom cherry-pick do `develop` (rozdíl v modulu Technických rastrů mezi `master` a `develop` je jen `domain/technicalRasterRealization.ts`; konflikt možný v `domain/assets.ts`, kde má `develop` neuložené změny).
- Pozn. k worktree: globální `core.autocrlf=true` vytvořil soubory s CRLF a ~40 testů čtoucích zdrojový kód pak selhalo; soubory jsou znovu vytvořené s LF (bez změny Git konfigurace).
