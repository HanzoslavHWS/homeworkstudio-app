# V1-DATA — Rozhodovací report A1–A15 (a nové body A16–A21)

Stav k 2026-10-19, větev `develop`. Navazuje na `docs/V1_DATA_ARCHITECTURE.md`, hlavně na oddíl 8. **Jen návrh, nic není implementováno.** Neběžely žádné migrace ani importy a nic nebylo commitnuto.

Zdroje důkazů: kód a migrace v repozitáři, `_IMPORT/rozmery_tisk_1_0.xlsx`, `_IMPORT/realizacky.pdf` (ABF sestava „Stavby – tisk vše katalog“, FOR DECOR & PRESENT 2026 podzim) a git historie. **Produkční databáze se nečetla**, protože k tomu není povolení. Kde rozhodnutí závisí na produkčních datech, je to uvedeno.

---

## 0. Souhrn

| # | Téma | Stav | Doporučení v jedné větě | Blokuje |
|---|---|---|---|---|
| A1 | Stánky E/K, kóje vs. `KIT` | ✅ potvrzeno | `BOOTH` používá řádky a pravidla kompletu, `KIT` slouží ostatním sestavám | 04 |
| A2 | Mapování starých ID realizaček | ⛔ neschváleno | `default` → „neurčeno“ (žádná firma), `realization-2..4` → neurčeno, dokud je produkce nepotvrdí; podrobně v oddílu 2 | seed mapování v 02, ne strukturu 02 |
| A3 | Kurz EUR a zaokrouhlení | ✅ potvrzeno (nastavitelné, verzované) | Zbývá výchozí krok a směr: nahoru na 1 EUR | 05 |
| A4 | Záporný rozdíl u náhrady | otevřené | Nedobropisovat (0), výjimku lze povolit u konkrétní náhrady | 04 |
| A5 | Neměnnost publikovaných verzí | otevřené | Ano, pravidla viz oddíl 1.4 | 05 |
| A6 | Mazání hodnoty přes Excel | otevřené | Prázdná buňka = beze změny, mazání značkou `#SMAZAT` | 08 |
| A7 | Aliasy | otevřené | Jedna tabulka `catalog_item_aliases`, vyúčtování si ponechá frontu návrhů | 03 |
| A8 | Generátorový kód | otevřené | Výchozí = ABF kód, vlastní kód jen bez ABF kódu | 03 |
| A9 | Název tabulky firem | otevřené | Zachovat `print_surface_realization_companies` + pohled `realization_companies` | **02** |
| A10 | Kdy fixovat ceny | ✅ potvrzeno | Snapshot při vydání nabídky a při potvrzení objednávky | 07 |
| A11 | Rozsah ceníku elektřiny | otevřené | Jen podle veletrhu, jen služby elektřiny | 05, 06 |
| A12 | Varianty | otevřené | Vzorník v tabulkách, cena přes `price_item_id` (M01/M02) | 04 |
| A13 | Legacy ceny | otevřené | Zmrazit jen pro čtení | 05 |
| A14 | Komplet v kompletu | otevřené | Ve v1.0 zakázat | 04 |
| A15 | Pořadí batchů | otevřené | 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 | vše |
| A16 | Volné textové řádky kompletu | **nové** | Povolit, bez vlastní ceny | 04 |
| A17 | Grafika v ceně kóje vs. účtovaná | **nové** | Allowance s limitem, přesah se účtuje | 04, 07 |
| A18 | Platnost publikované verze (`valid_to`) | **nové** | Platnost se odvozuje od následující verze, publikovaná se nemění | 05 |
| A19 | Ceny doobjednávek | **nové** | Cena z připnuté verze projektu, přecenění jen výslovně | 07 |
| A20 | Příplatek za pozdní objednávku | **nové** | Mimo v1.0, jen připravit pravidlo | 07 (nebo později) |
| A21 | Macík = MAC Praha? | **nové** | Potvrdit, že jde o jednu firmu | 03 (aliasy) |

**Pro start V1-DATA-02 stačí:** A9, A15 a principiální souhlas s tím, že tabulka `realization_company_legacy_ids` vznikne prázdná. Samotné hodnoty A2 se doplní později jedním insertem bez další migrace (oddíl 2.4).

---

## 1. Rozhodnutí A1–A15

### A1 — Typové stánky E/K a kóje ✅ potvrzeno
- **Otázka:** Mají být typové stánky a kóje (mají geometrii) typu `BOOTH` s řádky kompletu, nebo samostatné karty `KIT`?
- **Možnosti:** (a) `BOOTH` + řádky kompletu, `KIT` pro sestavy bez geometrie; (b) všechno `KIT`, geometrie zvlášť; (c) `BOOTH` bez obsahu, ke každému stánku zvláštní `KIT`.
- **Potvrzeno:** (a). `BOOTH` používá obsah i pravidla kompletu (řádky, náhrady, varianty, allowance grafiky). `KIT` zůstává samostatným typem pro ostatní sestavy, třeba balíček nábytku nebo sadu elektro.
- **Dopad na DB:** `catalog_item_package_items.package_item_id` smí ukazovat na `BOOTH` i `KIT` (kontrola triggerem nebo `check` přes funkci). `item_type` dostane hodnotu `KIT`.
- **Dopad na moduly:** Jeden výpočet kompletu (`pricePackage` rozšířený o náhrady) pro oba typy. Stávající `BoothType.packageContents` z `data/booths.ts` se převede na řádky kompletu.
- **Blokuje:** V1-DATA-04 (dnes rozhodnuto, nic nečeká).

### A2 — Mapování starých ID realizaček ⛔ neschváleno
- **Otázka:** Na které kanonické firmy (`creativ-expo`, `gendai`, `macik`) převést staré `default`, `realization-2`, `realization-3` a `realization-4`?
- **Možnosti a důkazy:** podrobná tabulka je v **oddílu 2**.
- **Doporučení (změna proti původnímu návrhu):** `default` **nemapovat na Creativ Expo**, ale na „neurčeno“ (NULL). `realization-2..4` také na „neurčeno“, dokud čtení produkce neukáže, že je někdo použil. Mapování `default → creativ-expo` z původního návrhu by změnilo výrobní rozměry tiskových ploch u všech starších projektů (oddíl 2.3).
- **Dopad na DB:** jen obsah tabulky `realization_company_legacy_ids` (`realization_company_id` bude nullable, NULL = neurčeno). Struktura se rozhodnutím nemění.
- **Dopad na moduly:** `resolveRealizationCompanyId` v generátoru, produkčních rozměrech (`domain/production.ts`, `resolveProductionPrintSurface`), legacy cenících a kartě veletrhu.
- **Blokuje:** jen seed mapování a převod `events.document.realizationCompanyId` → `event_realization_companies` (M9, batch 06). Strukturu batch 02 neblokuje.

### A3 — Kurz EUR a zaokrouhlení ✅ potvrzeno (nastavitelné, verzované)
- **Otázka:** Jak se odvozuje EUR cena z CZK?
- **Potvrzeno:** Kurz, směr a krok zaokrouhlení jsou nastavitelné a uložené v každé verzi ceníku (`price_list_versions.eur_rate`, `eur_rounding_mode`, `eur_rounding_step`). U položky lze EUR cenu zafixovat (`eur_mode = fixed`).
- **Zbývá potvrdit výchozí hodnoty nové verze:** návrh je zaokrouhlení nahoru (`ceil`) na celé euro (`1`). Kurz se nepředvyplňuje, je povinný při publikaci verze, která obsahuje řádek s `derived`.
- **Zaokrouhluje se** jednotková cena, ne celkový součet. Součet = součet zaokrouhlených řádků. Doplatky (`price_list_surcharges`) se zaokrouhlují stejným pravidlem.
- **Dopad na DB:** sloupce verze (M8) a pohled `price_list_entries_resolved`. Snapshot ukládá výslednou EUR cenu, ne vzorec.
- **Dopad na moduly:** `resolvePrice`, katalog pro zákazníka (PDF), kalkulace, export.
- **Blokuje:** V1-DATA-05; výchozí hodnoty stačí potvrdit do jeho začátku.

### A4 — Záporný rozdíl ceny při náhradě
- **Otázka:** Když je náhrada levnější než původní komponenta (pravidlo `price_difference`), vzniká dobropis?
- **Možnosti:** (a) nikdy, doplatek = 0; (b) vždy dobropis; (c) výchozí 0 a dobropis povolený u konkrétní náhrady.
- **Doporučení:** (c). Sloupec `difference_floor_zero` má výchozí hodnotu `true`.
- **Dopad na DB:** jeden sloupec v `catalog_kit_line_substitutes` (M7).
- **Dopad na moduly:** výpočet kompletu, snapshot (řádek nese i nulový doplatek s důvodem `floor_zero`, aby bylo vidět proč).
- **Blokuje:** V1-DATA-04.

### A5 — Neměnnost publikovaných cenových verzí
- **Otázka:** Smí se publikovaná verze ceníku upravit?
- **Možnosti:** (a) ne, oprava jen novou verzí; (b) ano s auditem; (c) opravy jen do určitého okamžiku (např. před první nabídkou).
- **Doporučení:** (a). Úplná pravidla jsou v oddílu 3.4. Pohodlí zajistí akce „Vytvořit opravnou verzi“.
- **Dopad na DB:** triggery na `price_list_versions`, `price_list_entries`, `price_list_surcharges`; publikace jen přes RPC `publish_price_list_version`.
- **Dopad na moduly:** administrace cen (nové endpointy), import cen jen do `draft`.
- **Blokuje:** V1-DATA-05.

### A6 — Mazání hodnoty přes Excel
- **Otázka:** Jak v Excelu smazat hodnotu, když prázdná buňka znamená „beze změny“?
- **Možnosti:** (a) značka `#SMAZAT`; (b) zvláštní sloupec „smazat pole“; (c) prázdná buňka maže.
- **Doporučení:** (a). Varianta (c) je nebezpečná: export do Excelu, vymazání sloupce a import by tiše smazaly data.
- **Dopad na DB:** žádný (logika importu, záznam v `import_rows.changes`).
- **Dopad na moduly:** import/export, šablony, návod v modulu Podpora.
- **Blokuje:** V1-DATA-08.

### A7 — Aliasy
- **Otázka:** Jedno místo pro aliasy názvů a kódů (obecné i podle firem)?
- **Možnosti:** (a) jedna tabulka `catalog_item_aliases`, vyúčtování do ní při potvrzení zapisuje; (b) aliasy zůstanou rozdělené (`catalog_item_names` + `settlement_vendor_mappings`).
- **Doporučení:** (a). Fronta návrhů (`suggested`, `unclear`) zůstává ve vyúčtování.
- **Dopad na DB:** M5. `catalog_item_names` se zmrazí na čtení, `settlement_vendor_mappings` zůstane jako fronta.
- **Dopad na moduly:** vyúčtování (potvrzení mapování), import ABF kódů, administrace katalogu.
- **Blokuje:** V1-DATA-03 (aliasy podle firem potřebují kanonické firmy z 02, tedy A9 a pro Macík i A21).

### A8 — Generátorový kód
- **Otázka:** Jak naplnit `internal_code` (generátorový kód)?
- **Možnosti:** (a) výchozí = ABF kód, vlastní kód jen bez ABF kódu; (b) vždy vlastní řada; (c) jen ABF kód.
- **Doporučení:** (a). Interní komponenty bez ABF kódu dostanou vlastní kód.
- **Dopad na DB:** žádná nová struktura; unikátnost `internal_code` už existuje.
- **Dopad na moduly:** import KODY, Excel (identita řádku `id` → `generator_code` → `abf_code`), generátor (`internalCode` ve scéně).
- **Blokuje:** V1-DATA-03.

### A9 — Název tabulky realizačních firem
- **Otázka:** Fyzicky přejmenovat `print_surface_realization_companies`, nebo ji zachovat?
- **Možnosti:** (a) zachovat a přidat pohled `realization_companies`; (b) přejmenovat tabulku (ALTER RENAME + úprava FK a kódu); (c) nová tabulka a převod dat.
- **Doporučení:** (a). Žádné riziko pro FK z `tasks` a `print_surface_projects` ani pro textové vazby vyúčtování.
- **Dopad na DB:** M3 (sloupce + pohled).
- **Dopad na moduly:** repozitáře firem, administrace tiskových ploch, úkoly a vyúčtování (beze změny dotazů).
- **Blokuje:** **V1-DATA-02.**

### A10 — Kdy fixovat ceny projektu ✅ potvrzeno
- **Potvrzeno:** cenový snapshot při vydání nabídky (`reason = offer`) a při potvrzení objednávky (`reason = order`). Další pravidla (změny projektu, doobjednávky) jsou v oddílu 3.5 a A19.
- **Otevřené zůstává:** hromadné zpětné zafixování produkčních projektů. Bude součástí plánu pro produkci, ne v1.0 v DEV.
- **Dopad na DB:** M10 + `projects.document.pricingPin` (schéma projektu 5 → 6).
- **Dopad na moduly:** generátor (PricingBar), kalkulace, exporty, budoucí nabídky a objednávky.
- **Blokuje:** V1-DATA-07.

### A11 — Rozsah výjimek ceníku elektřiny
- **Otázka:** Podle čeho se liší ceny elektřiny a co smí ceník elektřiny obsahovat?
- **Možnosti:** (a) jen podle veletrhu; (b) podle veletrhu a realizačky; (c) libovolné položky v ceníku veletrhu.
- **Doporučení:** (a). Ceník elektřiny obsahuje jen služby elektřiny (dnes kódy řady L). Kontrola při publikaci, ne constraintem, aby šla rozšířit.
- **Dopad na DB:** `price_lists.kind = electricity`, `events.electricity_price_list_id` (M8, M9).
- **Dopad na moduly:** `domain/technicalServices.ts`, karta veletrhu.
- **Blokuje:** V1-DATA-05 a 06.

### A12 — Varianty
- **Otázka:** Jsou barvy koberců a povrchy samostatné karty, nebo varianty ve vzorníku?
- **Možnosti:** (a) vzorník (`catalog_variant_sets`, `catalog_variants`) s `price_item_id`; (b) karta pro každou barvu.
- **Doporučení:** (a). Šedá → M01, ostatní barvy → M02. `legacy_finish_id` zachová `carpetFinishId` starších projektů.
- **Dopad na DB:** M6, `variant_id` v cenících a řádcích kompletu.
- **Dopad na moduly:** generátor (výběr barvy), 3D textury, výpočet náhrady varianty.
- **Blokuje:** V1-DATA-04.

### A13 — Legacy `pricing_entries` a `document.pricingEntries`
- **Otázka:** Co se starými cenami?
- **Možnosti:** (a) zmrazit (jen čtení), nové ceny jen v nových cenících; (b) převést hned; (c) udržovat oba modely.
- **Doporučení:** (a). Převod je samostatný krok V1-DATA-10.
- **Dopad na DB:** `price_lists.kind = legacy`, staré endpointy jen pro čtení.
- **Dopad na moduly:** administrace cen, `selectPricingEntry` jako záložní cesta v `resolvePrice`.
- **Blokuje:** V1-DATA-05.

### A14 — Komplet v kompletu
- **Doporučení:** ve v1.0 zakázat (kontrola v triggeru i v importu). Kóje nesmí obsahovat `KIT` ani jiný `BOOTH`.
- **Dopad na DB:** trigger v M7.
- **Dopad na moduly:** editor kompletu a import kompletů.
- **Blokuje:** V1-DATA-04.

### A15 — Pořadí batchů
- **Doporučení:** 02 firmy → 03 identita katalogu → 04 komplety a varianty → 05 ceníky → 06 karta veletrhu → 07 generátor a snapshot → 08 Excel a Podpora → 09 vzorová sada. Batch 05 lze vyvíjet souběžně s 04, ale doplatky z 05 potřebují náhrady z 04.
- **Blokuje:** všechny batche.

---

## 2. A2 — Mapovací tabulka starých ID realizaček

### 2.1 Kanonické firmy, které dnes existují

| Kanonické ID | Odkud ID vzniká | Názvy z reálných podkladů |
|---|---|---|
| `creativ-expo` | slug záhlaví „Creativ Expo“ v `rozmery_tisk_1_0.xlsx` | „CREATIV EXPO, s.r.o.“ (ABF `R:`), „Creative Expo s.r.o.“ (alias v `domain/technicalRasterRealization.ts`), vyúčtování FOR BEAUTY 2026 (`creativ_stavby.xlsx`) |
| `gendai` | záhlaví „Gendai“ | „GENDAI, s.r.o.“ (ABF `R:`) |
| `macik` | záhlaví „Macík“ | v Excelu jen „Macík“; v ABF sestavách „MAC Praha, spol. s r.o.“, viz A21 |

ABF sestava `realizacky.pdf` (FOR DECOR & PRESENT 2026 podzim) uvádí v poli `R:` 10× CREATIV EXPO, 1× GENDAI a 1× MAC Praha. Technické rastry navíc znají realizačky mimo katalog (Elseya, Agentura M-S-P), které spadají do skupiny OSTATNÍ.

### 2.2 Stará ID: kde se používají a jaké mají důkazy

| Staré ID | Kde se dnes zapisuje / čte | Důkaz o skutečné firmě |
|---|---|---|
| `default` | Výchozí `realizationProfileId` každého nového projektu (`domain/project.ts:411`), `realizationCompanyId` veletrhů beauty a decor a ceníků v `data/organizations.ts`, výchozí volba v administraci veletrhu (`CatalogManagementPages.tsx`) | **Žádný.** Název „Default“. Ve výrobní logice znamená „bez přepisu, výrobní rozměr = kanonický“ (`domain/models.ts:164`, `domain/technicalServices.ts:523`) |
| `realization-2` | Volba v generátoru (`BoothGenerator.tsx:3158`), testy s ukázkovými spadávkami | **Žádný.** Název „Realizačka 2“, zavedeno 2026-08-10/11 (commity 081e6a1, 7b0e927) s komentářem „Placeholder names … for later replacement“ (`data/realizationProfiles.ts`) |
| `realization-3` | Volba v generátoru, testy | **Žádný**, stejně jako výše |
| `realization-4` | Volba v generátoru, testy | **Žádný**, stejně jako výše |

Klíče `productionProfiles` ve statických seedech komponent jsou všude prázdné (`productionProfiles: {}`), takže z repozitáře žádná firma na staré ID navázaná není. **Neznámé:** zda produkční projekty mají uložené `realization-2..4`, zda produkční karty katalogu mají v `document.productionProfiles` klíče a jaké `realizationCompanyId` mají produkční veletrhy a ceníky. Zjistí se jen čtením produkce.

### 2.3 Možná přiřazení a hodnocení

| Staré ID | Možná nová identita | Pro | Proti | Hodnocení |
|---|---|---|---|---|
| `default` | **NULL (neurčeno)** | Odpovídá dnešnímu významu (kanonické rozměry, bez přepisu); nemění chování starých projektů | Veletrh beauty/decor ztratí výchozí realizačku, je potřeba ji nastavit ručně | ✅ **doporučeno** |
| `default` | `creativ-expo` | Nejčastější realizačka v ABF sestavě (10/12); vyúčtování FOR BEAUTY 2026 je pro Creativ | `default` je výchozí hodnota **každého** projektu, i těch, které stavěl Gendai nebo MAC. Pokud by se výrobní rozměry začaly brát podle firmy, změnily by se u všech starších projektů (Creativ má např. Panel_S_100 950 × 2340 mm místo kanonického rozměru) | ❌ nedoporučeno jako mapování ID; Creativ Expo přiřadit veletrhu výslovně (viz níže) |
| `realization-2` | `gendai` / `macik` / `creativ-expo` | — | Pořadí sloupců v Excelu (Creativ, Gendai, Macík) není důkaz; jména jsou zástupná | ❌ bez důkazu nemapovat |
| `realization-2..4` | **NULL (neurčeno)** | Bezpečné, dokumenty projektů se nepřepisují, mapování půjde doplnit později | Pokud je někdo v produkci vědomě použil pro konkrétní firmu, ztratí se ta informace do potvrzení | ✅ **doporučeno do čtení produkce** |
| `realization-N` použité v produkci | firma podle projektu | — | Jedno staré ID mohlo znamenat v různých projektech různé firmy | rozhodnout po čtení produkce, případně po projektech (viz 2.4) |

**Veletrhy zvlášť:** u `beauty` a `decor` doporučuji místo převodu `default` zapsat do `event_realization_companies` výslovně `creativ-expo` s rolí `construction` a `is_default = true`. Důkaz: vyúčtování FOR BEAUTY podzim 2026 je od Creativ Expo a v ABF sestavě FOR DECOR podzim 2026 převažuje Creativ Expo. Je to zápis nových dat, ne převod starého ID, a vyžaduje váš souhlas (patří k batchi 06).

### 2.4 Jak to udělat bez rizika
1. M3 vytvoří `realization_company_legacy_ids` se sloupcem `realization_company_id` **nullable** a se sloupci `status` (`unmapped`, `confirmed`) a `evidence text`. Seed vloží čtyři řádky se `status = unmapped`.
2. Resolver vrací pro `unmapped` / NULL „neurčeno“ = dnešní chování (kanonické rozměry). Nic se tedy nezmění, dokud mapování nepotvrdíte.
3. Po povolení čtení produkce proběhne **jen čtecí** dotaz: počet projektů podle `realizationProfileId`, klíče `productionProfiles` v kartách, `realizationCompanyId` veletrhů a ceníků. Výsledek doplní tuto tabulku.
4. Potvrzené mapování se zapíše jedním `update` (bez migrace). Pokud se jedno staré ID používalo pro víc firem, přidá se volitelná tabulka výjimek podle projektu (`project_id` → firma), ale jen když to data ukážou.

---

## 3. Doplnění analýzy

### 3.1 Opakovaný výskyt stejné komponenty v kompletu
**Dnes:** `catalog_item_package_items` má unikátnost (`package_item_id`, `child_item_id`), takže stejná karta nemůže být v kompletu dvakrát.

**Návrh:**
- Identita řádku = (`package_item_id`, `line_key`). `line_key` je stabilní a čitelný (`koberec`, `stena-zadni`, `stena-bocni-l`) a nemění se, když se mění komponenta.
- Stejná komponenta smí být na více řádcích, pokud se řádky liší účelem: jiná pozice, jiná varianta, jiná sada povolených náhrad nebo jiná allowance. Pokud se liší jen množstvím, má být jeden řádek, což import ohlásí jako varování.
- **Náhrady se váží k řádku, ne ke komponentě.** Náhrada zadní stěny tedy nemění boční stěnu, i když jde o stejnou kartu.
- **Cena:** každý řádek se počítá zvlášť (množství × cena, doplatek náhrady). V nabídce lze řádky stejné karty a varianty sloučit jen pro zobrazení. Snapshot ukládá řádky s `line_key`.
- **Výroba a objednávky:** sumarizace podle karty + varianty (sečtou se řádky).
- **Excel:** list `Komplety` má klíč (`komplet`, `line_key`). Dva řádky se stejným `line_key` jsou konflikt.
- **Migrace (M7):** stávající řádky dostanou `line_key` z kódu komponenty, protože jsou dnes unikátní podle komponenty. Teprve potom se změní unikátnost.

### 3.2 Volné textové položky kompletu (nový bod A16)
**Proč:** obsah kóje dnes obsahuje řádky, které nejsou kartou katalogu (např. „Stavba stánku“ v `data/booths.ts`, `kind: construction`). ABF sestavy mají u stánků volné poznámky („6.7. doobjednáno emailem“, „UZAMYKATELNÝ !!!“).

**Návrh:**
- Nový sloupec `line_kind`: `item` (dnešní, s `child_item_id`) nebo `text`. U `text` je `child_item_id` NULL a povinný je `label` (CZ), volitelně `label_en`, `quantity`, `unit_code` a `note`.
- **Textový řádek nemá vlastní cenu** a je vždy `included_in_package = true`. Nemůže mít náhrady, varianty ani allowance. Pokud má něco vlastní cenu nebo se má nahrazovat, musí to být karta (typ `INTERNAL_COMPONENT` nebo `SERVICE`).
- Check constraint: `line_kind = 'item'` ⇔ `child_item_id is not null`.
- Zobrazení: v nabídce a v obsahu kompletu ano, ve výrobních sumách ne (nejsou to komponenty).
- Poznámky k projektu nebo stánku (jako v ABF sestavě) do kompletu **nepatří**. Jsou to poznámky projektu a mají vlastní modul.
- **Alternativa:** textové řádky zakázat a pro každý vytvořit `INTERNAL_COMPONENT`. Nedoporučuji, katalog by se zaplnil kartami bez ceny a geometrie.

### 3.3 Grafika v ceně kóje vs. dodatečně účtovaná grafika (nový bod A17)
**Dnes:** P86 má `print-allowance` „Grafika na límec“ 2 bm, `printSurfaceId: fascia-print`, `includedInBasePrice: true`. `boothIncludesPrintSurface` vrací jen ano/ne podle ID plochy a **množství ignoruje**.

**Návrh: tři stavy každé tiskové plochy projektu**

| Stav | Kdy | Cena | Uloží se |
|---|---|---|---|
| `included_in_kit` | Plocha spadá do `print_allowance` řádku kompletu a vejde se do limitu | 0, řádek je vidět s poznámkou „v ceně kóje“ | `includeInCalculation = false`, důvod `included_in_kit`, odkaz na `line_key` |
| `kit_overflow` | Plocha spadá do allowance, ale překračuje limit (`maxRunningM`, `maxAreaM2`) | Jen přesah, podle ceny typu grafiky | Rozdělí se na část v ceně a část účtovanou, obě s odkazem na `line_key` |
| `charged` | Plocha mimo allowance (jiná plocha, jiný typ nebo grafika navíc) | Plná cena podle ceníku | `includeInCalculation = true`, důvod `extra` |

Doplňující pravidla:
- Allowance určuje **co** (`surfaceIds`, `typeIds`) a **kolik** (`maxRunningM`, `maxAreaM2`, případně `maxCount`). Prázdný limit = celá plocha v ceně.
- **Upgrade grafiky** (jiný materiál nebo typ tisku než ten v ceně) je náhrada na řádku grafiky s pravidlem `price_difference`, ne nová plocha.
- Limit se počítá z **kanonických** rozměrů (návrhové plochy), ne z výrobních rozměrů se spadávkou, aby se cena neměnila podle realizačky.
- Grafika navíc objednaná až po objednávce je doobjednávka (oddíl 3.5).
- Snapshot ukládá ke každé ploše stav, množství v ceně a účtované množství.
- **Rozhodnout (A17):** zda se přesah účtuje (doporučeno), nebo se plocha nad limit považuje za celou účtovanou.

### 3.4 Neměnnost publikovaných cenových verzí (rozpracování A5, nový bod A18)

| Objekt | `draft` | `published` | `archived` |
|---|---|---|---|
| Hlavička verze (kurz, zaokrouhlení, `valid_from`, poznámka) | upravitelná | **zamčená** | zamčená |
| Řádky cen a doplatky | přidat, upravit, smazat | **zamčené**, nelze přidat ani smazat | zamčené |
| Smazání verze | ano | **ne** | ne |
| Přechody stavu | → `published` (jen RPC) | → `archived` | — |

- **Platnost (A18):** doporučuji, aby publikovaná verze neměla upravitelné `valid_to`. Platnost končí `valid_from` následující publikované verze téhož ceníku a vypočte ji pohled. Publikace nové verze tak nemusí měnit starou. Alternativa: RPC smí `valid_to` jednou zkrátit (jediná povolená změna, zalogovaná).
- Publikace ověří: kurz vyplněný, pokud existuje řádek `derived`; žádný řádek `fixed` bez CZK ceny; žádné překrytí; existující odkazované karty a varianty.
- Archivace verzi nezneplatní pro projekty, které ji mají připnutou. Archivovaná verze jen nejde vybrat pro nové projekty.
- **Mimo ceník:** složení kompletu (řádky, náhrady) **verzované není**. Úprava kompletu proto nezmění zafixované nabídky (snapshot nese rozpad), ale u nezafixovaných projektů se projeví hned. Pro v1.0 doporučuji: změna kompletu použitého v projektu se zafixovanou nabídkou zobrazí varování. Verzování kompletů zatím nezavádět, rozhodnout se dá později.
- Trigger neměnnosti nesmí blokovat `on delete` u odkazovaných karet. Karty se stejně nemažou (existující trigger), jen archivují.

### 3.5 Zachování cen při změnách projektu a doobjednávkách (rozpracování A10, nové body A19, A20)

**Základ:**
- `pricingPin` (verze základního ceníku a ceníku elektřiny) se nastaví při prvním snapshotu `offer` a nemění se bez výslovného přecenění.
- Každý řádek projektu má stabilní `projectLineId` (scéna už má ID objektů, technické služby a plochy také). Podle něj se porovnávají snapshoty.

| Situace | Cena existujících řádků | Cena nových řádků | Snapshot |
|---|---|---|---|
| Úprava projektu před nabídkou | živý výpočet (aktuální verze), „nezafixováno“ | živý výpočet | žádný |
| Změna po nabídce, před objednávkou | z připnuté verze (stejná jako v nabídce) | z **připnuté** verze | nová nabídka = nový snapshot `offer` (revize) |
| Potvrzení objednávky | ze snapshotu poslední platné nabídky | — | `order` |
| Doobjednávka po objednávce (A19) | **beze změny** (objednané řádky jsou neměnné) | z připnuté verze, výchozí | `order_addition` s odkazem na rodičovský snapshot a jen s novými řádky (delta) |
| Výslovné přecenění | nová připnutá verze, nový snapshot | — | `offer` s `reason_note`. U objednaných řádků **nepovoleno** (jen storno a nová položka) |
| Odebrání objednané položky | — | — | `order_change` se záporným řádkem (storno). Pravidla storna rozhodnout zvlášť, ve v1.0 jen evidence |
| Nová verze ceníku publikovaná po nabídce | beze změny | beze změny (projekt má pin) | žádný; v UI upozornění „Je k dispozici novější ceník“ |
| Archivace ceníku nebo karty | beze změny | beze změny | žádný |

- **Příplatek za pozdní objednávku (A20):** veletrhy obvykle mají uzávěrky (`events.document` je zná), po kterých je cena vyšší. Doporučuji ve v1.0 neimplementovat, ale připravit pravidlo jako vlastnost veletrhu (`late_order_surcharge`: procento nebo samostatná verze ceníku od data). Bez rozhodnutí se doobjednávka účtuje cenou připnuté verze.
- `reason` snapshotu se rozšíří o `order_addition` a `order_change`. Snapshot dostane `parent_snapshot_id`.
- Kalkulace a exporty čtou součet `order` + všech `order_addition` / `order_change`.
- **Změna realizačky** v projektu cenu nemění (ceny nejsou podle realizačky, A11), mění jen výrobní rozměry.
- **Dopad na DB (M10):** `parent_snapshot_id`, rozšířený `reason`, `lines[].projectLineId`. Žádná další tabulka.
- **Dopad na moduly:** generátor (stav řádků „objednáno“ jen pro čtení cen), kalkulace, exporty, budoucí modul objednávek.
- **Blokuje:** V1-DATA-07.

### 3.6 Nové body ke schválení

| # | Rozhodnutí | Doporučení | Blokuje |
|---|---|---|---|
| A16 | Volné textové řádky kompletu | Povolit `line_kind = text`, bez ceny, vždy v ceně kompletu | 04 |
| A17 | Přesah grafiky nad allowance | Účtovat jen přesah; limit podle kanonických rozměrů | 04, 07 |
| A18 | Konec platnosti publikované verze | Odvodit od následující verze, `valid_to` neupravovat | 05 |
| A19 | Cena doobjednávek | Z připnuté verze projektu, objednané řádky neměnné, delta snapshot | 07 |
| A20 | Příplatek za pozdní objednávku | Ve v1.0 neimplementovat, jen připravit pravidlo u veletrhu | 07 / později |
| A21 | Macík = MAC Praha, spol. s r.o.? | Potvrdit. Pokud ano, `macik` dostane alias „MAC Praha“, a když ne, vznikne další firma | 03 |

---

## 4. Dopady doplnění na migrace (pro aktualizaci V1_DATA_ARCHITECTURE.md po schválení)

| Migrace | Změna oproti oddílu 2 architektury |
|---|---|
| M3 | `realization_company_legacy_ids.realization_company_id` nullable, sloupce `status`, `evidence`; seed 4 řádky `unmapped` |
| M7 | `line_kind`, `label`, `label_en`; `child_item_id` nullable s check constraint; allowance rozšířená o `maxCount` |
| M8 | Platnost verze počítaná pohledem (A18); trigger zakazuje i smazání publikované verze |
| M10 | `parent_snapshot_id`, `reason` + `order_addition`, `order_change`; v řádcích `projectLineId`, stav grafiky (`included_in_kit`, `kit_overflow`, `charged`) |

## 5. Co rozhodnout před zahájením V1-DATA-02

1. **A9:** zachovat `print_surface_realization_companies` + pohled `realization_companies`.
2. **A15:** pořadí batchů.
3. **A2, jen princip:** tabulka legacy ID vznikne se všemi čtyřmi ID ve stavu `unmapped` a dnešní chování se nezmění. Konkrétní mapování se doplní po čtení produkce.
4. **Povolení jen čtecího dotazu do produkce** pro A2 (oddíl 2.4, krok 3), pokud ho chcete mít před koncem batche 02. Není to podmínka startu.

## 6. Rozhodnutí při uzavření V1-DATA-03 (2026-10-20)

1. **Generátorový kód (A8):** po založení se nemění. Později přibude bezpečná administrátorská změna, která zachová všechny vazby (projekty, komplety, aliasy, mapování vyúčtování). Ve V1-DATA-03 se neimplementuje.
2. **Aliasy (A7):** historické tabulky (`catalog_item_names`, `settlement_vendor_mappings`) se budou postupně sjednocovat do `catalog_item_aliases`. Při ručním potvrzení párování ve vyúčtování půjde potvrzený název uložit jako alias konkrétní komponenty a realizačky. Konflikty se nikdy nepřepisují automaticky. Řeší navazující batch. Dnes vyúčtování aliasy z katalogu jen čte a jeho vlastní mapování mají vždy přednost (`withCatalogAliases`).
3. **Jednotky:** `m2/ak` se automaticky neslučuje s `m²`. Pozor: stávající `canonicalUnit` ve vyúčtování (`domain/settlementCheck.ts`) příponu `/ak`, `/akce` už dnes zahazuje, takže porovnání vyúčtování bere `m2/ak` jako `m2`. To se nemění bez ověření dopadu na historické kontroly. Návrh explicitních pravidel patří do navazujícího batche.
4. **Kombinované jednotky:** budou samostatné řádky `catalog_units` (`is_combined = true`). Převod na základní jednotku jen po schválení jeho významu. Rozlišovat jednotky pro účtování od jednotek fyzických rozměrů (mm na kartě).
5. **KIT v zákaznickém katalogu:** dnes se nenabízí (`CUSTOMER_CATALOG_ITEM_TYPES`). Publikace stejným schvalovacím mechanismem jako u ostatních produktů přijde ve V1-DATA-04.

## 7. V1-DATA-04 — schválená rozhodnutí a implementace (2026-10-20, DEV)

Schváleno: **A4** (záporný rozdíl se nedobropisuje, minimální doplatek je 0, slevy jsou samostatné rozhodnutí), **A12** (varianty ve vzorníku, M01 = šedý koberec, M02 = koberec jiné barvy, a navíc individuální příplatek každé barvy), **A14** (komplet v kompletu ve v1.0 zakázán), **A16** (volné textové položky), **A17** (účtuje se jen přesah grafiky).

Migrace `20261021130000_catalog_kits_variants.sql` (M6 + M7 v jednom souboru, aplikováno jen v DEV). Odchylky od návrhu v oddílu 1.3 architektury:
- `difference_floor_zero` nevznikl. Podle A4 platí nula jako dolní mez vždy a bez výjimky v datech.
- Vzorník nese u varianty i **pravidlo příplatku** (`surcharge_rule`: none / price_difference / per_unit / fixed + jednotka), aby dvě barvy se stejným ABF kódem (M02) mohly mít jiný příplatek. Částky v katalogu nejsou. Přijdou z cenových verzí V1-DATA-05 podle id varianty nebo náhrady.
- `print_allowance` je pole rozsahů `{surfaceTypeId?, printSurfaceIds?, unitCode: bm|m2|ks, includedQuantity}`. Typ plochy je z modulu Tiskové plochy (`PRINT_SURFACE_TYPES`), konkrétní plocha z generátoru (`fascia-print`).
- Celý obsah kompletu se ukládá jednou transakční funkcí `replace_catalog_kit_lines` (jen service_role). Řádky se párují podle `line_key` a ponechané řádky si drží své id.
- Zákaz komplet v kompletu hlídá doména i trigger, a to jen při zápisu. Případné starší vnořené řádky zůstávají, ale komplet s nimi nejde znovu uložit, dokud se neodeberou.

Doménová logika: `domain/catalogPackages.ts` (řádky, validace), `domain/catalogKitPricing.ts` (náhrady, varianty, doplatky přes cenový resolver), `domain/catalogKitPrintAllowance.ts` (zahrnutá grafika a přesah), `domain/catalogVariants.ts` (vzorníky). Generátor, výpočty existujících projektů a `BoothType.packageContents` se nemění. Napojení výpočtu kompletu do projektu a snapshotu patří do V1-DATA-07.

### 7.1 Kontrola starších vnořených kompletů před nasazením M7 mimo DEV

Produkce se v tomto kroku nečte ani nemění. Pravidlo A14 se kontroluje jen při zápisu. Případný starší řádek „stánek nebo komplet uvnitř kompletu“, případně řádek u karty, která není BOOTH ani KIT, proto migraci nezastaví, ale znemožní další uložení obsahu daného kompletu.

1. Až bude k produkci výslovně povolen čtecí přístup, spusťte tento dotaz. Funguje před migrací `20261021130000` i po ní:
   ```sql
   select line.id, owner.display_name as komplet, owner.item_type, child.display_name as polozka, child.item_type
   from catalog_item_package_items line
   join catalog_items owner on owner.id = line.package_item_id
   left join catalog_items child on child.id = line.child_item_id
   where owner.item_type not in ('BOOTH', 'KIT') or child.item_type in ('BOOTH', 'KIT');
   ```
2. Prázdný výsledek znamená, že A14 nic neblokuje. V DEV byl výsledek prázdný (2026-10-20).
3. U každého nalezeného řádku rozhodne uživatel, zda řádek odebrat, nebo vnořený stánek rozepsat na jeho komponenty. Nic se neopravuje automaticky.
4. Teprve potom smí jít migrace M7 dál než do DEV.

## 8. V1-DATA-05 — verzované ceníky (2026-10-22, DEV)

Schválená obchodní pravidla V1-DATA-05 mění tyto body plánu (oddíl 1.4 a M8/M9 architektury, A3, A11, A13, A18). Odchylky byly schváleny 2026-10-22 před implementací.

| Bod plánu | Nově | Proč |
|---|---|---|
| `resolvePrice` hledá verzi „platnou k datu“; M9 `events.base_price_list_id` (ceník) | Veletrh má **výslovně přiřazenou verzi** (`event_price_assignments`, základní a elektřina zvlášť, s historií). Resolver datum nezná | Datum konání nesmí přepnout ceník; zářijový veletrh smí mít verzi platnou do června; publikace nové verze nic nepřecení |
| A18: `valid_to` odvozené od další verze | `valid_from` / `valid_to` jsou **jen evidenční**, v konceptu upravitelné, publikací zamčené. Překryv je jen upozornění | Platnost nerozhoduje o ceně |
| M8: `price_lists.kind` | Nové tabulky `versioned_price_lists`, `price_list_versions`; legacy `price_lists` a `pricing_entries` beze změny | Pět legacy čtenářů vypisuje všechny `price_lists`; nákupní ceník se tam nesmí objevit |
| `purchase_czk` v řádku prodejní ceny | Samostatný nákupní ceník (`kind = purchase`), tabulka `purchase_price_entries`, vlastní API `/api/purchase-prices` a oprávnění `prices.purchase.*`; firmy přes `purchase_price_list_companies` (MVP: jeden aktivní nákupní ceník na firmu) | Oddělení nákupních a prodejních cen i oprávnění |
| `price_list_surcharges.substitute_id` → řádek náhrady | Doplatek náhrady je klíčovaný (komplet, `line_key`, náhradní položka, varianta); doplatek barvy podle `variant_id` | `replace_catalog_kit_lines` náhrady při každém uložení kompletu maže a vkládá znovu, jejich id nejsou stabilní |
| A11: elektřina = kódy řady L | `catalog_items.price_category` (`standard` / `electricity`). Jednorázově označeny SERVICE s ABF kódem L + 2 znaky. Ceník elektřiny smí obsahovat jen tuto kategorii (kontrola při publikaci). Chybí-li položka v ceníku elektřiny, použije se základní | Rozlišení kategorií, ne prefixem |
| `eur_mode`: derived / fixed / none | derived / **direct** (cena stanovená v EUR) / **manual** (ručně přepsaný přepočet, označený) / none | Odlišit cenu v EUR od ručního přepsání |
| A3: kurz se nepředvyplňuje | Výchozí kurz nové verze **24,17**, zaokrouhlení nahoru na 1 € (jednotková cena, ne součet) | Schválený testovací kurz |
| A13: zmrazit legacy | **Neprovedeno** ve V1-DATA-05; legacy ceníky a „Správa cen“ fungují beze změny | Mimo rozsah, změnilo by stávající administraci |

Implementace: migrace `20261022120000_price_list_versions.sql` (aplikováno jen v DEV), doména `domain/priceVersions.ts` (převod EUR, resolver bez data, adaptér pro `priceKit`, nákupní ceny, kontroly publikace), oprávnění `lib/auth/permissions.ts` (dnes jedno přihlášení = všechna oprávnění; uživatelské role zatím neexistují), API `lib/priceVersions/priceVersionsApi.server.ts`, stránka Administrace → **Ceníky (verze)**. Publikovaná verze je neměnná na úrovni triggerů; publikace jen RPC `publish_price_list_version`. Generátor, kalkulace a tiskové plochy dál počítají ze starých ceníků — napojení a snapshot patří do V1-DATA-07; výsledek resolveru už nese původ (verze, řádek, kurz, ruční cena) pro snapshot.

Zkušební data v DEV (nearchivovat, pro společné testování): firmy Creativ Expo, Gendai, MAC Praha; veletrh `zkusebni-v1-data-05` (15.–18. 9. 2026); ceníky `ZKUSEBNI-ZAKLADNI` (v1 publikována a přiřazena, platnost 1–6/2026; v2 publikována s kurzem 25, nepřiřazena; v3 koncept), `ZKUSEBNI-ELEKTRINA` (v1 přiřazena), `ZKUSEBNI-NAKUP` (v1, navázány tři firmy).

### 8.1 Oprava: tři prodejní ceny v jedné verzi (2026-10-22)

Každá položka (a každý doplatek) má v jedné verzi prodejního ceníku **současně** tři ceny:

| Cena | Význam | Uloženo |
|---|---|---|
| CZK | pevná cena v Kč | `sale_czk` |
| EUR_SK | přepočet CZK kurzem verze, zaokrouhlení nahoru na 1 € (nebo ruční přepsání, označené) | `eur_mode` = `derived` / `manual`, ruční hodnota v `sale_eur` |
| EUR_WORLD | samostatná pevná cena v EUR, nezávislá na kurzu | `sale_eur_world` (nové) |

- Nabídka/projekt si režim **volí výslovně** (`priceTrack` = `CZK` / `EUR_SK` / `EUR_WORLD`); neodvozuje se ze země ani z měny. API výpočtu bez režimu vrátí chybu.
- Změna CZK nebo kurzu v konceptu mění jen EUR_SK, nikdy EUR_WORLD. Ruční EUR_SK kurz nemění.
- Publikace vyžaduje u každé pevné ceny i doplatku všechny tři hodnoty.
- Migrace `20261022130000_price_list_versions_eur_world.sql` jen přidává sloupce a nahrazuje tři funkce; žádný existující (ani publikovaný) řádek nepřepisuje. Starší řádky s `eur_mode = direct` se čtou jako EUR_WORLD = jejich EUR cena a EUR_SK = přepočet z CZK; kopie do nové verze je převede do nového tvaru. Publikované v1/v2 zkušebního ceníku EUR_WORLD nemají, proto v tomto režimu vrací „k nacenění“.
- Příprava Excelu (V1-DATA-08): `domain/priceVersionExcel.ts` — sloupce `price_czk`, `price_eur_sk` (jen pro čtení), `price_eur_sk_manual`, `price_eur_world`; prázdná buňka = beze změny, `#SMAZAT` maže. Hromadný import zatím neimplementován.

### 8.2 Ochrana souběžných úprav a bezpečné automatické testy (2026-10-22)

- **Optimistic concurrency:** `price_list_versions.revision` (migrace `20261022140000_price_list_versions_revision.sql`, jen nový sloupec, žádný řádek cen se nemění). Každý zápis do verze uvádí revizi, ze které vychází: uložení obsahu konceptu (prodejní i nákupní), hlavička, smazání, publikace, archivace a kopie **konceptu** (publikovaná verze se měnit nemůže). Kontrola probíhá v databázi pod zámkem řádku (`price_list_version_lock`, SQLSTATE `P0409`) ve stejné transakci jako zápis; API ji navíc ověří předem a vrátí 409 `{ conflict: true, currentRevision }`. Zápis bez revize je odmítnut. Staré podpisy funkcí bez revize byly zrušeny (jen funkce, ne data).
- **Přiřazení veletrhu:** klient posílá přiřazení, které viděl (`expectedCurrentVersionId`); jiné aktuální přiřazení = konflikt.
- **Editor:** při konfliktu se nic neuloží, rozpracované hodnoty zůstanou zobrazené a nabídne se „Načíst aktuální stav“. Akce verze (publikovat, kopírovat, smazat) jsou zablokované, dokud editor drží neuložené řádky.
- **Smazání konceptu**, ze kterého vychází jiná verze, je odmítnuto srozumitelnou zprávou.
- **Pokrytí cenových režimů:** registr nese ke každé verzi počet položek a doplatků bez CZK / EUR_SK / EUR_WORLD. Tabulka verzí i přiřazení veletrhu na neúplný režim upozorní; cena v něm je „k nacenění“, nic se nedopočítává ani nepřevádí z CZK.
- **Automatické testy proti DEV** (`npm run test:price-versions-e2e`): jen DEV a lokální server; pracují výhradně ve vyhrazeném neaktivním ceníku `E2E-AUTOTEST`, jen s koncepty označenými ID běhu, nic nepublikují ani nepřiřazují a koncepty v `finally` smažou (nejdřív kopie). Zápis do jiné verze skript odmítne. Ručně připravená data (ZKUŠEBNÍ ceníky, veletrh) skripty bez výslovného povolení nemění.
- **Tabulky cen (zobrazení):** prvním sloupcem je kód z katalogové karty — ABF kód, u interní položky bez něj generátorový kód (označený „gen.“). Do ceníku se kód neukládá. Hledání podle kódu i názvu, řazení podle kódu (přirozeně, L2 < L10) nebo názvu. Výpočty ani datový model se nemění.

## 9. V1-DATA-06 — Administrace veletrhů (2026-10-22, DEV)

Schváleno 2026-10-22. Migrace `20261022150000_events_admin.sql` (jen přidávající, aplikována jen v DEV; otisk existujících veletrhů před a po migraci shodný).

- **Realizační firmy veletrhu** (`event_realization_companies`): role stavba / grafika–tisk / elektro / ostatní, více firem v roli, nejvýš jedna výchozí na roli. Firmy ze skutečné evidence (V1-DATA-02). Výchozí firma je jen návrh: předvyplní se u nového úkolu ze stánku, existující úkoly ani stánky nemění. Odebraná vazba se deaktivuje, nemaže.
- **Historické `realizationCompanyId`** v dokumentu veletrhu zůstává beze změny pro staré cenové výpočty (do V1-DATA-07) a karta ho zobrazuje odděleně jen pro čtení. `default` = „neurčeno“, nikdy se nepřevádí na Creativ ani jinou firmu. Nový veletrh už `default` nedostává.
- **Kód veletrhu** (`events.short_code`, např. `BEAUTY-2026-P`): volitelný, unikátní, oddělený od názvu i cest na disku; po uložení neměnný (trigger; řízená změna je budoucí postup). Existujícím veletrhům se nedoplňuje.
- **Uzávěrky:** současné zůstávají; volné uzávěrky mají volitelný typ (objednávky, návrhy/schválení, grafika, elektro/technické služby, ostatní) a určení interní/zákaznická. Každá uzávěrka má stabilní odkaz (`builtin:materialData`, `builtin:designApproval`, `deadline:<id>`) pro budoucí automatické úkoly; automatizace není implementována.
- **Ceníky v kartě veletrhu:** správa přiřazení publikovaných verzí přes existující API V1-DATA-05 (historie, ochrana souběhu, upozornění na neúplné cenové režimy). Staré ceníky zůstávají v kartě jako „Starší ceníky (generátor, do V1-DATA-07)“.
- **Složky na disku** (`event_path_mappings`, role podle specifikace Organizeru, oddíl 1): hlavní složka, pracovní složka stánků, výstupní složka realizaček a volitelně další role. Absolutní (`P:\…`), UNC (`\server\share\…`) i relativní k hlavní složce; zakázané `..`, znaky a rezervované názvy Windows. Jen metadata — aplikace na disk nepřistupuje. **Samostatná tabulka místo `events.document`**, protože dokument veletrhu putuje do mnoha modulů (interní cesty mají zůstat jen v administraci, spec. oddíl 9) a budoucí Organizer bude moci zapisovat stav dostupnosti cest bez kolize s úpravou karty.
- **Souběh:** firmy a cesty mají společné počítadlo `events.config_revision` (409 při změně jinde, nic se nezapíše); karta (dokument) nově ukládá proti revizi, se kterou byla načtena (dříve vyhrával poslední zápis).
- **Veletrh nelze smazat** (trigger), jen deaktivovat.
- **Automatické testy proti DEV** (`npm run test:event-admin-e2e`) zapisují jen do vyhrazeného neaktivního veletrhu `e2e-autotest` a jeho nastavení na konci vrátí do prázdného stavu; ostatní veletrhy jen čtou.
- Mimo rozsah: modul Zakázky, Organizer, kopírování/synchronizace souborů, automatické úkoly.

### 9.1 Úpravy po ručním testu (2026-10-22)

- **Realizační firmy: jeden seznam bez rolí.** Firma, která stánek realizuje, zajišťuje i jeho grafiku a zapojení elektřiny uvnitř stánku; hlavní přívod elektřiny zajišťuje areál (PVA) podle technického rastru. Veletrh má proto jeden seznam firem a jednu volitelnou výchozí realizačku (jen předvyplnění nového úkolu, nikdy automatické přiřazení stánků). Migrace `20261022160000_event_realization_single_list.sql` nic nemaže: případné aktivní firmy z jiných rolí přenese do seznamu (i s výchozí volbou, pokud seznam žádnou neměl), původní řádky ponechá jako neaktivní historii a od té doby smí být aktivní jen seznam. Historické `realizationCompanyId` zůstává beze změny do V1-DATA-07.
- **Složky: režim Standard HomeworkStudio / Vlastní nastavení.** Standard = kořenová složka + přesně `00_DOKUMENTY`, `01_STAVBY`, `02_GRAFIKA_AKCE`, `03_PODKLADY_REALIZACEK`, `04_RASTRY`, `05_KOBERCE_AKCE`, `06_SJETINY`, `07_VYDANA_OBJEDNAVKA`, `08_VYUCTOVANI` (ukládají se jako výslovné relativní cesty). Vlastní = relativní i úplné cesty; **prázdná podsložka = kořenová složka** (neukládá se). **Prázdný kořen = nenakonfigurováno** (bez kořene nelze uložit žádnou podsložku; žádný disk se nedoplňuje). Režim se neukládá zvlášť — odvozuje se z uložených hodnot, takže karta vždy ukazuje skutečný stav a staré veletrhy se nepřepisují. Přepnutí na Standard s vlastními hodnotami vyžaduje potvrzení a projeví se až uložením. Aplikace složky nevytváří.

## 10. V1-DATA-07 — Integrace generátoru, ceníků, kompletů a projektů (schváleno 2026-10-23)

**Schválená pravidla (podklad pro 07-B2 až 07-D):**
- Publikovaná verze ceníku přiřazená veletrhu je pevný cenový základ; žádné automatické přeceňování podle novější verze. Projekt si verzi **připne výslovně při aktivaci nového cenového modelu**, nikdy vedlejším efektem čtení či výpočtu. Snapshoty nabídek a objednávek se nikdy nepřepočítávají.
- Individuální cena zákazníka = ruční přepsání konkrétní položky projektu, nikdy úprava centrálního ceníku.
- Komplety: zahrnuté položky se neúčtují podruhé; množství navíc se účtuje jen nad rámec kompletu; odebrání zahrnuté položky ani levnější varianta nevytváří automatický dobropis (případná sleva = ruční cena); dražší náhrada může mít definovaný příplatek; grafika v kompletu se odečítá jen od stejného typu a kompatibilní jednotky.
- Grafika: jediný obchodní zdroj účtování je společný cenový výpočet projektu; modul Tiskové plochy dodává plochy a množství. Stejná plocha na více pohledech se účtuje jednou. Plochy v m² se **zaokrouhlují nahoru na celé m²** (jednotka účtování a chování seskupených ploch se přesně zdokumentuje v 07-C2); límec v bm. Polep pultu je samostatný typ grafiky se stejnou cenou za m² jako celopolep panelů.
- Individuální stánky: ocenění podle evidovaných komponent a ruční cena; žádné automatické oceňování geometrie z 3D.
- Testovací data DEV jen izolovaně a označená „ZKUŠEBNÍ V1-DATA-07“; zahrnutá grafika věcně správně (u řádku grafiky, ne u židle).

### 10.1 07-B1 — Sjednocení cenového výpočtu projektu
- `domain/projectPricing.ts` — `priceProjectLegacy()` je jediný výpočet ceny projektu. Používá ho lišta cen v editoru, zákaznická kalkulace (náhled i PDF tiskem), souhrn projektu, ZIP balíček a e-mailový draft.
- Pravidla a částky jsou **beze změny** proti dosavadní zákaznické kalkulaci (ověřeno testem proti zmrazené kopii výpočtu z `ff1e358`). Mění se jen vykazování řádku: `priced` (i skutečná 0), `included` (v ceně stánku), `missing` („K nacenění“ — nikdy jako 0, nezapočítává se), `not_billed` (technický bod; cena je v řádku technické služby), `manual` (rezervováno pro 07-B3).
- Každý řádek má stabilní klíč (`booth:<id>`, `scene:<definitionId>`, `service:<itemId>`) pro budoucí ruční ceny a snapshoty a uvádí původ ceny (`source.model = legacy`).
- Žádná migrace, žádné schéma v6, žádné změny uložených projektů.
- Neúplná kalkulace (chybí-li cena aspoň u jedné položky): lišta ukazuje „MEZISOUČET — NEÚPLNÉ“, kalkulace štítek „NEÚPLNÁ KALKULACE“ a „Mezisoučet oceněných položek“, souhrn „Cena — neúplná“. Tisk zákaznické kalkulace jen potvrdí upozornění (bez blokace, bez schvalování); interní výstupy beze změny.
- Individuální stánek je v editoru jen lešení pracovní plochy (`createIndividualBooth`), nikoli položka ceny: nevytváří řádek stánku ani „K nacenění“ (dosavadní chování; lišta „DLE KOMPONENT“).
- Ruční test v DEV: projekt „ZKUŠEBNÍ V1-DATA-07-B1“ (`npm run seed:pricing-b1-project`, bez `--reset` nic nepřepisuje).

**Známé legacy chování ponechané beze změny (k řešení v 07-C / úklid):** úklid individuálního stánku bere plochu z **pracovní plochy editoru** (výchozí 10 × 10 m = 100 m²), ne ze skutečného pozemku (např. 3 × 3 m). Nejde o uložený údaj, množství se počítá při každém ocenění. Dokud úklid nemá sazbu, částka se neovlivní (řádek je „K nacenění“); se sazbou by byl předražen. Oprava = počítat plochu z pozemku (polygon / `individualWidthMm × individualDepthMm`), samostatně a s vlastním testem.
