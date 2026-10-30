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
- **Vícestránkové objednávky:** strany se spojují podle čísla objednávky a čísla strany dokladu („č.“ v hlavičce). První strana musí mít blok odběratele, pokračovací strana musí navazovat na předchozí stranu téže objednávky (č. N+1). Poznámky nahoře na pokračovací straně patří k poslední položce předchozí strany. Stranu, kterou nejde jednoznačně přiřadit (chybí číslo strany, mezera v číslování, opakovaná první strana, pokračování jiné objednávky), parser **neodhaduje**: je v `ambiguousPages` s položkami a varováním, její položky se nenačtou. Chybějící pokračovací strana je varování.
- Pravidla: bez stánku i služby → ignorovat; stánek bez služby → ignorovat; služba bez stánku → zobrazit (firma, objednávka, kód, název, množství), do rastru ne; stánek + služba → načíst. Více objednávek jednoho stánku se sloučí, opakovaná položka zůstává samostatnou službou, nulová cena je platná, stornopoplatek nic neruší (objednávka jde ke kontrole). Neznámé kódy technických skupin (L, I, W, U) a položky bez ABF kódu se nikdy nepřevádí ani neodhadují podle názvu — vypíšou se s objednávkou, firmou, stánkem, názvem, množstvím a původní poznámkou. Mobiliář, registrace, parkování apod. se nepřevádí.
- **L63 „BEZ ELEKTRICKÉ ENERGIE“** = červené X „BEZ elektriky“ (`noElectricityLines`). L63 spolu s objednanou elektrickou přípojkou → rozpor ke kontrole.
- Desetinné množství u služby umisťované po kusech → počet bodů zaokrouhlen nahoru (`requiredPlacementCount`).

## 3. Vztah k dosavadním výjezdům — nic se nemaže

`domain/abraOrderReconciliation.ts` porovná objednávky s rastrem po stáncích a identitě služby (kategorie + varianta značky):

| Případ | Výsledek |
|---|---|
| Služba v obou zdrojích, stejné množství | **Shodná** — nic nového se nekreslí, objednávky se přidají jako další zdroj služby (`TechnicalService.sources`), umístění zůstávají. |
| Jen v nových objednávkách | **Nová služba k doplnění** — přidá se jen po potvrzení (zaškrtnuto předem, lze zrušit). |
| Jen v předchozím výjezdu | Zůstává beze změny, upozornění „Služba je v předchozím technickém výjezdu, ale v nových objednávkách chybí.“ |
| Rozdílné množství | Zobrazí se obě množství a rozdíl; mění se jen po zaškrtnutí (snížení může odebrat přebytečné body — náhled uvádí kolik). |
| L63 jen v objednávkách / v obou / jen v rastru | Nabídne se červené X / shoda / X zůstává s upozorněním. Ručně nastavené X ani X z objednávek výjezd elektřiny nikdy nezruší (`noElectricitySource`). |

- Každý zdroj má vlastní evidenci: import objednávek ukládá své řádky (`TechnicalRasterImport.orderLines`), služba svoje zdroje; detail stánku vypisuje „Zdroje: …“.
- Opakovaný import objednávek: žádné duplicity, umístění a poznámky zůstávají; služba chybějící v nové verzi zůstává jako „jen v předchozím zdroji“. Předchozí import objednávek je jen v historii.
- Výjezd importovaný po objednávkách službu objednávek **potvrdí** (bez duplicitního bodu, rozdíl množství = varování) a jeho další verze nikdy neodebere službu, kterou obsahují aktivní objednávky. Jinak opakovaný import výjezdu nahrazuje svou předchozí verzi jako dosud.
- Náhled před potvrzením (`AbraOrderImportCheckSummary.tsx`): počty (objednávky, rozpoznané služby, stánky, nové, shodné, jen v předchozích výjezdech, rozdílná množství, neznámé/bez kódu, bez stánku, nejednoznačné strany PDF), u každého rozdílu zdroj, zaškrtávání změn, tlačítko „Potvrdit vybrané změny“.

## 4. Skutečný soubor (PDF)

127 objednávek, 151 stran (103 jednostránkových, 24 dvoustránkových), všech 151 stran přiřazeno, 0 nejednoznačných. 942 položek (935 s kódem), 207 poznámek. 88 objednávek se stánkem, 39 bez stánku, 17 prázdných.
69 objednávek s technickými službami nebo L63, **188 technických služeb na 62 stáncích** (elektřina 129, internet 26, úklid 23, voda 9, odpad 1), 0 služeb bez stánku.
L63 6× (V238-31, -48, -68, -95, -102 se stánkem; V238-35 bez stánku), 0 neznámých kódů. Ke kontrole: 4 stornopoplatky R99 (V238-22, -37, -75, -76 — bez technických služeb), 7 položek bez ABF kódu, 1 varování parseru (V238-10: položka bez kódu s cenou, bez množství).
Opakované položky v jedné objednávce: 4A01 (L21 ×2), 3B04 (L02 ×2), 3C01 (L03 ×2); stánek se dvěma objednávkami: 2A02.

## 5. Otevřené otázky

1. **Ruční nastavení „BEZ elektriky“** — model zdroj „ručně“ podporuje, ovládání v editoru zatím není.
2. **Excel export sestavy** — ABRA ho vytváří chybně (kap. 1); pokud bude potřeba, je nutné opravit export v ABRA.
3. **Položky bez ABF kódu** (např. „Cleaning services“) se nepřevádí — k rozhodnutí ručně.
4. **Kontejn 1100 l (U10)** v souboru není; „vana 3 m3“ U12 1×.
