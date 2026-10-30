# Technické rastry — import formuláře objednávek ABRA

Primární import technických služeb ze sestavy ABRA **„3. Formulář objednávky přijaté ABF“** (větev `feature/abra-order-import` z `master` 4295176, 30. 10. 2026).
Bez změny databázového schématu, bez migrace — import je běžný záznam `TechnicalRasterImport` (kategorie `abra-orders`) v JSON dokumentu projektu.

## 1. Zdroje

| Soubor (`_IMPORT/`, mimo Git) | Stav |
|---|---|
| `FORMULARE/…(10-40).pdf` | **Zdroj importu.** 151 stran, 127 objednávek V238-1 … V238-127/2026 bez mezer. |
| `FORMULARE/…(10-39).xlsx` | **Nelze použít.** Obsahuje jen 3 bloky položek (části objednávek V238-126, V238-107, V238-94) a hlavičku V238-127 — hlavička jedné objednávky (číslo, odběratel) je smíchaná se stánkem a položkami jiné. Import by služby přiřadil k cizím stánkům, proto je Excel u této sestavy odmítnut s vysvětlením. Ověřuje `npm run test:abra-orders-real`. |
| `TECHNICKE_ZNACKY/Generator_ABF_Technicke_znacky_s_ABF_kody.xlsx` | Schválená tabulka značek + sloupec S „ABF kód“: 34 řádků, 31 s kódem. Přepsáno do `domain/technicalMarkerApprovedTable.ts`, kontrola `npm run test:technical-markers-excel`. |

## 2. Návrh

- `domain/abraOrderForm.ts` — **obecný parser objednávky** (nezávislý na Technických rastrech): číslo objednávky ABRA, zákaznické číslo, odběratel, stánek, datum, strany, všechny položky (ABF kód, název, množství s desetinnou čárkou, jednotka, ceny, DPH, poznámky), položky bez kódu, poznámky objednávky, odkazy na zálohové/dodací listy, částka k úhradě. Využitelné i pro DEV v1.0 (zakázky, katalog komponent) — žádný paralelní katalog ani ceník se nevytváří.
- `domain/abraOrderTechnicalImport.ts` — převod na technické služby **jen podle ABF kódu** přes schválenou tabulku (31 kódů). Služba dostane schválený název ABRA jako `externalLabel` (stejná značka, barva, počet bodů a identita jako z dosavadních výjezdů) a navíc `abfCode`, `sourceOrderNumber`, `sourceItemName`, `itemNotes`.
- Pravidla: bez stánku i služby → ignorovat; stánek bez služby → ignorovat; služba bez stánku → zobrazit (firma, objednávka, kód, název, množství), do rastru ne; stánek + služba → načíst. Více objednávek jednoho stánku se sloučí, opakovaná položka zůstává samostatnou službou, nulová cena je platná, stornopoplatek nic neruší (objednávka jde ke kontrole). Neznámé kódy technických skupin (L, I, W, U) se jen vypíšou, nikdy neodhadují podle názvu. Mobiliář, registrace, parkování apod. se nepřevádí.
- Desetinné množství u služby umisťované po kusech → počet bodů zaokrouhlen nahoru (`requiredPlacementCount`).

## 3. Vztah k dosavadním importům

- Potvrzení importu objednávek **nahradí** předchozí import objednávek a aktivní importy elektřiny, internetu, vody, odpadu a úklidu (`resolveTechnicalImportReplacement`). Záznamy zůstanou v historii.
- Umístění se přenesou: staré a nové služby se párují na stánku podle ABF kódu (obě strany z objednávek), jinak podle identity značky; přednost má stejná objednávka. Přebývající body (výjezd „Do 3kW“ ×2 → dvě položky L03 ×1) přejdou na další shodnou službu, neztratí se.
- Samostatné importy kategorií zůstávají: pozdější výjezd např. elektřiny nahradí jen elektro služby z aktivního importu objednávek, ostatní kategorie se nemění.
- Katalog „Stavby“ (realizační firmy) beze změny.
- Náhled před potvrzením: kontrolní přehled (`AbraOrderImportCheckSummary.tsx`) + seznam nahrazovaných importů + rozdíly (přidáno / odebráno / změna množství) proti dosavadním výjezdům + „Co se vloží do rastru“.

## 4. Skutečný soubor (PDF)

127 objednávek, 151 stran, 942 položek, 207 poznámek. 88 objednávek se stánkem, 39 bez stánku, 17 prázdných.
63 objednávek s technickými službami, **188 technických služeb na 62 stáncích** (elektřina 129, internet 26, úklid 23, voda 9, odpad 1), 0 služeb bez stánku.
Ke kontrole: neznámý kód L63 „BEZ ELEKTRICKÉ ENERGIE“ 6× (V238-31, -35, -48, -68, -95, -102), 4 stornopoplatky R99 (V238-22, -37, -75, -76 — bez technických služeb), 7 položek bez ABF kódu (mj. „Cleaning services“ ve V238-108), 1 varování parseru (V238-10: položka bez kódu s cenou, bez množství).
Opakované položky v jedné objednávce: 4A01 (L21 ×2), 3B04 (L02 ×2), 3C01 (L03 ×2); stánek se dvěma objednávkami: 2A02.

## 5. Otevřené otázky

1. **L63 „BEZ ELEKTRICKÉ ENERGIE“** — není ve schválené tabulce. Vypadá jako ekvivalent červeného X „BEZ elektriky“ z výjezdu elektřiny; zatím se jen vypisuje. Potřebné rozhodnutí: mapovat L63 na příznak „BEZ elektriky“?
2. **Příznak „BEZ elektriky“ po nahrazení výjezdu** — import objednávek tento příznak nemění; po nahrazení výjezdu elektřiny zůstane hodnota z původního výjezdu.
3. **Excel export sestavy** — ABRA ho vytváří chybně (kap. 1); pokud bude potřeba, je nutné opravit export v ABRA.
4. **Položky bez ABF kódu** (např. „Cleaning services“) se nepřevádí — k rozhodnutí ručně.
5. **Kontejn 1100 l (U10)** v souboru není; „vana 3 m3“ U12 1×.
