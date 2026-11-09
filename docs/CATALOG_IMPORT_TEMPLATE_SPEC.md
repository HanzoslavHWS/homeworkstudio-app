# Specifikace importní Excel šablony katalogu — Generator_ABF v1.0

| | |
|---|---|
| Zdrojový commit | `4cbf644` (větev `develop`) |
| Datová základna | kód v tomto commitu + DEV `wpbivmobbqcqmyehunog` (jen čtení, 2026-11-04) |
| Strojově čitelná podoba | [CATALOG_IMPORT_TEMPLATE_SCHEMA.json](CATALOG_IMPORT_TEMPLATE_SCHEMA.json) — vygenerováno jednorázově přímo z doménových konstant tohoto commitu a z DEV (jen čtení); tabulky v tomto dokumentu jsou z něj vykreslené. Finální generátor šablony bude číst stejné konstanty (6.6). |
| Stav | Podklad pro finální šablonu. Importér katalogu z Excelu **zatím neexistuje** (plánovaná etapa V1-DATA-08). |
| Dosavadní `Generator_ABF_Importni_sablona_v1.xlsx` | V repozitáři ani v dokumentech uživatele se nenašel. Tato specifikace na něm nestaví. |

Navazuje na schválený návrh v [V1_DATA_ARCHITECTURE.md, oddíl 6](V1_DATA_ARCHITECTURE.md) a rozhodnutí A6, A14, A16 v [V1_DATA_DECISIONS.md](V1_DATA_DECISIONS.md). Kde se tento dokument od nich liší, je to výslovně uvedeno.

Relevantní zdrojové soubory:

| Oblast | Soubor |
|---|---|
| Pole podle typu karty (definice pro admin i budoucí Excel) | [domain/catalogItemFields.ts](../domain/catalogItemFields.ts) |
| Typy karet, druhy, ABF/generátorové kódy, kolize kódů | [domain/catalogItemTypes.ts](../domain/catalogItemTypes.ts) |
| Založení a úprava karty (whitelist polí, validace) | [domain/catalogItemsAdmin.ts](../domain/catalogItemsAdmin.ts), [lib/db/catalogItemsAdmin.supabase.ts](../lib/db/catalogItemsAdmin.supabase.ts) |
| Druh komponenty → Kategorie, povolené druhy | [domain/catalogClassification.ts](../domain/catalogClassification.ts), registr `catalog_categories` |
| Pravidla aktivace (Lifecycle) | [domain/catalogReadiness.ts](../domain/catalogReadiness.ts), [domain/graphicsPricingUnit.ts](../domain/graphicsPricingUnit.ts) |
| Jednotky | [domain/catalogUnits.ts](../domain/catalogUnits.ts), tabulka `catalog_units` |
| Komplety, řádky, náhrady | [domain/catalogPackages.ts](../domain/catalogPackages.ts), [domain/catalogKitPricing.ts](../domain/catalogKitPricing.ts), [domain/catalogKitPrintAllowance.ts](../domain/catalogKitPrintAllowance.ts) |
| Vzorníky a varianty | [domain/catalogVariants.ts](../domain/catalogVariants.ts) |
| Aliasy realizačních firem | [domain/catalogItemAliases.ts](../domain/catalogItemAliases.ts) |
| Parametry (systémové / doporučené / vlastní) | [domain/catalogParameters.ts](../domain/catalogParameters.ts) |
| Soubory (fotky, GLB, SKP, PDF) | [domain/assets.ts](../domain/assets.ts), [domain/catalogBatchUpload.ts](../domain/catalogBatchUpload.ts) |
| Verzované ceníky | [domain/priceVersions.ts](../domain/priceVersions.ts), [domain/priceVersionExcel.ts](../domain/priceVersionExcel.ts) |
| Dřívější import ABF kódů (KODY.xlsm) | odstraněn ve V1-ADMIN-01; data, která zapsal (`official_name`, `document.abfImport`, `import_batches`), zůstávají |

---

## 1. Typy karet a jejich pole

### 1.1 Podporované typy karet

| Typ karty | Český název | List šablony | Povolené interní druhy | Výchozí druh | ABF kód očekáván |
|---|---|---|---|---|---|
| PRODUCT | Produkt | Produkty | furniture, floor_finish, construction, other | furniture | ano |
| SERVICE | Služba | Sluzby | service, graphics_service, technical_point | service | ano |
| BOOTH | Stánek | Stanky | booth | booth | ano |
| INTERNAL_COMPONENT | Interní komponenta | InterniKomponenty | booth_component, construction, other | booth_component | ne |
| KIT | Komplet | Komplety | other | other | ano |

**Druh komponenty → Kategorie.** U pěti „druhů komponenty“ (Produkt, Grafika, Technická služba, Interní komponenta, Technický bod) se typ karty a interní druh **odvozují z kategorie** (registr `catalog_categories`). U Stánku a Kompletu je kategorie volný štítek z pevného seznamu v kódu (oddíl 2.2) a server ji nekontroluje proti registru.

| Druh komponenty | Český název | Typ karty | Interní druhy |
|---|---|---|---|
| product | Produkt | PRODUCT | furniture, floor_finish, construction, other |
| graphics | Grafika | SERVICE | graphics_service |
| technical_service | Technická služba | SERVICE | service |
| internal_component | Interní komponenta | INTERNAL_COMPONENT | booth_component, construction, other |
| technical_point | Technický bod | SERVICE | technical_point |

### 1.2 Pole, která uživatel vyplňuje

Legenda povinnosti: **U** = nutné pro uložení (koncept), **A** = nutné pro aktivaci (Lifecycle), **P** = podmíněně, — = nepovinné.

| Klíč sloupce | Český název v UI | Datový model | Typ | Typy karet | U | A | Podmínka / výchozí / validace |
|---|---|---|---|---|---|---|---|
| `id` | ID (neměnit) | `catalog_items.id` | uuid | všechny | — | — | Jen export, import ho čte jako první klíč identity. Nikdy se nevyplňuje ručně. |
| `generator_code` | Generátorový kód (Interní / generátorový kód) | `catalog_items.internal_code` | text ≤ 64, `A–Z 0–9 . _ / + -` | všechny | P | P | **U** u Interní komponenty. **A** u Produktu (nábytek), Interní komponenty, `booth_component`. Unikátní bez ohledu na velikost písmen; nesmí se rovnat ABF kódu **jiné** karty. Existující kód se mění jen výslovně (kontrola použití v projektech). Výchozí při založení s ABF kódem: stejný jako ABF kód. |
| `abf_code` | ABF kód | `catalog_items.abf_code` | text ≤ 32, převod na velká písmena | všechny | — | — | Unikátní. Standardní tvar `písmeno + 2 znaky` (T04, M8A, L02), jiný tvar = varování. Interní komponenta ho obvykle nemá. |
| `display_name` | Interní název HomeworkStudio | `catalog_items.display_name` (+ `document.displayName`) | text | všechny | **U** | **A** | |
| `official_name` | Oficiální název ABF (CZ) | `catalog_items.official_name` | text | Produkt, Služba, Stánek, Komplet | — | — | U ABF karet ho dříve doplnil import KODY (odstraněn ve V1-ADMIN-01); dnes se upravuje na kartě nebo importem Excelu. |
| `official_name_en` | Oficiální název ABF (EN) | `catalog_items.official_name_en` | text | jako výše | — | — | |
| `item_type` | Typ karty | `catalog_items.item_type` | výčet (2.1) | všechny | **U** | — | V šabloně ho určuje **list**, ne sloupec. |
| `category` | Kategorie | `catalog_items.category` | id kategorie (2.2) | všechny | **U** | **A** | Druh komponenty: musí být v registru, patřit ke skupině typu karty, povolovat interní druh a při založení být **aktivní**. Stánek/Komplet: hodnota z pevného seznamu. |
| `usage` | Použití komponenty | `catalog_items.kind` | `booth_component` / `construction` | Interní komponenta | P | — | Povinné, když kategorie povoluje oba druhy (všech 6 interních kategorií v DEV). Jinak se druh odvodí z kategorie. |
| `unit_code` | Měrná jednotka | `catalog_items.unit_code` (+ `unit` = symbol) | kód jednotky (2.3) | všechny | — | P | **A** u nábytku, služby, `floor_finish`. Přijímá i zápisy z `acceptedSpellings` (m2 = m², kus = ks). Kombinované jednotky (ks/den) jsou odmítnuty. Grafika: jednotka musí odpovídat kategorii (Límec = bm, Celopolep a Polep pultu = m²), jinak aktivace neprojde. |
| `width_mm`, `depth_mm`, `height_mm` | Šířka / Hloubka / Výška (mm) | `document.widthMm/depthMm/heightMm` | číslo ≥ 0 | Produkt, Stánek, Interní komponenta | — | P | **A**: nábytek šířka + hloubka > 0; stánek všechny tři > 0. Interní `booth_component` je potřebuje pro nabídku v generátoru (ne pro aktivaci). |
| `color`, `material` | Barva, Materiál | `document.attributes.color/material` | text ≤ 200 | Produkt, Interní komponenta | — | — | Systémové parametry; nesmí se zadat jako vlastní parametr. |
| `show_2d`, `show_3d` | Použití v generátoru 2D / 3D | `document.showIn2D/showIn3D` | ANO/NE | nábytek, technický bod, `construction`, `other`, `booth_component`, služby, grafika | — | P | Nábytek a technický bod: **A** aspoň jedno ANO; 2D = vznikne obdélníkový půdorys; 3D = **A** nahraný GLB. U služeb jen určuje nabízené přílohy. Stánek je vždy 3D (sloupec nemá). |
| `power_kw` | Výkon (kW) | `document.serviceTechnical.powerKw` | číslo | Technická služba (elektřina) | — | — | |
| `variant_set`, `variant_scope` | Barevné varianty: vzorník, rozsah | `document.variantOptions` | kód vzorníku; `billed_by_card` / `all_variants` | Produkt (koberce, další s barvami) | — | — | Rozsah 2.7. |
| `usage_agreement_payer` | Jen na základě dohody — náklady nese | `document.usageAgreement.payerLabel` | text ≤ 80 | Produkt | — | — | Vyplněno = karta jen na dohodu (M04 → „PVA“). V kompletu vyžaduje důvod. |
| `catalog_visible`, `catalog_name`, `catalog_description`, `catalog_sort` | Publikace v katalogu | `document.catalogPublication.*` | ANO/NE, text ≤ 120, text ≤ 400, číslo ≤ 99 999 | Produkt, Služba, Komplet (ne Interní komponenta) | — | — | Bez sekce = nezveřejněno. |
| `note` | Poznámka | `document.note` | text | všechny | — | — | |
| `lifecycle_status` | Stav | `catalog_items.lifecycle_status` | výčet (2.1) | všechny | — | — | **Návrh: importem neměnit** (viz 6.5). Nová karta vzniká vždy jako „K doplnění“. |

**Aktivace (Lifecycle) podle interního druhu** — [domain/catalogReadiness.ts](../domain/catalogReadiness.ts):

| Druh | Musí mít pro aktivaci |
|---|---|
| všechny | interní název, kategorie |
| `furniture` | generátorový kód, jednotka, šířka + hloubka > 0, 2D nebo 3D; 2D → půdorys, 3D → GLB; schválení (`reviewedAt`) |
| `technical_point` | 2D nebo 3D; 2D → půdorys, 3D → GLB |
| `service` | jednotka |
| `graphics_service` | cenová jednotka odvozená z kategorie a jednotky bez nesouladu |
| `floor_finish` | jednotka, schválení |
| `booth` | šířka, hloubka, výška > 0; GLB (u typových řad s variantami: GLB **a** SKP u každé varianty + potvrzené varianty) |
| `booth_component` | generátorový kód, GLB, zdrojový SKP |
| `construction`, `other` | 2D → půdorys, 3D → GLB; schválení; u Interní komponenty generátorový kód |

**Systémová pole — uživatel je nevyplňuje:** `created_at`, `updated_at` (kontrola souběhu), `kind` u druhů komponenty (z kategorie), `price_category` (z kategorie), `document.serviceTechnical.serviceCategory` (z kategorie), cenová jednotka grafiky (z kategorie), `document.reviewedAt` (nastaví server při „Označit jako zkontrolované“), `document.sourceSystem/sourceKey`, `document.abfImport` (původ z KODY), `document.archivedFromStatus`, odkazy na soubory v R2 (`photoAsset`, `modelAsset`, `sourceAssets`, `galleryPhotoAssets`), kanonický dokument stánku (tiskové plochy, pohledy kamery, kolizní překážky, `packageContents`).

**Pole mimo šablonu v1** (spravují se v administraci): technický rastr (`document.technicalRaster`), tiskové plochy a pohledy stánků, varianty typových řad T04–T25 (`document.variants` se soubory), soubory jako takové (viz 4.6).

---

## 2. Číselníky

Všechny seznamy jsou úplně ve [CATALOG_IMPORT_TEMPLATE_SCHEMA.json](CATALOG_IMPORT_TEMPLATE_SCHEMA.json). Uživatel v Excelu vybírá **český název** z rozbalovacího seznamu; ukládá se **identifikátor**.

### 2.1 Pevné v kódu

**Typ karty (`item_type`)**

| Identifikátor | Český název |
|---|---|
| PRODUCT | Produkt |
| SERVICE | Služba |
| BOOTH | Stánek |
| INTERNAL_COMPONENT | Interní komponenta |
| KIT | Komplet |

**Interní druh (`kind`)**

| Identifikátor | Český název |
|---|---|
| booth | Stánek |
| booth_component | Komponenta stánku |
| construction | Konstrukce / Octanorm |
| furniture | Mobiliář |
| technical_point | Technický bod (umístění, neúčtuje se) |
| service | Technická služba |
| graphics_service | Grafická služba |
| floor_finish | Podlahová krytina |
| other | Ostatní |

**Stav Lifecycle (`lifecycle_status`)**

| Identifikátor | Český název |
|---|---|
| draft | Koncept |
| needs_review | K doplnění |
| active | Aktivní |
| inactive | Neaktivní |
| archived | Archivováno |

**Použití interní komponenty**

| Identifikátor | Český název |
|---|---|
| booth_component | Samostatný prvek generátoru |
| construction | Konstrukční díl / součást kompletu |

**Cenové zařazení (`price_category`, odvozuje se z kategorie)**

| Identifikátor | Český název |
|---|---|
| standard | Běžná položka |
| electricity | Elektřina |

**Druh řádku kompletu**

| Identifikátor | Český název |
|---|---|
| item | Položka katalogu |
| text | Volná textová položka |

**Pravidlo doplatku náhrady**

| Identifikátor | Český název |
|---|---|
| price_difference | Rozdíl ceny nové a původní komponenty |
| fixed | Pevný doplatek |
| per_unit | Doplatek za jednotku |
| none | Bez doplatku |

**Druh vzorníku**

| Identifikátor | Český název |
|---|---|
| carpet | Koberce |
| finish | Povrchy |
| color | Barvy |
| other | Ostatní |

**Pravidlo příplatku barvy**

| Identifikátor | Český název |
|---|---|
| none | Bez příplatku |
| price_difference | Rozdíl ceny karty proti výchozí variantě |
| per_unit | Vlastní příplatek za jednotku |
| fixed | Pevný příplatek |

**Rozsah barev karty**

| Identifikátor | Český název |
|---|---|
| billed_by_card | Barvy účtované touto kartou |
| all_variants | Všechny barvy vzorníku |

**Stav obrázku barvy**

| Identifikátor | Český název |
|---|---|
| pending_permission | Čeká na oprávnění k použití |
| approved | Použití schváleno |
| rejected | Použití zamítnuto |

**Druh aliasu**

| Identifikátor | Český název |
|---|---|
| name | Název |
| code | Kód |

**Technická kategorie služby (odvozuje se z kategorie)**

| Identifikátor | Český název |
|---|---|
| electricity | Elektrická energie |
| internet | Internet / WiFi |
| water | Voda |
| waste | Odpad |
| cleaning | Úklid |
| other | Jiný / budoucí |

**Typ tiskové plochy (zahrnutá grafika)**

| Identifikátor | Český název |
|---|---|
| panel | Panel |
| panel_above_door | Panel nad dveřmi |
| fascia | Límec |
| counter_front | Pult – čelo |
| counter_side | Pult – bok |
| showcase | Vitrína |
| custom | Jiná plocha |

**Druh zdrojového souboru**

| Identifikátor | Český název |
|---|---|
| sketchup | SketchUp (.skp) |
| dwg | DWG |
| dxf | DXF |
| pdf | PDF |
| other | Ostatní |

**Druh ceníku**

| Identifikátor | Český název |
|---|---|
| base | Základní prodejní ceník |
| electricity | Ceník elektřiny |
| purchase | Nákupní ceník |

**Stav verze ceníku**

| Identifikátor | Český název |
|---|---|
| draft | Koncept |
| published | Publikováno |
| archived | Archivováno |

**Režim prodejní ceny**

| Identifikátor | Český název |
|---|---|
| fixed | Pevná cena |
| individual | Cena na dotaz |
| included | Zahrnuto v ceně |

**Zaokrouhlení EUR**

| Identifikátor | Český název |
|---|---|
| ceil | Nahoru |
| round | Matematicky |
| floor | Dolů |

**Krok zaokrouhlení EUR:** 0.01, 0.1, 0.5, 1, 5, 10. **EUR SK:** `derived` (z CZK kurzem verze) / `manual` (ruční). **Cenové linie:** `CZK` CZK, `EUR_SK` EUR SK (přepočet kurzem), `EUR_WORLD` EUR WORLD (pevná cena v EUR).

### 2.2 Kategorie

**Druhy komponenty — spravuje databáze** (`catalog_categories`, Katalog komponent → Kategorie; nové kategorie může přidat uživatel, nikdy se nemažou):

Zdroj: DB: catalog_categories (managed in Katalog komponent → Kategorie)

| Identifikátor (ukládá se) | Český název | Druh komponenty | Druhy (první = výchozí) | Aktivní | Tech. kategorie | Ceník | Doporučené parametry |
|---|---|---|---|---|---|---|---|
| `chairs` | Židle | product | furniture | ano | — | odvozeno ze skupiny | — |
| `product-tables` | Stoly | product | furniture | ano | — | odvozeno ze skupiny | — |
| `product-counters` | Pulty | product | furniture | ano | — | odvozeno ze skupiny | — |
| `Kuchyňka` | Kuchyňka | product | furniture, other | ano | — | odvozeno ze skupiny | — |
| `Nábytek` | Ostatní mobiliář | product | furniture, other | ano | — | odvozeno ze skupiny | — |
| `product-carpets` | Koberce | product | floor_finish | ano | — | odvozeno ze skupiny | — |
| `Podlaha` | Podlaha | product | floor_finish | ano | — | odvozeno ze skupiny | — |
| `Osvětlení` | Osvětlení | product | other, furniture | ano | — | odvozeno ze skupiny | — |
| `Světlo` | Světlo / elektro (ABF) | product | other, furniture | ano | — | odvozeno ze skupiny | — |
| `Octanorm` | Octanorm | product | furniture, construction, other | ano | — | odvozeno ze skupiny | — |
| `Stavba` | Stavba | product | construction | ano | — | odvozeno ze skupiny | — |
| `Úvaz` | Úvaz (rigging) | product | construction | ano | — | odvozeno ze skupiny | — |
| `Ostatní` | Ostatní produkty | product | other, furniture | ano | — | odvozeno ze skupiny | — |
| `graphics-fascia` | Límec (bm) | graphics | graphics_service | ano | — | odvozeno ze skupiny | — |
| `graphics-full-wrap` | Celopolep (m²) | graphics | graphics_service | ano | — | odvozeno ze skupiny | — |
| `graphics-counter` | Polep pultu (m²) | graphics | graphics_service | ano | — | odvozeno ze skupiny | — |
| `graphics-other` | Ostatní grafika | graphics | graphics_service | ano | — | odvozeno ze skupiny | — |
| `service-electricity` | Elektřina | technical_service | service | ano | electricity | electricity | — |
| `service-internet` | Internet | technical_service | service | ano | internet | odvozeno ze skupiny | Rychlost internetu (Mb/s) |
| `service-cleaning` | Úklid | technical_service | service | ano | cleaning | odvozeno ze skupiny | — |
| `service-water` | Voda | technical_service | service | ano | water | odvozeno ze skupiny | — |
| `service-waste` | Odpad | technical_service | service | ano | waste | odvozeno ze skupiny | — |
| `T. služby` | Ostatní technické služby | technical_service | service | ano | other | odvozeno ze skupiny | — |
| `services` | Služby (původní obecná kategorie) | technical_service | service, graphics_service | ne | — | odvozeno ze skupiny | — |
| `Sloupky` | Sloupky | internal_component | booth_component, construction | ano | — | odvozeno ze skupiny | — |
| `Panely / stěny` | Panely / stěny | internal_component | booth_component, construction | ano | — | odvozeno ze skupiny | — |
| `Límce` | Límce (konstrukční profil) | internal_component | booth_component, construction | ano | — | odvozeno ze skupiny | — |
| `Dveře` | Dveře | internal_component | booth_component, construction | ano | — | odvozeno ze skupiny | — |
| `Zázemí / konstrukce` | Konstrukční prvky / zázemí | internal_component | construction, booth_component | ano | — | odvozeno ze skupiny | — |
| `internal-other` | Ostatní interní komponenty | internal_component | other, booth_component, construction | ano | — | odvozeno ze skupiny | — |
| `point-electricity` | Elektro bod | technical_point | technical_point | ano | electricity | odvozeno ze skupiny | — |
| `point-internet` | Internetový bod | technical_point | technical_point | ano | internet | odvozeno ze skupiny | — |
| `point-water` | Vodní bod | technical_point | technical_point | ano | water | odvozeno ze skupiny | — |
| `point-other` | Ostatní technické body | technical_point | technical_point | ano | other | odvozeno ze skupiny | — |

**Stánek a Komplet — pevný seznam v kódu** (`CATALOG_ITEM_CATEGORY_OPTIONS`; server ho u těchto typů nekontroluje):

| Identifikátor | Český název |
|---|---|
| `chairs` | Židle |
| `Nábytek` | Nábytek |
| `Kuchyňka` | Kuchyňka |
| `Octanorm` | Octanorm |
| `Ostatní` | Ostatní |
| `Stavba` | Stavba |
| `Úvaz` | Úvaz (rigging) |
| `Světlo` | Světlo |
| `Typovky` | Typovky |
| `Kóje` | Kóje |
| `Canonical` | Canonical |
| `T. služby` | Technické služby |
| `services` | Služby |
| `Panely / stěny` | Panely / stěny |
| `Sloupky` | Sloupky |
| `Límce` | Límce |
| `Dveře` | Dveře |
| `Zázemí / konstrukce` | Zázemí / konstrukce |
| `Podlaha` | Podlaha |
| `Osvětlení` | Osvětlení |

### 2.3 Jednotky — databáze (`catalog_units`, zrcadlo v kódu `CATALOG_UNITS`)

| Kód (ukládá se) | Symbol | Český název | Veličina | Přijímané zápisy | Aktivní |
|---|---|---|---|---|---|
| `ks` | ks | kus | count | ks, kus, kusy, kusu, pc, pcs | ano |
| `m2` | m² | metr čtvereční | area | m2, metrctverecni | ano |
| `bm` | bm | běžný metr | length | bm, beznymetr | ano |
| `m3` | m³ | metr krychlový | volume | m3, metrkrychlovy | ano |
| `den` | den | den | time | den, dny, dni, dnu, day, days | ano |
| `pausal` | paušál | paušál | flat | pausal, paus, flat | ano |

Kód shodný se zrcadlem v kódu: ano.

### 2.4 Realizační firmy — databáze

| Identifikátor | Název | Aktivní |
|---|---|---|
| `creativ-expo` | Creativ Expo | ano |
| `gendai` | Gendai | ano |
| `mac-praha` | MAC Praha | ano |

### 2.5 Ceníky a verze — databáze

| Kód | Název | Druh | Aktivní | Verze |
|---|---|---|---|---|
| `E2E-AUTOTEST` | Automatický test (neměnit ručně) | base | ne | — |
| `PRODEJNI-ZAKLADNI` | Základní prodejní ceník ABF | base | ano | v1 draft (kurz 24.17, ceil/1) |
| `ZKUSEBNI-ELEKTRINA` | ZKUŠEBNÍ ceník elektřiny | electricity | ano | v1 published (kurz 24.17, ceil/1) |
| `ZKUSEBNI-NAKUP` | ZKUŠEBNÍ nákupní ceník (Creativ, Gendai, MAC) | purchase | ano | v1 published (kurz 24.17, ceil/1) |
| `ZKUSEBNI-ZAKLADNI` | ZKUŠEBNÍ základní ceník | base | ano | v6 draft (kurz 24.17, ceil/1); v5 draft (kurz 24.17, ceil/1); v4 draft (kurz 24.17, ceil/1); v3 draft (kurz 24.17, ceil/1); v2 published (kurz 25, ceil/1); v1 published (kurz 24.17, ceil/1) |

ZKUŠEBNÍ a E2E ceníky jsou testovací; skutečný je `PRODEJNI-ZAKLADNI`.

### 2.6 Vzorníky — databáze

| Kód | Název | Druh | Aktivní | Barev | Řady | Účtováno kartami |
|---|---|---|---|---|---|---|
| `KOBERCE-SERBUS` | Koberce SERBUS | carpet | ano | 56 | PODIUM-PLAT, REVEXPO | M02, M01 |
| `ZKUSEBNI-KOBERCE` | ZKUŠEBNÍ koberce V1-DATA-04 | carpet | ano | 4 | — | — |

### 2.7 Vazby a omezení podle typu karty

- **Typ karty → povolené druhy:** viz 1.1. Kombinace mimo tabulku server odmítne.
- **Kategorie → druhy:** sloupec „Druhy“ v 2.2. Interní komponenta volí mezi `booth_component` a `construction` jen v rámci kategorie.
- **Rozsah barev karty:** `billed_by_card` = barvy, jejichž `price_item_id` je tato karta (M01 → PLAT 020, M02 → ostatních 55); `all_variants` = všechny barvy vzorníku (M04 → 56).
- **Komplet:** obsah smí mít jen Stánek nebo Komplet; komplet/stánek nesmí být řádkem ani náhradou (A14).
- **Grafika:** jednotka podle kategorie (Límec = bm, Celopolep / Polep pultu = m², Ostatní grafika = jednotka karty).
- **Cena podle řady:** řádek ceníku platí pro konkrétní kartu, tedy M02 + REVEXPO nikdy neocení M04 + REVEXPO.

---

## 3. Vzorové karty z DEV

Skutečné karty (data jen čtena). Úplné řádky včetně souborů, aliasů a řádků kompletů jsou ve schématu v `examples`.

| Kód | Typ / druh | Kategorie | Jednotka | Rozměry (mm) | Stav | Chybí k aktivaci | Další |
|---|---|---|---|---|---|---|---|
| **M57** Židle čalouněná černá | PRODUCT/furniture | chairs | ks | 530 × 600 × 820 | active | nic | ABF M57, 4 aliasy, fotka, 3D |
| **M01** Koberec šedý | PRODUCT/floor_finish | product-carpets | m2 | — | active | nic | ABF M01, vzorník KOBERCE-SERBUS (billed_by_card), fotka |
| **M02** Koberec barevný | PRODUCT/floor_finish | product-carpets | m2 | — | active | nic | ABF M02, vzorník KOBERCE-SERBUS (billed_by_card), fotka |
| **M04** Koberec PVA | PRODUCT/floor_finish | product-carpets | m2 | — | active | nic | ABF M04, vzorník KOBERCE-SERBUS (all_variants), dohoda: PVA, fotka |
| **L02** Elektrická energie - 2kW | SERVICE/service | service-electricity | ks | — | active | nic | ABF L02, fotka |
| **M91** Grafika Límec | SERVICE/graphics_service | graphics-fascia | bm | — | active | nic | ABF M91, 3 aliasy, fotka |
| **OCT-SL-2500** Sloupek Octanorm 250 | INTERNAL_COMPONENT/booth_component | Sloupky | ks | 40 × 40 × 2500 | active | nic | bez ABF kódu, fotka, 3D |
| **P86** Kóje 2×2 m | BOOTH/booth | Kóje | ks | 2000 × 2000 × 2500 | active | nic | ABF P86, 2 řádků kompletu, 3 aliasy, fotka, 3D |
| **T04** Typový stanek T04 | BOOTH/booth | Typovky | ks | 2000 × 2000 × 2500 | needs_review | missing_3d_asset | ABF T04, 1 řádků kompletu, fotka |

**Řádky kompletů ve vzorových kartách:**

| Komplet | line_key | Druh | Komponenta / název | Množství | Jednotka | V ceně | Vzorník / výchozí | Zahrnutá grafika | Náhrady |
|---|---|---|---|---|---|---|---|---|---|
| P86 | koberec | item | M01 | 4 | m2 | ano | KOBERCE-SERBUS / PODIUM-PLAT-020 | — | M02 (price_difference, libovolná barva) |
| P86 | grafika-limec | item | M91 | 2 | bm | ano | — | fascia 2 bm | — |
| T04 | m01 | item | M01 | 4 | m2 | ano | KOBERCE-SERBUS / PODIUM-PLAT-020 | — | M02 (price_difference, libovolná barva) |

**Chybí v DEV:** skutečný `KIT` (existuje jen „ZKUŠEBNÍ V1-DATA-04 komplet“ — testovací, nepoužívat jako vzor), karta druhu `technical_point`, karta grafiky s nesouladem jednotek. Vymyšlené kódy se ve vzorech nepoužívají.

**Vzorník (KOBERCE-SERBUS, výběr):**

| Vzorník | Kód barvy | Název | Řada | Účtuje | Příplatek | Aktivní | Fotka |
|---|---|---|---|---|---|---|---|
| KOBERCE-SERBUS | PODIUM-PLAT-035 | PODIUM / PLAT 035 | PODIUM-PLAT | M02 | price_difference | ano | ano |
| KOBERCE-SERBUS | PODIUM-PLAT-020 | PODIUM / PLAT 020 | PODIUM-PLAT | M01 | none | ano | ano |
| KOBERCE-SERBUS | REVEXPO-1335 | REVEXPO 1335 | REVEXPO | M02 | price_difference | ano | ano |

**Ceník PRODEJNI-ZAKLADNI (koberce a P86):**

Verze v1 (draft), kurz 24.17, zaokrouhlení ceil/1

| generator_code | variant_code | variant_series | price_mode | price_czk | EUR SK | price_eur_world | unit_code |
|---|---|---|---|---|---|---|---|
| M01 | PODIUM-PLAT-020 | — | fixed | 190 | z kurzu | 9 | m2 |
| M02 | — | PODIUM-PLAT | fixed | 220 | z kurzu | 11 | m2 |
| M02 | — | REVEXPO | fixed | 240 | z kurzu | 12 | m2 |
| M04 | — | — | fixed | 0 | z kurzu | 0 | m2 |
| P86 | — | — | fixed | 3640 | z kurzu | 162 | ks |

---

## 4. Struktura a vazby

### 4.1 Obsah kompletu (`catalog_item_package_items`)
- Vlastník: karta **Stánek** nebo **Komplet**. Identita řádku = (`komplet`, `line_key`); `line_key` = malá písmena, číslice, pomlčky, ≤ 64, v kompletu unikátní, nemění se při změně komponenty.
- Druh řádku `item` (katalogová komponenta) nebo `text` (volná položka, A16): text **musí** mít název a **nesmí** mít komponentu, vzorník, náhrady ani zahrnutou grafiku; je vždy v ceně a nikdy se neoceňuje.
- `quantity` > 0, `unit_code` z číselníku, `included_in_price` ANO/NE (u textu vždy ANO), `note`.
- Barvy na řádku: `variant_set` + `default_variant` (výchozí musí patřit do vzorníku).
- Zahrnutá grafika (`print_allowance`): seznam {typ tiskové plochy, jednotka `bm`/`m2`/`ks`, zahrnuté množství}; účtuje se jen překročení.
- Řádky lišící se jen množstvím nebo poznámkou = varování (raději jeden řádek).
- **Cena kompletu** = vlastní řádek karty kompletu v ceníku; řádky „V ceně“ se nepřičítají; nepovinný řádek = množství × cena; chybějící cena = „K nacenění“, nikdy 0.

### 4.2 Náhrady (`catalog_kit_line_substitutes`, váží se k řádku)
- Náhradní komponenta (ne komplet/stánek), volitelně konkrétní barva; **prázdná barva + vzorník na řádku = libovolná barva vzorníku**.
- Pravidlo doplatku: `price_difference` (nová cena × množství − původní; nikdy záporné → `floor_zero`), `fixed` (částka z ceníku za řádek), `per_unit` (částka za jednotku; jednotka povinná), `none` (0).
- `quantity_factor` > 0 (výchozí 1), `active`.
- Stejná náhrada (komponenta + barva) u řádku jen jednou; náhrada musí být jiná komponenta nebo jiná barva.
- Karta „jen na dohodu“ (M04) se použije jen s uvedeným důvodem (volba v zakázce, ne v šabloně).

### 4.3 Vzorníky a varianty (`catalog_variant_sets`, `catalog_variants`)
- Vzorník: `code` (velká písmena, číslice, `-`, `_`, ≤ 64, unikátní), `name`, `kind` (2.1), `active`, `note`. Max. 200 barev.
- Barva: `code` (unikátní ve vzorníku), `name`, `name_en`, `series` (řada, stejný formát jako kód), `swatch_color` `#RRGGBB`, `billed_by` (kód karty → `price_item_id`), `surcharge_rule` (`price_difference` vyžaduje `billed_by`, `per_unit` vyžaduje jednotku), `active`, `sort_order`, `note`, zdroj obrázku.
- Vzorníky ani barvy se **nemažou**, jen deaktivují. Fotografie a 3D textury barev jsou soubory (4.6).

### 4.4 Aliasy realizačních firem (`catalog_item_aliases`)
- Karta + firma (prázdná = obecný alias) + druh `name`/`code` + text (≤ 300) + volitelná jednotka, ve které firma účtuje + poznámka.
- Identita = (firma, druh, normalizovaný text); název se normalizuje na malá písmena bez diakritiky, kód na velká písmena bez mezer. Jeden alias nesmí vést na dvě karty.

### 4.5 Parametry (`document.attributes.extra`, u služeb `document.serviceTechnical.parameters`)
- **Systémové** (šířka, hloubka, výška, barva, materiál, výkon kW) mají vlastní sloupce; jako vlastní parametr jsou odmítnuty.
- **Doporučené** parametry definuje kategorie (2.2, sloupec „Doporučené parametry“); hodnota se ukládá pod klíčem `název (jednotka)`.
- **Vlastní** parametry: dvojice název–hodnota (služby: název ≤ 40, hodnota ≤ 200, max. 30).

### 4.6 Soubory
- Hlavní fotka, galerie, aktivní GLB, zdrojové soubory `sketchup`/`dwg`/`dxf`/`pdf`/`other`; R2 kategorie `catalog-photo`, `catalog-model`, `catalog-source`, …
- Dnes se nahrávají jen v administraci (jednotlivě nebo „Nahrát více souborů“ podle přípony). **Excel buňka soubor nenese.** Návrh: volitelný list `Soubory` (kód karty, cíl, název souboru) + ZIP se soubory, ve fázi 2.

### 4.7 Ceníky a verze
- Ceník (`versioned_price_lists`): druh `base` / `electricity` / `purchase`. Verze: `draft` (upravitelná) → `published` (neměnná) → `archived`; kurz EUR, zaokrouhlení (režim + krok).
- Prodejní řádek: karta + (konkrétní barva **nebo** řada **nebo** nic), režim `fixed` / `individual` / `included`, CZK, EUR SK (`derived` z kurzu nebo `manual`), EUR WORLD (samostatná cena, při publikaci povinná). Vyhodnocení: barva → řada → karta.
- Nákupní řádek: karta (+ barva), CZK; nepovinný, chybějící = „Nezadáno“.
- Veletrhu lze přiřadit jen publikovanou verzi.

### 4.8 Hlavní listy vs. relační listy

| Obsah | Kam |
|---|---|
| Identita, klasifikace, jednotka, rozměry, barva/materiál, 2D/3D, výkon, vzorník + rozsah, dohoda, publikace, poznámka | **hlavní list typu karty** (1 karta = 1 řádek) |
| Obsah kompletu | relační list `ObsahKompletu` (1 řádek kompletu = 1 řádek) |
| Náhrady | relační list `Nahrady` |
| Vzorníky a barvy | `Vzorniky`, `Barvy` |
| Aliasy | `Aliasy` |
| Parametry (doporučené i vlastní) | `Parametry` (1 parametr = 1 řádek) |
| Soubory | `Soubory` (fáze 2) |
| Ceny | **samostatný sešit Ceník** (verze se publikují zvlášť) |

---

## 5. Současné importéry — co existuje

| Importér | Soubor / vstup | Párování | Co mění / zachovává | Prázdná buňka, nula | Duplicity, opakování |
|---|---|---|---|---|---|
| **Import ABF kódů** — *odstraněn ve V1-ADMIN-01, popis ponechán jako historie* | `KODY.xlsm`, list `PRICELIST`: A = ABF kód, B = název CZ, E = název EN; jednotka se odhadne z názvu; makra se nespouští | 1) stejný `abf_code` → aktualizace; 2) `internal_code` = kód a karta bez ABF kódu → aktualizace + doplnění ABF kódu; 3) karta bez ABF kódu se **stejným názvem** → konflikt, propojí jen ruční potvrzení; 4) jinak nová karta (`internal_code` = ABF kód) | Mění jen `official_name`, `document.abfImport`, `abf_code` při propojení, `internal_code`/`unit` **jen když jsou prázdné**. Nikdy nemění interní název, kategorii, druh, typ, Lifecycle, soubory, technická a cenová data. Nic nearchivuje; karty chybějící v souboru jen vypíše. | Řádek bez kódu ve sloupci A se přeskočí (počítá se). Ceny ze sešitu se **neimportují**. | Konflikty v náhledu: neplatný kód ve sloupci A, **stejný ABF kód v souboru vícekrát** (nezapíše se žádný z těchto řádků), chybějící název, shoda jen podle názvu. Náhled (dry-run) → potvrzení; každý běh se zapíše do `import_batches` s otiskem souboru. Opakovaný import stejného souboru = všechny řádky „beze změny“ (čas importu se ignoruje). |
| **Nahrát více souborů** (karta) | soubory | cíl podle přípony (návrh, uživatel může změnit) | Přidává; hlavní fotku a aktivní GLB nahradí jen výslovně; nic nemaže | — | max. 1 hlavní fotka a 1 GLB v dávce |
| Excel ceníku | jen **definice sloupců** `priceVersionExcel.ts` (generátorový kód, ABF kód, kód varianty, režim, CZK, EUR SK ruční, EUR WORLD, jednotka, poznámka) | (verze, karta podle gen./ABF kódu, varianta) | — (import neimplementován) | prázdná = beze změny, `#SMAZAT` maže | — |
| Skripty `carpets:dev:import`, `carpets:dev:photos`, `p86:dev:import` | JSON manifest / vestavěná data | kód karty, kód vzorníku+barvy | jen zakládají chybějící, existující nikdy nepřepíší | — | idempotentní, jen DEV |
| Legacy: `importBatch*`, import tiskových ploch, starý import cen | V6.6 / Excel tiskových ploch / staré ceníky | — | **nepoužívat pro nový katalog** | — | — |

**Neexistuje:** import karet z Excelu (mimo ABF identitu), import kompletů, náhrad, vzorníků, aliasů a parametrů, export katalogu do Excelu, list `_meta`, verze šablony, značka `#SMAZAT` mimo definici ceníku, evidence importu po řádcích pro jiné entity než KODY.

---

## 6. Návrh finální šablony

### 6.1 Sešit `Generator_ABF_Katalog.xlsx`

| List | Viditelnost | Účel | Klíč řádku |
|---|---|---|---|
| `Navod` | viditelný, zamčený | postup, legenda povinnosti, význam prázdné buňky, `#SMAZAT`, odkazy na Číselníky | — |
| `Produkty` | viditelný | karty typu Produkt | `id` → `generator_code` → `abf_code` |
| `Sluzby` | viditelný | Technická služba, Grafika, Technický bod (typ SERVICE) | totéž |
| `InterniKomponenty` | viditelný | Interní komponenta | `id` → `generator_code` (povinný) |
| `Stanky` | viditelný | Stánek (jen identita a obchodní údaje; geometrie se spravuje modelem a administrací) | `id` → `generator_code` → `abf_code` |
| `Komplety` | viditelný | karty typu Komplet | totéž |
| `ObsahKompletu` | viditelný | řádky kompletů a stánků | (`komplet_code`, `line_key`) |
| `Nahrady` | viditelný | náhrady řádků | (`komplet_code`, `line_key`, `nahrada_code`, `nahrada_barva`) |
| `Vzorniky` | viditelný | vzorníky | `vzornik_code` |
| `Barvy` | viditelný | barvy vzorníků | (`vzornik_code`, `barva_code`) |
| `Aliasy` | viditelný | aliasy karet | (`karta_code`, `firma`, `druh`, `text`) |
| `Parametry` | viditelný | doporučené a vlastní parametry | (`karta_code`, `parametr`) |
| `Vzory` | viditelný, zamčený | ukázkové řádky ze skutečných karet (oddíl 3) | **import list ignoruje** |
| `Ciselniky` | skrytý, zamčený | zdroj rozbalovacích seznamů (generuje se z DB při stažení šablony) | — |
| `_meta` | velmi skrytý | `template_format`, datum, zdrojový commit, prostředí (DEV/PROD), typ sešitu | — |

### 6.2 Společná pravidla listů
- **Řádek 1 = technické klíče** (import čte jen je), **řádek 2 = české popisky s nápovědou** (lze přejmenovat), data od řádku 3. Povinné sloupce mají popisek se `*` a barevné záhlaví (červeně U, oranžově A).
- **Uživatel nikdy nepíše ID ani JSON:** odkazy jsou kódy (`generator_code`, `abf_code`, `vzornik_code`, `barva_code`, `line_key`), firmy a číselníky se vybírají českým názvem. Sloupec `id` se jen exportuje a je uzamčený.
- **Prázdná nepovinná buňka = beze změny** (u nové karty „bez hodnoty“). **0 je hodnota.** Vymazání hodnoty jen značkou **`#SMAZAT`**. Řádek chybějící v souboru se nemaže ani nearchivuje.
- Rozbalovací seznamy (data validation) z listu `Ciselniky`; kategorie se nabízí **jen pro skupinu daného listu** (např. `Sluzby` → technická služba, grafika, technický bod).
- **Vzory odděleně:** datové listy jsou při stažení prázdné, ukázky jsou jen na listu `Vzory`.
- Postup importu: **suchý běh → náhled** (vytvořit / aktualizovat / beze změny / konflikt / varování, u aktualizací původní a nová hodnota) **→ potvrzení → transakční zápis** → záznam v `import_batches` a `import_rows`. Opakovaný import stejného souboru = vše „beze změny“.

### 6.3 Sloupce hlavních listů

**List `Produkty`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `id` | ID (neměnit) | uuid | R | — | Jen export, uzamčené. |
| `generator_code` | Generátorový kód | text ≤ 64 | P | — | Klíč identity. U Interní komponenty povinný. |
| `abf_code` | ABF kód | text ≤ 32 | — | — | Velká písmena, unikátní. |
| `display_name` | Interní název HomeworkStudio * | text | U | — | — |
| `official_name` | Oficiální název ABF (CZ) | text | — | — | — |
| `official_name_en` | Oficiální název ABF (EN) | text | — | — | — |
| `category` | Kategorie * | id kategorie | U | categories:product | — |
| `unit_code` | Měrná jednotka | kód jednotky | P | units | — |
| `width_mm` | Šířka (mm) | číslo ≥ 0 | P | — | — |
| `depth_mm` | Hloubka (mm) | číslo ≥ 0 | P | — | — |
| `height_mm` | Výška (mm) | číslo ≥ 0 | P | — | — |
| `color` | Barva | text | — | — | — |
| `material` | Materiál | text | — | — | — |
| `show_2d` | 2D v generátoru | ANO/NE | P | yesNo | — |
| `show_3d` | 3D v generátoru (vyžaduje GLB) | ANO/NE | P | yesNo | — |
| `variant_set` | Vzorník barev | kód vzorníku | — | variantSets | — |
| `variant_scope` | Rozsah barev | výčet | P | cardVariantScopes | Povinný, je-li vyplněn vzorník. |
| `usage_agreement_payer` | Jen na dohodu — náklady nese | text ≤ 80 | — | — | — |
| `catalog_visible` | Zobrazit v katalogu | ANO/NE | — | yesNo | — |
| `catalog_name` | Název v katalogu | text ≤ 120 | — | — | — |
| `catalog_description` | Krátký popis v katalogu | text ≤ 400 | — | — | — |
| `catalog_sort` | Pořadí v katalogu | celé číslo | — | — | — |
| `note` | Poznámka | text | — | — | — |
| `lifecycle_status` | Stav (jen pro čtení) | výčet | R | lifecycleStatuses | Aktivace v administraci (6.5/1). |

**List `Sluzby`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `id` | ID (neměnit) | uuid | R | — | Jen export, uzamčené. |
| `generator_code` | Generátorový kód | text ≤ 64 | P | — | Klíč identity. U Interní komponenty povinný. |
| `abf_code` | ABF kód | text ≤ 32 | — | — | Velká písmena, unikátní. |
| `display_name` | Interní název HomeworkStudio * | text | U | — | — |
| `official_name` | Oficiální název ABF (CZ) | text | — | — | — |
| `official_name_en` | Oficiální název ABF (EN) | text | — | — | — |
| `category` | Kategorie * | id kategorie | U | categories:graphics,technical_service,technical_point | — |
| `unit_code` | Měrná jednotka | kód jednotky | P | units | Grafika: Límec = bm, Celopolep/Polep pultu = m². |
| `power_kw` | Výkon (kW) | číslo | — | — | Jen elektřina. |
| `show_2d` | 2D v generátoru | ANO/NE | P | yesNo | — |
| `show_3d` | 3D v generátoru (vyžaduje GLB) | ANO/NE | P | yesNo | — |
| `catalog_visible` | Zobrazit v katalogu | ANO/NE | — | yesNo | — |
| `catalog_name` | Název v katalogu | text ≤ 120 | — | — | — |
| `catalog_description` | Krátký popis v katalogu | text ≤ 400 | — | — | — |
| `catalog_sort` | Pořadí v katalogu | celé číslo | — | — | — |
| `note` | Poznámka | text | — | — | — |
| `lifecycle_status` | Stav (jen pro čtení) | výčet | R | lifecycleStatuses | Aktivace v administraci (6.5/1). |

**List `InterniKomponenty`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `id` | ID (neměnit) | uuid | R | — | Jen export, uzamčené. |
| `generator_code` | Interní / generátorový kód * | text ≤ 64 | U | — | Klíč identity. U Interní komponenty povinný. |
| `abf_code` | ABF kód | text ≤ 32 | — | — | Velká písmena, unikátní. |
| `display_name` | Interní název HomeworkStudio * | text | U | — | — |
| `category` | Kategorie * | id kategorie | U | categories:internal_component | — |
| `usage` | Použití komponenty * | výčet | U | internalComponentUsages | Samostatný prvek generátoru (GLB+SKP) / Konstrukční díl. |
| `unit_code` | Měrná jednotka | kód jednotky | — | units | — |
| `width_mm` | Šířka (mm) | číslo ≥ 0 | P | — | — |
| `depth_mm` | Hloubka (mm) | číslo ≥ 0 | P | — | — |
| `height_mm` | Výška (mm) | číslo ≥ 0 | P | — | — |
| `color` | Barva | text | — | — | — |
| `material` | Materiál | text | — | — | — |
| `show_2d` | 2D v generátoru | ANO/NE | P | yesNo | — |
| `show_3d` | 3D v generátoru (vyžaduje GLB) | ANO/NE | P | yesNo | — |
| `note` | Poznámka | text | — | — | — |
| `lifecycle_status` | Stav (jen pro čtení) | výčet | R | lifecycleStatuses | Aktivace v administraci (6.5/1). |

**List `Stanky`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `id` | ID (neměnit) | uuid | R | — | Jen export, uzamčené. |
| `generator_code` | Generátorový kód | text ≤ 64 | P | — | Klíč identity. U Interní komponenty povinný. |
| `abf_code` | ABF kód | text ≤ 32 | — | — | Velká písmena, unikátní. |
| `display_name` | Interní název HomeworkStudio * | text | U | — | — |
| `official_name` | Oficiální název ABF (CZ) | text | — | — | — |
| `official_name_en` | Oficiální název ABF (EN) | text | — | — | — |
| `category` | Kategorie * | výčet (pevný) | U | specialCardCategories | — |
| `unit_code` | Měrná jednotka | kód jednotky | — | units | — |
| `width_mm` | Šířka (mm) | číslo ≥ 0 | A | — | — |
| `depth_mm` | Hloubka (mm) | číslo ≥ 0 | A | — | — |
| `height_mm` | Výška (mm) | číslo ≥ 0 | A | — | — |
| `catalog_visible` | Zobrazit v katalogu | ANO/NE | — | yesNo | — |
| `catalog_name` | Název v katalogu | text ≤ 120 | — | — | — |
| `catalog_description` | Krátký popis v katalogu | text ≤ 400 | — | — | — |
| `catalog_sort` | Pořadí v katalogu | celé číslo | — | — | — |
| `note` | Poznámka | text | — | — | — |
| `lifecycle_status` | Stav (jen pro čtení) | výčet | R | lifecycleStatuses | Aktivace v administraci (6.5/1). |

**List `Komplety`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `id` | ID (neměnit) | uuid | R | — | Jen export, uzamčené. |
| `generator_code` | Generátorový kód | text ≤ 64 | P | — | Klíč identity. U Interní komponenty povinný. |
| `abf_code` | ABF kód | text ≤ 32 | — | — | Velká písmena, unikátní. |
| `display_name` | Interní název HomeworkStudio * | text | U | — | — |
| `official_name` | Oficiální název ABF (CZ) | text | — | — | — |
| `official_name_en` | Oficiální název ABF (EN) | text | — | — | — |
| `category` | Kategorie * | výčet (pevný) | U | specialCardCategories | — |
| `unit_code` | Měrná jednotka | kód jednotky | — | units | — |
| `catalog_visible` | Zobrazit v katalogu | ANO/NE | — | yesNo | — |
| `catalog_name` | Název v katalogu | text ≤ 120 | — | — | — |
| `catalog_description` | Krátký popis v katalogu | text ≤ 400 | — | — | — |
| `catalog_sort` | Pořadí v katalogu | celé číslo | — | — | — |
| `note` | Poznámka | text | — | — | — |
| `lifecycle_status` | Stav (jen pro čtení) | výčet | R | lifecycleStatuses | Aktivace v administraci (6.5/1). |

Povinnost: U = uložení, A = aktivace, P = podmíněně, R = jen pro čtení.

### 6.4 Sloupce relačních listů

**List `ObsahKompletu`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `komplet_code` | Komplet / stánek (kód) * | kód karty | U | cards:BOOTH,KIT | — |
| `line_key` | Klíč řádku * | a–z 0–9 - | U | — | Stabilní, např. koberec, grafika-limec. |
| `line_kind` | Druh řádku * | položka / text | U | kitLineKinds | — |
| `component_code` | Komponenta (kód) | kód karty | P | cards:!BOOTH,!KIT | Povinná u položky, zakázaná u textu. |
| `label` | Název textové položky | text | P | — | Povinný u textu. |
| `quantity` | Množství * | číslo > 0 | U | — | — |
| `unit_code` | Jednotka | kód jednotky | — | units | — |
| `included_in_price` | V ceně kompletu | ANO/NE | — | yesNo | Výchozí ANO; text vždy ANO. |
| `variant_set` | Vzorník | kód vzorníku | — | variantSets | — |
| `default_variant` | Výchozí barva | kód barvy | P | variants | Musí patřit do vzorníku. |
| `print_surface_type` | Zahrnutá grafika: typ plochy | výčet | — | printSurfaceTypes | — |
| `print_unit` | Zahrnutá grafika: jednotka | bm / m2 / ks | P | — | — |
| `print_included_qty` | Zahrnutá grafika: množství | číslo | P | — | — |
| `note` | Poznámka | text | — | — | — |
| `sort_order` | Pořadí | celé číslo | — | — | — |

**List `Nahrady`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `komplet_code` | Komplet / stánek (kód) * | kód karty | U | cards:BOOTH,KIT | — |
| `line_key` | Klíč řádku * | text | U | — | — |
| `substitute_code` | Náhradní komponenta (kód) * | kód karty | U | cards:!BOOTH,!KIT | — |
| `substitute_variant` | Barva náhrady | kód barvy | — | variants | Prázdné + vzorník na řádku = libovolná barva vzorníku. |
| `surcharge_rule` | Pravidlo doplatku * | výčet | U | kitSubstituteRules | — |
| `surcharge_unit_code` | Jednotka doplatku | kód jednotky | P | units | Povinná u per_unit. |
| `quantity_factor` | Koeficient množství | číslo > 0 | — | — | Výchozí 1. |
| `active` | Aktivní | ANO/NE | — | yesNo | — |
| `note` | Poznámka | text | — | — | — |

**List `Vzorniky`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `variant_set_code` | Kód vzorníku * | A–Z 0–9 - _ | U | — | — |
| `name` | Název * | text | U | — | — |
| `kind` | Druh | výčet | — | variantSetKinds | Výchozí koberce. |
| `active` | Aktivní | ANO/NE | — | yesNo | — |
| `note` | Poznámka | text | — | — | — |

**List `Barvy`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `variant_set_code` | Kód vzorníku * | kód | U | variantSets | — |
| `variant_code` | Kód barvy * | A–Z 0–9 - _ | U | — | — |
| `name` | Název * | text | U | — | — |
| `name_en` | Název EN | text | — | — | — |
| `series` | Řada | A–Z 0–9 - _ | — | — | — |
| `billed_by_code` | Účtovaná karta (kód) | kód karty | P | cards | Povinná u price_difference. |
| `surcharge_rule` | Pravidlo příplatku | výčet | — | variantSurchargeRules | Výchozí bez příplatku. |
| `surcharge_unit_code` | Jednotka příplatku | kód jednotky | P | units | Povinná u per_unit. |
| `swatch_color` | Barva náhledu | #RRGGBB | — | — | — |
| `active` | Aktivní | ANO/NE | — | yesNo | — |
| `sort_order` | Pořadí | celé číslo | — | — | — |
| `source_image_url` | Zdroj obrázku (URL) | https://… | — | — | — |
| `note` | Poznámka | text | — | — | — |

**List `Aliasy`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `card_code` | Karta (kód) * | kód karty | U | cards | — |
| `company` | Realizační firma | firma | — | realizationCompanies | Prázdné = obecný alias. |
| `alias_kind` | Druh * | název / kód | U | aliasKinds | — |
| `alias_text` | Text aliasu * | text ≤ 300 | U | — | — |
| `unit_code` | Jednotka firmy | kód jednotky | — | units | — |
| `note` | Poznámka | text | — | — | — |

**List `Parametry`**

| Klíč (řádek 1) | Popisek (řádek 2) | Typ | Povinnost | Rozbalovací seznam | Nápověda |
|---|---|---|---|---|---|
| `card_code` | Karta (kód) * | kód karty | U | cards | — |
| `parameter` | Parametr * | text | U | recommendedParameters | Doporučený z kategorie nebo vlastní; ne systémový. |
| `value` | Hodnota | text / číslo | — | — | Prázdné = beze změny, #SMAZAT = odebrat. |
| `note` | Poznámka | text | — | — | — |

### 6.5 Rozhodnutí potřebná před stavbou šablony
1. **Lifecycle v Excelu.** Návrh: import zakládá a aktualizuje jen koncepty a údaje; **aktivace a schválení zůstávají v administraci** (sloupec `lifecycle_status` jen pro čtení). Alternativa: povolit `active` přes stejnou kontrolu jako tlačítko Aktivovat.
2. **`#SMAZAT`** — rozhodnutí A6 je v [V1_DATA_DECISIONS.md](V1_DATA_DECISIONS.md) stále „otevřené“; tento návrh ho předpokládá.
3. **Stánky:** šablona nese jen identitu a obchodní údaje. Tiskové plochy, pohledy a varianty typových řad zůstávají mimo Excel (V2).
4. **Soubory přes ZIP** (list `Soubory`) — fáze 2, nebo vůbec?
5. **Ceník:** samostatný sešit podle `priceVersionExcel.ts`, nutno **doplnit sloupec `variant_series`** (cena řady z V1-CARPET zatím v definici chybí).

### 6.6 Verze formátu
- `_meta.template_format = "catalog-template/1"`. Importér odmítne neznámou hlavní verzi a u vedlejší verze ohlásí neznámé sloupce varováním (neznámé sloupce se ignorují, chybějící nepovinné nevadí).
- Šablona se **generuje** ze stejné definice sloupců jako import i export (`domain/catalogItemFields.ts` + rozšíření z tohoto dokumentu), ne ručně.

### 6.7 Co je potřeba změnit v kódu pro novou šablonu (neimplementováno)
- Rozšířit `CATALOG_FIELDS_BY_TYPE` o sloupce z 6.3 (2D/3D, výkon, vzorník a rozsah, dohoda, publikace, použití interní komponenty) a o relační listy.
- Importér katalogu (V1-DATA-08): čtení, náhled, konflikty, transakční RPC, `import_batches`/`import_rows` pro všechny entity.
- Export aktuálních dat do stejné šablony (round-trip).
- `priceVersionExcel.ts`: sloupec `variant_series`.
- Adaptér KODY → šablona (párovací pravidla 5 zůstávají).
