# HWS SEE – navazujici upravy rozhrani (po P0–P3)

## Kontext a zaklad

Pracuj **pouze** v puvodnim projektu `homeworkstudio-app-web` (HWS APP WEB), na vetvi `feature/hws-see-mvp`, navazujici na lokalni commit `2a533de` (HWS SEE P0–P3). Nejde o `HWS APP`/ABF DEV. Pred upravami si precti `tools/hws-see/STATUS.md`, `IMPLEMENTATION.md`, `DEPLOYMENT.md`, projdi existujici kod a Git stav. Neměň v historii hotovy commit, nevytvarej dalsi projekt. Upravy implementuj do jiz existujiciho modulu HWS SEE. Vzor vzhledu stavajiciho verejneho vieweru, včetně cervene a zelene rucni anotace, je v `tools/hws-see/reference-viewer-markup.png`.

**Cil:** Doladit uzivatelem otestovany HWS SEE. Dosavadni viewer, publikace (verejna / PIN), stahovani dokumentu, editor, lokalni backend, bezpecnost, R2 a embed musi nadale fungovat. Nove funkce musi byt v editoru nastavitelne a ve verejne prezentaci odpovidajicim zpusobem vykreslene.

## A. Dynamicky pocet modelu / scen – zasadni oprava

Soucasny formular ma 3 pevne karty pro modely, ale ty byly pouze priklad. **Zacina se JEDNOU polozkou a uzivatel si dalsi sam pridava tlacitkem `+ Pridat dalsi model`.** Muze mit napr. 1, 2, 3, 5 i vice modelu, bez pevneho limitu na tri.

- Kazda scenova polozka ma svuj nazev a vlastni GLB soubor, nastaveni kamery, nasviceni, 3D popisky a vazby na dokumentaci. Pri vytvoreni zacni jedinym prazdnym modelem. Zachovej existujici limity na velikost **jednotlivych** souboru a rozumne technicke bezpecnostni limity (celkova velikost/kvoty/prevence zneuziti), ale neomezuj sceny natvrdo na 3.
- Umozni pridat, prejmenovat, odstranit a **zmenit poradi** scen (tlacitka nahoru/dolu jsou prijatelna alternativa k drag-and-drop). Také po vytvoreni projektu v editoru, nikoli jen v uvodnim wizardu. Posledni povinnou scenu nesmazat bez rozumneho reseni a potvrzeni.
- Identita sceny musi byt stabilni a nezavisla na poradi – presun nesmi ztratit body/popisky, obrazky ani prirazeni dokumentu. Odstraneni sceny nesmi smazat soubory prirazene i dalsim scenam nebo projektu. Pokud existuje vazba na odstranenou scenu, vyres ji vyslovne a bezpecne.
- Priřazeni dokumentace: `Vsechny modely` nebo jedna/vice konkretnich scen dle skutecneho poctu. Zachovat spravne filtry pri stahovani, publikaci a embedu.
- V editoru i verejnem vieweru se horni prepinac modelu sestavi z dynamickeho seznamu. Pouzitelnost pri mnoha scenach (horizont. posun nebo nabidka), klavesnice a mobil.
- Zkontrolovat vsechny frontend, backend, upload, validacni schema, perzistenci, publikacni snapshot a bezpecnostni kontroly, testy i databazovou migraci kvuli pripadnemu `max 3` (kontrola i v SQL). Stavajici lokalni projekty s 1–3 modely museji zustat funkcni.
- Modely jsou samostatne **prepinane sceny**, ne soucasne viditelne vrstvy geometrie.

## B. Tlacitko zobrazit/skryt 3D popisky – pouze ikona

Ve verejne prezentaci v dolni liste je dnes ikona pripominajici GPS/map-pin. Ve skutecnosti **uz spravne ovlada viditelnost popisku** a funkcne se nemá menit.
- Vymen jen ikonku za srozumitelnou ikonu textoveho popisku, napr. `message-square-text` nebo podobny textovy symbol stavajici ikonove sady.
- On/off stav jasne vyznac (ztlumeni / preskrtnuti / aktivni styl) a pridej pristupny tooltip a `aria-label`.
- Nepridavat GPS, geolokaci, koordinaty ani polohove funkce.

## C. Skryt dev znacek Next.js

Na lokalnim `npm run dev` zobrazuje Next.js kruhovou ikonku `N` dole vlevo; uzivatel si ji nepreje mit pri prezentovani. Vhodne vypni **jen vyvojovy indikator** (`devIndicators: false` v Next konfiguraci, pokud je tato moznost kompatibilni s aktualni Next verzi); zachovej ostatni dev diagnostiku a chovani aplikace. V produkci se indikator standardne nezobrazuje. Neodstranovat cele dev nastroje ani nechytat chybove hlasky.

## D. Rychla navigace kamery vpravo nahore (cervene oznaceno)

Na referencnim screenshotu je vpravo nahore cervene oznacena oblast. Sem patri kompaktni panel pro **preddefinovane pohledy kamery**:
- `Vychozi / 3D`, `Predni (celo)`, `Zadni`, `Levy`, `Pravy`, `Horni`, `Spodni`.
- Po kliknuti se kamera plynule presune do daneho pohledu na **aktualni model**, pri zohledneni jeho bounding boxu, stredu, meritka a up-vectory. Modely mohou byt velmi male, obrovske i mimo pocatek souradnic.
- Zachovat obvykle ovladani kamerou mysi a dotykem. Při prepnuti modelu fungují predvolene pohledy nezavisle. Nepridavat animaci samotneho modelu ani neurcovat skryte geometricke modifikace.
- Pohledy nesmeji zakryvat ostatni ovladaci prvky a museji fungovat i pri fullscreen a embedu; na mobilu pouzij kompaktni nabídku nebo ikony s pristupnymi popisy.
- Technicke +X/-X, +Y/-Y, +Z/-Z vyber konzistentne dle skutecneho vieweru a orientace jeho kamery. Vhodne otestuj na ZARGES, testovacim GLB a modelu posunutem daleko od nuly. Pokud jsou osy importu nestandardni, alespon zachovej konzistentni pojmenovani a moznost adminem urcit vychozi modelovou orientaci je volitelna, neni nutna pro v1.

## E. Volitelny vysuvny informacni panel vpravo (zelene oznaceno)

Na referencnim screenshotu je vpravo zelene oznacena velka oblast. Nejde o stale viditelny sloupec; ma byt **zavreny v zakladu**.

- Ve verejnem vieweru mala ovladaci ikonka/sipka u praveho okraje. Po kliknuti se vysune postranni panel s informacemi, opakovanym kliknutim / X se zavre.
- **Po kazdem prvnim otevreni verejne prezentace i pri prepnuti na novy projekt je panel vychoze zavreny.** Nesmí zakryt model automaticky. Muze se pri prepinani mezi scenami zachovat uzivatelem rucne otevreny stav v jedne prezentaci, ale novy vstup je vzdy zavreny.
- Volitelnost na urovni projektu (zapnuto/vypnuto). Pokud je vypnuty nebo prazdny, trigger se ve verejne prezentaci vubec nezobrazi.
- Obsah nastavitelny v administraci: **nadpis, formatovany text / odstavce, obrazek, jeden ci vice klikacich odkazu**. Umozní projektovy společny obsah a volitelne odlisny obsah pro konkretni model; urci zretelne pravidlo fallbacku. Text bez nebezpecneho HTML.
- Panel vhodne 320–420 px (responzivne), lze scrollovat, zavirat kliknutim a Esc, nebrani otaceni zbytku modelu. Na mobilu vhodny vysouvaci drawer/bottom-sheet s bezpecnymi okraji displeje.
- Volitelnou funkci musi obsluhovat editor (nastaveni obsahu a nahled), server, publikacni snapshot, verejne zobrazeni a embed. Do PIN prezentace musi zustat vsechen souvisejici obsah chraneny.

## F. Obrazky a URL uvnitr stavajicich 3D popisku

Stavajici bodove popisky a jejich pozice neměň; jen rozsirit jejich obsah:
- Kazdy hotspot muze obsahovat puvodni **nazev a text**, plus **volitelny obrazek** (JPG/PNG/WebP), plus **volitelny webovy odkaz** (napr. tlacitko `Vice informaci`).
- Pro obrazek rozumny limit, navrh **5 MB na soubor** s validaci MIME i signatury obsahu; optimalizovany nahled / resize pri nahrani, pokud to stavajici infrastruktura umoznuje. Vykresleni automaticky `object-fit: contain` nebo `cover` s zachovanim pomeru stran, max. rozmery dle panelu; zadne zdeformovani ani obri presahy. Na mobilu panel popisku citelny.
- Link akceptuje pouze bezpecne absolutni `https://` URL (popr. `http://` jen pro lokalni development, ne ve verejne produkci). Renderovat bez vlozeneho HTML nebo skriptu, otevrit v nove zalozce s `rel=noopener noreferrer`.
- Obrazky bezpecne ulozit/servirovat v **local** i **R2** rezimu a kontrolovat opravneni stejne jako GLB a dokumenty; PIN a zruseni publikace museji platit i pro media informacniho panelu a popisku. Zadna neautorizovana verejna R2 URL pro soukroma data.
- Pri editaci a publikovani zachovat stare popisky bez obrazku/URL, nevyzadovat doplneni novych poli. Po kliknuti na popisek se nove prvky objevi i ve verejnem vieweru a embedu.

## G. Bezpecnost, integrita, schema a testy

1. Před zmenami zkontroluj stavajici P0–P3 strukturu, data modely, publikacni snapshoty, lokalni backend a aktualni testy; vsechna rozhodnuti udelej podle realne implementace.
2. HWS SEE zatim nema nasazenou Supabase migraci (dle predchoziho reportu); pokud se to stale potvrdi, uprav existujici dosud nenasazenou migraci nebo pridavej nove izolovane migrace podle situace. **Nikdy nespoustej migraci proti vzdalenym DB.** Uprav i rollback / migracni testy a dokumentuj potrebne nasazovaci kroky.
3. Zachovej stavajici verejny a PIN rezim, rate-limit, bezpecnost pristupu k souborum, okamzite zneplatneni, lokalni zalohy rozpracovanych dat, verejne statistiky, embed per project allowlist, publikacni flow i kompatibilitu se stavajicimi projekty.
4. Stavajici EASY, ABF, launcher a spolecny login neměň, mimo nezbytnou izolovanou konfiguraci dev indicatoru. Ani omylem nezakladej druhy login nebo dalsi app.
5. Doplň testy pro libovolny pocet scen, jejich presuny, vazby dokumentu, publikaci, panel default closed, nastaveni panelu, rychle pohledy, formatovani obrazku, bezpecne URL a pristup k souborum pri PINu / odvolani.
6. Ověř uzivatelske toky v realnem lokalnim prohlizeci, pokud to lze: pridat 1→2→5 scen, prohodit, odstranit, znova nacist editor, prepinat modely i v public/PIN, panel default closed, popisek s obrazkem a odkazem, kamerovy prechod, fullscreen, mobil.
7. Spust typecheck, testy, produkcni build. Neopravuj nesouvisejici soubory. Prepisy generovanych souboru (napr. `next-env.d.ts`) provaděj bez ztraty cizich neulozenych zmen.
8. Aktualizuj `tools/hws-see/STATUS.md`, `IMPLEMENTATION.md` a případne `DEPLOYMENT.md` s vysledky a novymi polozkami pro nastaveni serveru.
9. Pokud vse projde, po prohlidce `git diff` a kontrole tajnych dat vytvoř **jeden novy lokalni commit** na stavajici feature vetvi. Vypis SHA, pocet testu, zbyvajici blokery. Pri selhani bezpecnostnich testu NEcommituj jako hotovo; oprav nebo popis blokaci.

## H. Bezvyjimecne hranice

- **ZADNY push, zadny Vercel/Cloudflare/R2/DNS deployment, zadne vzdálené migrace, zadne editace produkcnich uctu/hesel nebo externich nastaveni.**
- Neprovadej destruktivni Git operace (`reset --hard`, `clean -fd`, prepnutim na jinou vetev neodhazuj zmeny). Nevymazavej `.see-local/` ani jiná uzivatelska data.
- Pracuj jen v `homeworkstudio-app-web` / `feature/hws-see-mvp`.
- Pokud je prace technicky blokovana, nepředstirej implementaci. Zaznamenej blokery. Zachovej P0–P3.

## Akceptacni podminky

Hotovo znamena: na `/see/new` je **jedna** vychozi polozka modelu + tlacitko dalsi, libovolne sceny jdou spravovat i dodatecne; verejny viewer ma horni navigaci predni/zadni/levy/pravy/horni/spodni/vychozi; GPS-looking ikonka je nahrazena ikonou popisku beze zmeny funkce; Next.js dev `N` nerusi lokalni prezentaci; novy **volitelny pravy informacni panel je ve vychozim stavu ZAVRENY** a umi text, obrazek, linky; bodove popisky umi text + obrazek + bezpecny link. Vse funguje take pri PIN publikaci i v embedu a neporusi existujici data ani ostatni moduly.
