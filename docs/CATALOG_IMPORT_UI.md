# Import katalogového Excelu z administrace (V1-IMPORT-UI-01)

**Kde:** Administrace → Katalog → **Import Excelu** (adresa `/abf#/administrace/katalog/import`), nebo tlačítko **Importovat Excel** v hlavičce katalogu. Nyní podporuje listy Produkty a Sluzby. Dřívější „Import ABF kódů (KODY.xlsm)“ byl ve V1-ADMIN-01 odstraněn; jeho historické záznamy v `import_batches` a údaje `document.abfImport` na kartách zůstávají.

**Kdo a kde:** jen aktivní **Správce** (oprávnění `catalog.import`). Zapisovat jde **jen v ověřeném DEV `wpbivmobbqcqmyehunog`**. V produkci server funkci odmítne a databázi ani nečte. Klient cílovou databázi nijak neurčuje.

## Postup

1. **Vybrat soubor .xlsx.** Šablona `catalog-template/1`.
   - Podporované listy jsou **Produkty a Sluzby**.
   - Pomocné listy Navod, Vzory, Ciselniky a _meta se ignorují.
   - Jiný list s daty se ohlásí jako nepodporovaný a import zablokuje.
2. **Náhled** (nic se nezapisuje) ukáže:
   - soubor, šablonu a prostředí;
   - datové řádky a počty podle listů;
   - vytvořit / aktualizovat / beze změny / konflikty / upozornění;
   - po řádcích list, číslo řádku, kód a název; u aktualizací české pole s původní a novou hodnotou; důvody konfliktů a upozornění.

   Výsledky jde filtrovat podle typu výsledku a podle listu.
3. **Konflikt nebo chyba sešitu → celou dávku nelze potvrdit.** To platí i pro nepodporovaný list s daty, neznámou verzi šablony a šablonu pro jiné prostředí. Výběr jen některých řádků ani automatické opravy zatím nejsou.
4. **Žádná změna → „Vše je beze změny“.** Nic se nezapisuje a potvrzení se nenabízí.
5. **Potvrzení** vyžaduje výslovné zaškrtnutí. Panel předem upozorní, že zápis probíhá **po kartách**: při chybě se zastaví a již uložené karty zůstanou.
6. **Výsledek** ukáže uložené, selhané a neprovedené řádky a znovu načte seznam katalogu.
7. **Poslední importy** zobrazují evidenci běhů.

## Vazba náhledu na potvrzení a ochrana proti dvojímu zápisu

Náhled se uloží jako záznam v `import_batches` s `kind = 'catalog-template'`. Záznam obsahuje:
- autora a prostředí (ref projektu);
- název, velikost a **SHA-256 souboru**;
- **SHA-256 plánu** spočítaného serverem; pokrývá každý řádek včetně `updated_at` karet, změn a chyb;
- platnost 30 minut.

Při potvrzení se soubor posílá znovu a server:
1. ověří autora, prostředí, platnost a stav náhledu;
2. porovná SHA-256 souboru;
3. **znovu naplánuje import proti aktuálnímu katalogu a číselníkům**. Pokud hash plánu nesouhlasí, nic nezapíše, náhled označí `superseded` a vyžádá nový. Shodné počty nestačí;
4. jedním podmíněným UPDATE převede záznam `previewed → running`. Dvojklik, opakovaný požadavek nebo druhá záložka proto narazí na „už potvrzeno“;
5. pustí nejvýš **jeden běžící import** napříč všemi instancemi serveru (částečný unikátní index, žádná sdílená paměť);
6. zapisuje stejnou cestou jako CLI (`writeCatalogImportPlan`): `createCatalogItemAdmin` / `saveCatalogItemAdmin` s kontrolou `updated_at`, kontrolou duplicit a kolizí kódů. Nové karty vznikají jako „K doplnění“.

Obnovení stránky import nespustí. Požadavky musí přijít ze stejného původu (Origin) a session cookie je SameSite=Lax.

## Přerušení a částečné selhání

- Výsledek každého řádku se ukládá **průběžně** (`result_rows`).
- Po ztrátě spojení panel neoznámí „nic se neuložilo“. Dohledá skutečný stav běhu na serveru (`GET /api/catalog-admin/excel-import/runs?id=…`).
- Běh, který zůstane ve stavu `running` déle než 15 minut (spadlý server), se označí jako `interrupted`. Uložené řádky zůstanou vidět.
- Původní zápis se znovu nespouští. Nový náhled stejného souboru vychází ze skutečně uloženého stavu: uložené karty vyjdou „beze změny“.
- Obsah souboru, hesla ani tokeny se neukládají ani nelogují. Chybové odpovědi neobsahují interní detaily.

## Limity

Nejvýše **5 MB** a **2000 datových řádků**. Kontroluje se skutečný obsah: kontejner ZIP a čitelný sešit, ne jen přípona.

## Migrace

`supabase/migrations/20261109120000_import_batches_catalog_template_runs.sql` minimálně rozšiřuje existující `import_batches`:
- nové sloupce: autor, prostředí, hashe, platnost, časy, výsledky řádků, chyba;
- nové stavy;
- unikátní index „jeden běžící“.

Existující záznamy zůstávají platné. **DEV: aplikováno 2026-11-09.** Produkce: neaplikováno.

## CLI

`npm run catalog:dev:excel-import` funguje dál se svými ochranami (`--apply --confirm=<ref> --expect=…`) a používá stejný zapisovač. Běhy z CLI se do evidence UI nezapisují.
