# Technické rastry — HOTFIX-02: technické značky, ruční kreslení a PDF export

Pracovní dokument hotfixu pro WEB verzi (větev `hotfix/technical-markers-pdf` z `master` 9abd0a0, 29. 10. 2026).
Zadání: schválené technické značky, sbalitelné nespárované položky, ruční značky s poznámkami, upravitelné texty v PDF, vlastní vrstva `ABF – TECHNICKÉ ZNAČKY`, zjednodušená legenda.
Bez změny databázového schématu, bez migrace — vše žije v existujícím JSON dokumentu projektu.

## 1. Technické značky podle schváleného Excelu

- Zdroj: `_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx` (jeden list „Technické značky“, 34 řádků, všechny „Schváleno“). Sloupec legendy (O) je prázdný → legenda jen po kategoriích (kap. 6).
- `domain/technicalRasterServicePresentation.ts` — jedna seřazená tabulka variant (popisek = text v rastru = text v PDF, barva, pravidlo počtu bodů, interní `variantId`). Všechny značky jsou text: „LED“, „Non-stop“, „El.rozvaděč“, „Vrch. Přívod“, „OSV“, „Router“, „Voda“, „Napuš.Bazén“, …
- Dynamický popisek: „Bazén - objem“ → `{množství} m³`, vždy 1 bod. Reimport 3 → 5 ponechá tutéž službu i bod, změní se jen text na „5 m³“.
- Pravidla počtu bodů: „Bazén - přípojka“ a „Bazén - objem“ nově vždy 1 bod, ostatní beze změny (WiFi, odpad, úklid, neznámá kategorie 1 bod; elektřina, IP, INT, Router, Voda podle množství).
- `domain/technicalMarkerApprovedTable.ts` — přepis schválené tabulky (jen názvy služeb, žádná data vystavovatelů); test ji porovnává s generátorem, `npm run test:technical-markers-excel` ji porovná se skutečným Excelem (bez Excelu se přeskočí). Ověřeno: 34/34 shoda.
- Tooltip značky v editoru: „stánek · původní název z ABRA · kategorie“.

### Identita služby oddělená od popisku

| Dříve (kolize) | Nyní |
|---|---|
| Rozvaděč 9-21kW = Do 21kW 400V = `21kw` | `electricity:distribution-board` ≠ `21kw` |
| Non stop = Lednicový okruh = `refrigerated` | `electricity:non-stop` ≠ `refrigerated` |
| Osvětlení / Vrchní přívod / + kW (jen podle textu) | `electricity:lighting` / `electricity:overhead-feed` / `electricity:additional-kw` |
| Internet ≠ Router | beze změny (`internet:plain` / `internet:router`) |

Identity, které nikdy nekolidovaly (`2kw`, `wifi`, `fixed-ip`, `cleaning:daily`, …), jsou bajtově stejné. Identita se nikde neukládá — při reimportu se počítá stejnou funkcí pro starou i novou službu, takže starší projekty se nemigrují a umístění zůstanou (test: prohozené pořadí sloupců, uložený a znovu načtený projekt, původní kolidující identifikátory přes `resolveLegacyServiceIdentityKey`).

## 2. Nespárované položky

`TechnicalStandBuffer.tsx`: „Nespárované položky (N) ▼“ — výchozí sbaleno, počet stále vidět, po otevření seznam s vlastním posuvníkem (max. 260 px), dalším klikem se sbalí. Nic se neodstraňuje ani nepřiřazuje. Stánky, které systém jednoznačně zařadí do jiné haly, jsou dál ve skupině „MIMO AKTUÁLNÍ RASTR“; nejednoznačné zůstávají v Nespárovaných.

## 3. Ruční značky a poznámky

- Bod: puntík ● nebo křížek ×; čára beze změny; tloušťka Tenká/Střední/Silná beze změny.
- Barvy = kategorie technických služeb (Elektřina, Internet / WiFi, Voda, Úklid, Odpad, Neutrální černá) ze společné konfigurace `TECHNICAL_RASTER_COLORS` — žádná druhá paleta.
- Uloženo u každé značky: kategorie, typ, tvar, barva, velikost, poloha, poznámka `{ text, visible }`.
- Poznámka: v pravém panelu „DETAIL RUČNÍ ZNAČKY“ (nástroj Vybrat). Přepínač „Zobrazit poznámku v rastru a PDF“, výchozí vypnuto = interní poznámka (jen v projektu). Zapnuto = text u značky v editoru i v PDF. Poznámka nemá vlastní souřadnice, přesouvá se se značkou.
- Starší ruční značky (před hotfixem) se načtou beze změny: vlastní barva, původní „+“, uložená data se nepřepisují. Výběrem kategorie/tvaru se povýší jen daná značka.

## 4. Upravitelné texty v PDF

- Dříve: popisky jako křivky (CorelDRAW 2018 zahazoval text z pdf-lib `drawText`, což je vždy Type0/CID font `Identity-H`).
- Nyní (`lib/pdf/pdfSimpleTrueTypeText.ts`, nejmenší bezpečná změna, PDF knihovna zůstává pdf-lib): skutečné textové objekty `BT … Tf … Tj … ET` v **jednoduchém TrueType fontu** — `/Subtype /TrueType`, kódování WinAnsi + `/Differences` se standardními názvy glyfů (ě, š, č, ř, ž, ý, á, í, é, ů, ú, ť, ď, ň, ³, …), `/ToUnicode` (vyhledávání, kopírování), celý font NotoSans-Bold (SIL OFL) vložený jako `/FontFile2` (ne podmnožina — při úpravě „5 kW“ → „9 kW“ jsou k dispozici všechny znaky). Žádný obrázek, žádné křivky, žádný Type3.
- Pozice, velikost a barva jsou stejné jako u dřívějších křivek (ověřeno testem i vykreslením).
- Záložní režim: ve Výstupech „Texty jako křivky (záložní režim)“ = dosavadní chování.
- Znak, který font neobsahuje (např. emoji v poznámce), se nahradí „?“.

## 5. Vlastní vrstva `ABF – TECHNICKÉ ZNAČKY`

- Všechny automatické i ruční technické prvky (popisky služeb, červené X „BEZ elektriky“, ruční puntíky/křížky/čáry, viditelné poznámky) jsou v jednom bloku `/OC … BDC … EMC` vlastní vrstvy generátoru `ABF – TECHNICKÉ ZNAČKY`.
- Úprava 30. 10. 2026 po testu v CorelDRAW 2018: původně se značky vkládaly do zdrojové vrstvy `TECHNICKÉ SLUŽBY` a Corel pak ukázal dvě vrstvy stejného jména. Nově se původní vrstva `TECHNICKÉ SLUŽBY` (i se svou kresbou a stavem ON/OFF) **nikdy nepoužívá ani nemění**. Naše vrstva vzniká jednou na export, sdílí ji všechny stránky, je zapnutá a v seznamu vrstev je za všemi zdrojovými. Obsah je vykreslen za zdrojovým obsahem, takže je vždy nad rastrem.
- Export bez technických dat žádnou vlastní vrstvu nepřidá.
- Samostatná vrstva `RUČNÍ ZNAČKY` zanikla. `GENERÁTOR DATA` zůstává jen pro podtržení realizací a legendu v rastru a vzniká jen tehdy, když má obsah.
- Ostatní zdrojové vrstvy: názvy, pořadí, vnoření i stavy ON/OFF beze změny (testy na obou reálných rastrech).
- Technicky: veškerý obsah překryvu se zapisuje jako vlastní operátory do jednoho bufferu na stránku. `page.drawLine()` z pdf-lib zapisuje do jednoho proudu umístěného tam, kde byl poprvé použit, a mohl by tak skončit mimo hranice vrstvy.

## 6. Legenda

„● ELEKTŘINA“ (červená), „● INTERNET / WiFi“ (zlatá), „● VODA“ (zelená), „● ÚKLID“ (fialová), „● ODPAD“ (hnědá) — jen kategorie použité v exportu (služby i ruční značky). „● NEUTRÁLNÍ“ jen při neutrálních ručních značkách. Žádné vzorky „2 kW“ ani vysvětlování zkratek. Realizace zůstává ve vlastním sloupci. Titulek „TECHNICKÝ EXPORT – LEGENDA“ (font nemá dlouhou pomlčku, dřív se tiše vynechávala).

## 7. Testy a ověření

- `npm test`: 3 069 testů — 3 067 prošlo, 0 chyb, 2 přeskočené (chybí soukromý `KODY.xlsm`, nesouvisí). Typecheck čistý, `next build` v pořádku.
- Nové testy: `technicalRasterServiceIdentity`, `pdfSimpleTrueTypeText`, `technicalRasterHotfix02Ui`, schválená tabulka v `technicalRasterServicePresentation`; přepracované testy ručních značek, legendy a PDF (kontroly geometrie písma běží v režimu „křivky“, nové kontroly skutečného textu v režimu „text“).
- Testy na reálných rastrech Hala 1 a Hala 3 (z git-ignorovaného `_IMPORT/`) proběhly.
- Prohlížeč (lokální server bez Supabase/R2, náhradní API, syntetický rastr, reálné Excely FOR BEAUTY): import elektřiny a vody, Nespárované položky (177) sbalené/rozbalené s posuvníkem, umístění služeb stánku 4C06 přes UI („El.rozvaděč“, „21 kW“, „40 kW“, „D“), ruční puntík/křížek/čára, viditelná a interní poznámka, přesun značky i s poznámkou, uložení a znovunačtení, stažený export (text, vrstvy, legenda, interní poznámka v PDF není). Nalezená a opravená chyba: detail značky v liště nad plátnem při výběru posunul plátno → přesunut do pravého panelu.

## 8. Kontrola v CorelDRAW (Windows)

Vzorky (reálný rastr Hala 1, jen lokálně, ne v Gitu): `_IMPORT/TECHNICKE_ZNACKY/KONTROLA_COREL/`
- `Kontrola_Corel_Hala1_TEXT_v2.pdf` (30. 10. 2026, vlastní vrstva) — výchozí režim: 33 schválených popisků služeb (s množstvím 5; bez umělého příkladu „Ostatní“), ruční puntík s poznámkou, křížek s interní poznámkou (nesmí být vidět), čára s poznámkou „Odpad vody 3 m³“, X „BEZ elektriky“, legenda v rastru přes bílé krytí původní legendy (jako výchozí export z UI).
- `Kontrola_Corel_Hala1_KRIVKY_zaloha_v2.pdf` — záložní režim pro porovnání.

Ověřit:
1. Import PDF do CorelDRAW: popisky jsou vidět (nezmizely jako dřív).
2. Popisek jde označit jako text a přepsat („5 kW“ → „9 kW“), česká diakritika a „³“ zůstanou.
3. Správce objektů: vrstva `ABF – TECHNICKÉ ZNAČKY` jen jednou, obsahuje popisky, ruční značky, poznámky i X; původní `TECHNICKÉ SLUŽBY` a ostatní vrstvy rastru zachované beze změny.
4. Vypnutí vrstvy `ABF – TECHNICKÉ ZNAČKY` skryje všechna naše technická data; legenda s bílým krytím je ve vrstvě `GENERÁTOR DATA`.
5. Pokud Corel nahradí font (NotoSans-Bold není nainstalovaný), poznamenat jak — případně nainstalovat Noto Sans Bold.

## 9. Zpětná kompatibilita

- Uložené projekty: bez migrace. Identity služeb se nepersistují; staré ruční značky se čtou beze změny; nové položky (`category`, `pointStyle`, `note`) jsou volitelné.
- Starší kód a nová data: když se **po návratu na 9abd0a0** projekt s novými ručními značkami znovu uloží, starší verze zahodí `category`, `pointStyle` a `note` (barva zůstane, body se vykreslí jako „+“). Bez uložení se nic neztratí.

## 10. Nevyřešené / k rozhodnutí

- Skutečnou editovatelnost v CorelDRAW lze ověřit jen na Windows (kap. 8).
- Starší ruční značky v barvách bez kategorie (modrá, oranžová, …) legenda nevysvětluje, dokud se jim nepřiřadí kategorie.
- Úprava popisků v administraci (`TechnicalRasterComponentConfig`) zůstává nenapojená — mimo rozsah hotfixu.

## 11. Rychlý návrat

- Produkce zůstává 9abd0a0, dokud se hotfix nenasadí. Hotfix je jen lokální commit na `hotfix/technical-markers-pdf`.
- Po případném nasazení: Vercel Instant Rollback na nasazení 9abd0a0, nebo `git revert <commit hotfixu>` na `master`. Lokální značka `prod-before-excel-import` (5f405e0) je předchozí produkce před Excel importem.
- Data: viz kap. 9 — návrat nic nesmaže, jen starší verze při uložení nezachová nová pole ručních značek.
