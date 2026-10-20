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
