# HWS SEE — implementační zadání pro Claude Code

Datum zadání: 21. 11. 2026. Cíl: funkční první verze do neděle 22. 11. 2026 (časový cíl, ne důvod vynechat bezpečnost).

## 0. ÚKOL PRO CLAUDE: ZAČNI INSPEKCÍ EXISTUJÍCÍHO KÓDU

Jsi senior full-stack vývojář v EXISTUJÍCÍM repozitáři portálu Homework Studio, provozovaném na `app.homeworkstudio.cz`. Tvým úkolem je IMPLEMENTOVAT nový interní modul **HWS SEE**; nejde o izolovanou demo aplikaci ani o nový repozitář.

1. Nejdřív projdi `package.json`, monorepo/workspace, router, současný launcher/rozcestník s kartami ABF Generator a HWS Easy, současný produkční lehký login, admin rozhraní, API, databázové migrace, úložiště, stylování a deployment config. Existující skutečnost má přednost před domněnkami v zadání.
2. Vytvoř krátký plán v `tools/hws-see/IMPLEMENTATION.md` včetně zjištěného stacku, existujícího přihlášení, rout, databáze, úložiště a reálných blokérů. **Neskonči pouze plánováním**: po analýze implementuj.
3. Pracuj na samostatné feature branch `feature/hws-see-mvp`, pokud to Git a stav stromu dovolují. Nikdy automaticky neschovávej, nemaž, neresetuj ani nepřepisuj cizí rozpracované změny; při kolizi zachovej práci a uveď konflikt. Žádné destruktivní migrace.
4. Zachovej beze změny funkčnost ABF Generatoru a HWS Easy. Použij existující UI komponenty, menu, routing, testovací framework a vzory repozitáře. Nic nepřepisuj plošně kvůli novému modulu.
5. Nedělej automatický deploy, push, merge, zápis do produkční databáze ani změny DNS. Nevypisuj tajné klíče, nic citlivého necommituj. Připrav migrace a `.env.example` pouze se jmény proměnných.
6. Dodávej skutečně funkční end-to-end řešení tam, kde již existují konfigurace. Nefunkční funkce se nesmějí tvářit jako hotové: jasně ukaž chybějící integraci a její konfiguraci. Stávající login neopravuj nahrazením novým Supabase DEV loginem.

## 1. PRODUKTOVÁ ARCHITEKTURA

Existující portál: společný login -> rozcestník ABF Generator / HWS Easy. Přidej jako **třetí kartu vedle HWS Easy** ikonu krychle a název **HWS SEE**. Zaregistruj Viewer také do EXISTUJÍCÍHO katalogu modulů/aplikací a do správy aplikací/oprávnění přihlášeného účtu, pokud takový registr v kódu již existuje. Pokud žádný per-account registry/administrace dnes v produkčním lehkém loginu neexistuje, nezaváděj fikci: zobraz Viewer za stávajícím loginem, vytvoř přenositelné mapování `hws_see` entitlement a stručně popiš dopojení do budoucí jednotné administrace. Nezasahuj do pravidel ABF/EASY.

Cílový vnitřní tok:
`Portál /` -> `HWS SEE` -> dvě jasné volby **Nový projekt** a **Projekty** -> editor projektu -> publikace.

Preferované URL (adaptuj podle routeru a konfliktních rout):
- `/see` — přehled modulu;
- `/see/new` — nový projekt;
- `/see/projects` — seznam projektů;
- `/see/projects/[id]` — editor projektu;
- `/see/p/[shareSlug]` — veřejný či PINem chráněný prohlížeč;
- `/see/embed/[shareSlug]` — responsive iframe varianta.

Všechny editovací a administrační cesty jsou chráněné **současným portálovým přihlášením**; žádný druhý login pro HWS SEE. Veřejné `/see/p/*` a `/see/embed/*` musí fungovat bez portálového loginu, ale stále dodržují status publikace a případný PIN. Pozor na middleware, který dnes chrání celý portál — udělej explicitní, dobře otestované výjimky pouze pro veřejné routy a pro nezbytné, správně autorizované API.

**Připravenost na budoucí jednotný login:** vytvoř jasný adapter/vrstvu `currentUser`, `requireViewerEditor` / `requireViewerAdmin`, auditní metadata a rozšířitelný mapping uživatel/role. Nepřipojuj dnešní samostatné DEV Supabase Auth; nezaváděj duplicitní uživatelské účty. Pokud dnešní lehký login neprokazuje identitu na serveru, NESMÍ být na jeho základě nechráněný zápis do DB; doplň serverové session ověření kompatibilní s existujícím UX, případně funkci poctivě označ jako blocker do zprovoznění — nikdy nevydávej klientské schování tlačítek za zabezpečení.

## 2. NOVÝ PROJEKT

Jednoduchý wizard / formulář:
- Povinný **Název projektu**, volitelný **Popis**;
- upload **až 3 nezávislých GLB** modelů pro první verzi (základní návrh počítej jako jeden projekt a více scén, aby šlo později přidat další modely);
- každý model má vlastní pojmenování, pořadí, původní soubor, úvodní kameru, světla, pozadí, anotace a volitelný popis;
- modely lze přejmenovat, vyměnit, odstranit, přeuspořádat;
- nahrání dokumentace PDF/JPG/PNG v libovolném rozumném počtu, s nastavením `Všechny modely` nebo konkrétní vybrané modely. Metadata a vztahy spravuj samostatně od souborů;
- tlačítko **Uložit a otevřít pracovní náhled**.

Nahrání souborů musí být reálné, serverem ověřené (velikost, typ, oprávnění), s indikací průběhu/chyb a bezpečným ukládáním; nepřijímej libovolné souborové formáty. Pro první verzi `.glb` (s vestavěnými či standardně podporovanými texturami), dokumentace `.pdf`, `.jpg`, `.jpeg`, `.png`. Vlastní limity nakonfiguruj a zobraz v UI. Podporuj více souborů s oddělenými záznamy.

## 3. EDITOR A 3D PROHLÍŽEČ

Po uložení se otevře pracovní editor, nejlépe velký 3D canvas a **horní přepínače** modelů (např. Zavřená bedna / Otevřená bedna / Pohled dovnitř). **Vpravo editační panel** se záložkami podle možností existujícího UI, minimálně:
- **Model:** název scény, popis, nastavení pořadí, výměna GLB;
- **Zobrazení:** uložit výchozí polohu kamery, pozadí, osvětlení/HDRI či studiové světlo, reset kamery, přizpůsobit model;
- **Popisky:** seznam poznámek a režim kliknutí do geometrie modelu = vytvořit 3D bod (raycast, skutečná 3D pozice v lokálních souřadnicích scény), název, text, aktivace, editace, smazání, volitelně skrytí anotací;
- **Dokumentace:** nahrát, přejmenovat, odstranit, označit vztah ALL/model IDs.

Kvalita: skutečný WebGL viewer s PBR materiály, texturami a korektním osvětlením, orbit/pan/zoom, resize a fullscreen. Vhodné řešení: `three` + `@react-three/fiber` + `@react-three/drei`, pokud je aplikace React; neinstaluj druhou implementaci, pokud repo již používá vhodný engine. Podpora GLB; Draco/Meshopt/KTX2 volitelně podle modelů a konfigurace. U rozsáhlých modelů loading state, error state, resource disposal, omezení náročných efektů na mobilech. Zajisti fungující dotykové ovládání.

Jde o tři **alternativní 3D scény v jednom vieweru**, nikoli o tři modely renderované přes sebe. Přepnutí zachová příslušné nastavení scény, popisky jsou vždy modelově specifické. V budoucnu lze doplnit uložené pohledy bez dalšího GLB.

## 4. PUBLIKACE A SOUKROMÍ — PŘESNĚ DVA REŽIMY

**Povinné produktové pravidlo: existují POUZE DVA režimy publikace:**
1. `public` — **Veřejná prezentace (kdokoli s odkazem)**. Po zveřejnění ji lze otevřít bez portálového loginu a bez PINu; kvůli náhodnému slugu a `noindex` se nezobrazuje automaticky ve vyhledávačích, ale kdo odkaz získá, má přístup. NENÍ to tajná/soukromá prezentace.
2. `pin` — **Chráněná prezentace (PIN)**. Na stejném veřejném odkazu je nejprve obrazovka pro PIN. Dokud server nepotvrdí správný PIN, NELZE načíst ani model, ani anotace, ani PDF/JPG/PNG, ani vygenerovat přístupný download či presigned URL.

**ŽÁDNÝ třetí režim pro uživatelské heslo, přihlášení zákazníka nebo whitelist adres.** Autor/administrátor pracuje přihlášen přes aktuální lehký portálový login. PIN chrání jen publikaci pro externí návštěvníky.

Stav návrhu `draft`, `published` a projektový stav `active`, `paused`, `archived`, `deleted` (nebo ekvivalent s konzistentními pravidly). `paused`/`archived`/`deleted` nikdy nesmí zpřístupnit veřejný viewer ani soubory. Zrušením publikace přístup ihned končí.

Nastavení v editoru:
- jasný přepínač **Veřejné / Chráněné PINem** + tlačítko **Publikovat**;
- při režimu `pin` vygenerovat dostatečně silný **číselný PIN** (doporučeno 8+ číslic, 6 jen při účinném rate limitu). Umožnit správci nastavit/vygenerovat nový PIN. Na veřejné stránce PIN nikdy nezobrazit;
- **bezpečný jednosměrný hash PINu se solí** na serveru, kompatibilní s reálným runtime (Argon2id, bcrypt nebo prověřená PBKDF2 s vysokým počtem iterací); nikdy neukládat PIN v plaintextu ani do repozitáře, logů, query stringu nebo analytiky;
- limitovat chybné pokusy po serverové straně, přidat vhodné zpoždění/lockout a odolnost proti bruteforce; po úspěšném zadání vytvořit krátkodobý přístup omezený na konkrétní publikaci. Preferuj Secure, HttpOnly cookie pro běžnou stránku. U cross-site iframe počítej s blokováním third-party cookies a navrhni/implementuj bezpečný fallback, nesmí obejít kontrolu PINu;
- krátkodobá přístupová oprávnění a správná autorizace každého GLB/PDF/JPG/PNG requestu. Při změně PINu, unpublish, pause/archive okamžitě zneplatni aktivní granty (včetně přístupu k souborům přes proxy); pokud používáš presigned URL, musí být velmi krátké a riziko jejich dočasné platnosti jasně zdokumentováno;
- odkaz s dlouhým náhodným share tokenem/slugem, nikoli sekvenční ID, URL bez PINu;
- **Kopírovat odkaz**, **Kopírovat pozvánku** a **Zkopírovat PIN** pouze v okamžiku jeho vytvoření/změny nebo z výslovně bezpečně řešeného jednorázového zobrazení. Uložený PIN z hashe později nejde získat; pro novou pozvánku lze PIN přegenerovat. Prostý návrh pozvánky: odkaz a PIN sdělit zvlášť. Bez funkční konfigurace e-mailového providera neposkytovat falešné 'Odeslat email'; nabídnout kopírovatelné texty;
- veřejná prezentace a chráněná prezentace používají stejný viewer UI po autorizaci;
- publikovaný obsah má být snapshot/revize: rozpracované změny se nemají nekontrolovaně promítnout do již publikovaného obsahu;
- opakované publikování může zachovat stejný odkaz, explicitní rotace odkazu a zneplatnění musí fungovat;
- `noindex` pro veřejné sdílení; žádná nebezpečná veřejná R2 bucket ACL ani volné proxy endpointy; bezpečné autorizované streamování nebo krátké signed URL;
- žádné skryté přístupy skrze JS/CSS, neomezuj oprávnění jen na základě zobrazení tlačítka; data mimo autorizační kontext nesmí uniknout;
- minimalizované GDPR-friendly statistiky bez surových IP.

**Akceptace:** v anonymním okně veřejný odkaz funguje okamžitě. U stejného projektu přepnutí na PIN způsobí, že bez správného PINu selžou i přímé requesty na modely a dokumentaci. Po změně PINu starý PIN nefunguje. Pozastavení/unpublish zablokuje oba režimy.

## 5. VEŘEJNÝ VIEWER A EMBED

Zákaznická stránka:
- Zabere dostupnou plochu **celého okna browseru** (bez administračního panelu, s responzivním ovládáním);
- vlevo nahoře či v horní liště jasné přepínání mezi modely;
- standardní ikonky: orbit/reset view, fullscreen, zobrazení/skrytí popisků, informace, **download dokumentace**;
- download dropdown ukazuje pouze PDF/JPG/PNG přiřazené aktivnímu modelu nebo ALL; soubory skutečně stahuje, mají jasný název/typ; zbytek je skryt;
- anonymní veřejný návštěvník nevidí editaci, API pro admin, názvy interních objektových klíčů ani jiné projekty;
- přímý odkaz na veřejné stránky má kvalitní mobilní zobrazení a explicitní chybové stavy (neexistuje / pozastaveno / PIN / špatný PIN / přístup vypršel).

Embed: generuj kopírovatelný úryvek `<iframe>` s konfigurovatelnou šířkou/výškou (např. `100%` / `650px`, případně jiný rozměr). Route `/see/embed/[shareSlug]` zobrazuje pouze viewer a při PIN ochraně i odemykací formulář, vše bez portálového loginu. Zabezpeč policy iframe s možností seznamu povolených hostitelských domén nebo jasným nastavením embed policy (CSP `frame-ancestors` / kompatibilní response headers); nedovol zobrazit administrační části v iframe.

## 6. STRÁNKA PROJEKTY

Přehledná tabulka/karty projektů:
- Název, popis, stav (`draft / published` a `active / paused / archived`), počet modelů a příloh;
- kdo vytvořil, kdy vytvořil, kdo naposledy upravil, kdy upravil, datum publikace, počet návštěv;
- akce Otevřít editor, Náhled, Publikovat/Zrušit publikaci, Kopírovat odkaz, Pozastavit/Obnovit, Archivovat/Obnovit, Smazat (potvrzení a přednostně soft delete);
- filtrování nebo hledání a základní stránkování;
- pro statistiku minimálně počítadlo skutečných otevření publikované stránky, ne každého načteného GLB requestu. Návštěvnost a případné přibližné unikátní návštěvy řeš privacy-friendly bez ukládání surových IP, s omezením botů/refreshů podle dostupných prostředků.

Vlastnictví/autora ber pouze z autentizované identity. Pokud je aktuální systém loginu neidentifikovatelný, vytvoř bezpečný placeholder nebo přiznaný stav „současný portálový účet“; **nevymýšlej** falešné osobní záznamy.

## 7. DATA, SOUBORY A PROVOZ

Reálně zkontroluj existující DB/storage/deploy. Preferuj opakované využití produkční infrastruktury portálu a stejného Cloudflare účtu, ale **odděl modul datově** od ABF Generatoru:
- vlastní DB tabulky/schema `see_projects`, `see_scenes`, `see_annotations`, `see_files`, `see_file_scene_links`, `see_publications`, `see_access_grants` a anonymizované `see_events` či přiměřená varianta;
- existence vlastní migrační sady a návodu; zachovat existující tabulky ABF beze změny;
- Cloudflare R2 pouze když je v infrastruktuře vhodný; preferuj samostatný bucket `hws-see-*` nebo jasný izolovaný prefix a tokeny s minimálními právy;
- pro browser upload velkých GLB preferuj serverem vydaný krátce platný **presigned PUT** s ověřeným cílem, velikostí a typem, případně jinou existující prověřenou cestu; R2 CORS musí povolit skutečnou doménu;
- autorizované načítání a stahování; URL na objekty nesmí být veřejně trvalé;
- doporučený SDK jen pokud odpovídá aktuálnímu runtime, žádné hardcoded účty, ID projektů, tokeny či klíče;
- založ `.env.example` nebo přidej potřebné proměnné ke stávajícímu vzoru, nikdy skutečné secret hodnoty;
- logování chyb nesmí obsahovat PINy/objektové tokeny;
- auditovatelné created_at/updated_at/published_at/created_by/updated_by tam, kde to data a dnešní login umožní.

**DEV vs produkce:** nezapojuj natvrdo DEV Supabase projekt ABF ani nepřepínej produkci na jinou auth službu. Nové migrace se nepouštějí automaticky do produkční databáze. Připrav postup od DEV kontroly po publikaci na Cloudflare.

## 8. UX / VIZUÁLNÍ STYL

Navazuj na existující design portálu (shadcn/ui, pokud je skutečně nainstalován). Karty na launcheru stejného rozměru, HWS SEE vedle HWS Easy. V modulu jednoduché menu **Nový projekt** / **Projekty**. Pracovní editor s velkým viewerem, nahoře přepínače modelů, vpravo panel. Žádné rozsáhlé designové experimenty. Česky psané popisky a chyby, rozumné zobrazení na telefonu i desktopu. Pracovní náhled musí zobrazovat nepublikované projekty jen jejich oprávněným editorům.

## 9. DODACÍ POSTUP A PRIORITY

### P0 — nejdřív end-to-end kostra
- Prohlédnout repo; napsat reálný `IMPLEMENTATION.md`.
- Přidat kartu HWS SEE na launcher vedle HWS Easy, registraci aplikace/účtu do existující administrace (pokud existuje), a nové routy bez porušení ABF/Easy.
- Funkční Nový projekt: název, popis, nahrání 3 GLB a příloh, persistovat metadata.
- Funkční pracovní viewer se 3 modelovými záložkami, základními kamerami a ovládáním.
- Projekty: list + editace + základní statusy.

### P1 — publikace a zabezpečení
- Anotace do 3D souřadnic, ukládané parametry scén.
- Publikace, veřejný a PINem chráněný viewer, serverová kontrola přístupu ke všem souborům, PIN, download filtrován na model.
- Embed se zvolenou velikostí, kopírování odkazu/pozvánky, počítadlo návštěv.

### P2 — kvalita a dokončení
- Kvalitní PBR/HDRI, loader/error/empty states, mobile/touch/fullscreen.
- Přehled autorů/datumů/aktivní/pozastavené/archivované/mazání.
- Testy jednotkové a integrační/end-to-end dle frameworku repozitáře, typecheck/lint/build.
- Dokumentace nasazení Cloudflare/R2, potřebné env, migrace, CORS, kroky pro produkci.

Nedělej pouze mock UI a nepředstírej, že produkční R2/DB/e-mail fungují, pokud nejsou nakonfigurovány. Rozděl funkcionalitu na skutečně funkční části a jasně označené blokéry.

## 10. AKCEPTAČNÍ SCÉNÁŘ

1. Jako člověk přihlášený stávajícím lehkým portálovým loginem vidím vedle EASY kartu HWS SEE.
2. Kliknu na Viewer -> Nový projekt -> vyplním `ZARGES 40863`, popis -> nahraju `closed.glb`, `open.glb`, `inside.glb` (souborové názvy jen příklad, žádná závislost na jejich existenci).
3. Nahraju `navod.pdf` (ALL) a `vnitrni-detail.jpg` (jen inside) -> otevřu pracovní náhled.
4. Přepínám všechny tři modely a otáčím s nimi; pro druhý model nastavím kameru a vložím popisek na konkrétní místo geometrie; vše se po znovunačtení zachová.
5. Publikuju jako veřejné -> inkognito bez portálového loginu zobrazí pouze publikované modely, anonymní návštěvník může zobrazit popisky a stáhnout povolené přílohy.
6. Při inside vidím v downloadu ALL i `vnitrni-detail.jpg`; při closed/open jen ALL.
7. Přepnu na PIN -> inkognito nesmí načíst 3D data ani PDF/JPG před zadáním platného PINu; špatný PIN má omezení pokusů.
8. Zkopíruju embed a vložím iframe na testovací HTML; widget je responsivní; při privátním režimu se ptá na PIN.
9. Projekt pozastavím -> veřejný odkaz, embed i download skončí serverovou blokací. Obnovení je zřejmé a kontrolované.
10. Vidím v Projektech autora (je-li z dnešní session identifikovatelný), vznik/publikaci, status a minimálně počet otevření.
11. Starý ABF a HWS Easy stále fungují; build, lint, relevantní testy projdou.

## 11. POVINNÝ ZÁVĚREČNÝ REPORT CLAUDE

Na konci napiš stručnou českou zprávu: co je doopravdy implementováno (s routami), co lze spustit a otestovat, co zbývá P0/P1/P2, přesné příkazy pro `dev`/test/build dle projektu, soubory migrací/env, potřebné kroky v Cloudflare/R2/DB a hlavní bezpečnostní omezení. Zapiš ji také do `tools/hws-see/STATUS.md`. Kde chybí externí infrastruktura, uveď blocker — NIKDY nevydávej fake API za hotový backend.

## 12. FINÁLNÍ POJMENOVÁNÍ A ZÁSADY ZMĚNY (21. 11. 2026)

- Viditelný název produktu je **HWS SEE** (ne „HWS Viewer“). Používej jej v kartách, titulcích, navigaci, metadatech a popiscích.
- Interní název modulu je `hws-see`, datový prefix `see_`, preferované routy `/see/*`, podle skutečné architektury a rizika kolizí je možné sjednotit alias/redirect.
- Spouštěcí zadání leží `tools/hws-see/SPEC.md`; dokumentace `IMPLEMENTATION.md` a `STATUS.md` patří do `tools/hws-see/`.
- Nový modul přidáváme do **PŮVODNÍHO EXISTUJÍCÍHO HWS REPOZITÁŘE, NIKOLIV DO ABF DEV PROJEKTU**. Nikdy nepracuj v jiné složce jen kvůli podobnému názvu.
- Pro sdílení přes internet jsou jen **PUBLIC** a **PIN**; žádný zákaznický login a žádné samostatné heslo.
- Nesmíš měnit původní lehký login bez nutnosti; zachovej jeho uživatelský tok a doplň bezpečnost na serveru.
