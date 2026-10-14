# Oddělení DEV a PROD prostředí

Stav k 14. 10. 2026 (batch B-DEV-01). Dokument neobsahuje žádná hesla, klíče ani connection stringy — jen identifikátory, které nejsou tajné.

> **Oddělení zatím NENÍ dokončené.** Chybí přístupové údaje k DEV databázi a ověření nastavení Vercelu (viz „Co musí udělat uživatel“). Do té doby platí: lokální vývoj na větvi `develop` se k žádné databázi nepřipojí (ochrana ho zablokuje), produkce běží beze změny.

## 1. Prostředí

| | PROD | DEV |
|---|---|---|
| Web | Vercel, produkční deployment | lokálně `npm run dev` (http://localhost:3000) |
| Git větev | `master` | `develop` |
| Supabase projekt | ref **`fwchkogtaqaunaxmchtu`** (název „HomeworkStudio“) | ref **`wpbivmobbqcqmyehunog`** (`homeworkstudio-dev`) |
| R2 bucket | produkční bucket | **vypnuto**, dokud nebude DEV bucket (`R2_EXPECTED_BUCKET`) |
| `NEXT_PUBLIC_APP_ENV` | nenastaveno (= production) | `development` |

Prostředí se rozlišují podle **project ref** (subdoména `https://<ref>.supabase.co`), nikdy podle názvu projektu. Produkční ref je zapsaný v `lib/env/supabaseEnvironment.ts` (`KNOWN_PRODUCTION_SUPABASE_REFS`) a všude mimo produkci se odmítá.

## 2. Zjištěný stav (inventura)

**Git**
- Repozitář `github.com/HanzoslavHWS/homeworkstudio-app` je **veřejný** — nikdy do něj necommitovat klientská data, ceníky realizaček ani skutečné soubory z `_IMPORT/`.
- `master` = `5f405e0` = `origin/master`, beze změny.
- Podle GitHub Deployments API je poslední produkční deployment Vercelu commit **`5f405e0`** (12. 10. 2026) — shodný s `master`. Na GitHubu jsou zaznamenané jen deploymenty „Production“, žádné Preview.
- Bod obnovy: lokální tag **`backup/master-before-dev-split`** → `5f405e0`.
- Větev **`develop`** (zatím jen lokálně, nepushnutá):
  1. `chore:` odstranění omylem commitnutého gitlinku `.claude/worktrees/agent-ad8fee78cee1d6e87` (přidán v `78b802c`, odkazoval na už neexistující lokální checkout agenta, neobsahoval žádná data) + `.gitignore` pro všechny `.env*` a `.claude/worktrees/`
  2. `feat:` modul Kontrola vyúčtování (batch 1) včetně migrace `20261013120000_settlement_checks.sql`
  3. `docs:` architektonický audit
  4. `chore:` ochrany DEV/PROD (tento batch)
- Mimo Git (záměrně, v `.gitignore`): `.env.local`, `_IMPORT/` (včetně kopií referenčních souborů vyúčtování), `private-imports/`, `supabase/.temp/`. **Nejsou zálohované přes Git** — zálohujte je zvlášť.

**Lokální konfigurace před tímto batchem**
- `.env.local` míří na **produkční** Supabase (`fwchkogtaqaunaxmchtu`) a produkční R2 bucket → **dosavadní lokální vývoj zapisoval do produkčních dat.**
- Supabase CLI je nalinkované (`supabase/.temp/project-ref`) na **produkční** projekt → holé `supabase db push` by šlo do produkce. Proto se migrace spouštějí jen přes chráněný skript (bod 4).
- Projekt nemá `supabase/config.toml` (lokální Supabase stack se nepoužívá).

**Vercel**
- V repozitáři nebyl `vercel.json`; Vercel CLI není nainstalované a k nastavení projektu nemám přístup. **Proměnné prostředí na Vercelu (Production / Preview) a produkční větev jsem neověřil.**

**Migrace**
- Lokálně 19 migrací `20260813120000_init_schema.sql` … `20261013120000_settlement_checks.sql`.
- Prázdnou databázi postaví celé: datové kroky jsou ochráněné (`insert … select … join` na existující řádky, `on conflict do nothing`, `where not exists`), na prázdné DB nevloží nic nebo vloží jen výchozí číselníky (kategorie úkolů, výchozí checklist, šablony e-mailů, grafické služby). Potvrdí to `npm run db:dev:check` (dry-run).
- Stav migrací v **produkci jsem neověřoval** (vyžaduje heslo produkční DB; tento batch do produkce nesahá). Migrace `20261013120000` v produkci aplikovaná není.

## 3. Co je hotové

**Krok 2 (14. 10. 2026)**
- Původní produkční `.env.local` je zálohovaný **mimo projekt** v `C:\Users\Hanz\Documents\HomeworkStudio_env_backup\` (shoda SHA-256 ověřena, přístup jen pro účet Windows `Hanz`). Tamtéž je odložený produkční link Supabase CLI (dřívější `supabase/.temp`) — CLI v projektu už na produkci napojené není.
- Nové `.env.local` obsahuje DEV hodnoty: `NEXT_PUBLIC_APP_ENV=development`, `SUPABASE_URL` a `SUPABASE_EXPECTED_PROJECT_REF` pro `wpbivmobbqcqmyehunog` a nový `APP_SESSION_SECRET`. `SUPABASE_SECRET_KEY` a `SUPABASE_DEV_DB_URL` čekají na doplnění. R2 proměnné v něm nejsou.
- **R2 je ve vývoji vypnuté** (`lib/storage/r2Config.ts`): mimo produkci úložiště funguje jen tehdy, když `R2_EXPECTED_BUCKET` výslovně jmenuje nastavený bucket; jinak upload i download vrátí 503. Produkce beze změny.
- `npm run db:dev:check` navíc čtecím voláním API ověří, že `SUPABASE_SECRET_KEY` patří DEV projektu.

**Krok 1**

- Bod obnovy a větev `develop` s veškerou dosavadní prací (lokálně).
- **Ochrana databáze** (`lib/env/supabaseEnvironment.ts`, `lib/db/supabase.server.ts`): mimo produkci server odmítne
  - produkční projekt (i kdyby byl uveden jako očekávaný),
  - jakýkoli projekt, jehož ref se neshoduje se `SUPABASE_EXPECTED_PROJECT_REF`,
  - adresu, ze které nejde ref přečíst.
  
  API pak vrací 503 s vysvětlením. `next dev` bez `NEXT_PUBLIC_APP_ENV` se bere jako vývoj. V produkci (proměnná nenastavená nebo `production`) se nic nemění. Stejná ochrana platí pro importní skripty v `scripts/` (používají stejného klienta).
- **Označení DEV** (`app/layout.tsx`): mimo produkci je vpravo dole štítek „DEV · DB &lt;ref&gt;“ a titulek stránky začíná `[DEVELOPMENT]`. Podle refu ve štítku je vždy vidět, ke které databázi je aplikace připojená.
- **Chráněné migrace** (`scripts/supabaseDevMigrate.ts`, Supabase CLI 2.120.0 jako dev závislost):
  - `npm run db:dev:check` — ověří cíl, vypíše plán, `db push --dry-run`
  - `npm run db:dev:list` — stav migrací v DEV
  - `npm run db:dev:apply -- --confirm=<dev-ref>` — skutečný zápis do DEV
  
  Skript vždy předává `--db-url` (nikdy nalinkovaný projekt), odmítne produkční ref, vyžaduje shodu connection stringu, `SUPABASE_URL` a `SUPABASE_EXPECTED_PROJECT_REF` a heslo nikdy nevypíše. Ověřeno: se současným `.env.local` (produkce) skript odmítne běžet.
- **Vercel:** `vercel.json` s `git.deploymentEnabled.develop = false` → push větve `develop` nespustí žádný deployment (ani Preview). Na `master` soubor zatím není, produkce se nemění.
- `.gitignore` ignoruje všechny `.env*` kromě `.env.example`; `.env.example` popisuje DEV proměnné (bez hodnot).
- Testy 3037/3037, typecheck a build prochází.

## 4. Co musí udělat uživatel

1. **Zálohovat současné `.env.local`** (obsahuje produkční údaje) — např. přejmenovat na `.env.prod.local.bak` (je v `.gitignore`), nebo ho smazat, pokud produkční hodnoty máte jinde (Vercel). Lokální vývoj produkční údaje nepotřebuje.
2. **Vytvořit nové `.env.local` s DEV hodnotami** (Supabase → projekt `homeworkstudio-dev` → Project Settings):
   ```
   NEXT_PUBLIC_APP_ENV=development
   SUPABASE_URL=https://<dev-ref>.supabase.co
   SUPABASE_SECRET_KEY=<service role / secret key DEV projektu>
   SUPABASE_EXPECTED_PROJECT_REF=<dev-ref>
   SUPABASE_DEV_DB_URL=<connection string DEV databáze, Session pooler, s heslem>
   APP_LOGIN_PASSWORD=<lokální heslo, klidně jiné než produkční>
   APP_SESSION_SECRET=<nový náhodný řetězec ≥ 32 znaků>
   R2_… / OPENAI_API_KEY=<viz bod 5>
   ```
   Hodnoty vkládejte jen do souboru, ne do chatu. Pak mi stačí napsat **DEV project ref** (není tajný) a já spustím `npm run db:dev:check`.
3. **Potvrdit zápis migrací do DEV** — po kontrole plánu (dry-run) spustím `db:dev:apply` až na výslovné potvrzení.
4. **Zkontrolovat Vercel** (Project → Settings):
   - *Git → Production Branch* = `master`;
   - *Environment Variables*: produkční hodnoty jen pro **Production**; pokud jsou u **Preview** stejné produkční údaje, odebrat je nebo nahradit DEV údaji (Preview by jinak běželo nad produkční DB). Přidat pro Preview `NEXT_PUBLIC_APP_ENV=preview` + DEV hodnoty, pokud preview chcete;
   - *Deployment Protection* pro Preview zapnout.
5. **R2 a OpenAI pro DEV:** založit samostatný DEV bucket (a API token jen pro něj) — jinak lokální nahrávání souborů míří do produkčního bucketu. OpenAI lze pro DEV vypnout (`AI_VISUALIZATION_USE_FAKE_PROVIDER=1`) nebo použít samostatný klíč s limitem.
6. **Supabase CLI link (doporučeno):** přelinkovat CLI na DEV (`npx supabase link --project-ref <dev-ref>`), aby ani ruční příkaz nemířil na produkci.
7. **Potvrdit push `develop` na GitHub** — až po bodu 4 (díky `vercel.json` se `develop` nenasadí, ale nastavení Vercelu je dobré mít ověřené). Push na `master` se neprovádí.
8. Zálohovat `_IMPORT/` a `private-imports/` mimo Git.

## 5. Lokální vývoj — bezpečný postup

```
git switch develop
npm install
npm run dev            # vpravo dole musí být „DEV · DB <dev-ref>“
```

- Pokud štítek chybí, ukazuje produkční ref nebo API hlásí „míří na PRODUKČNÍ databázi“, **nepokračujte** a opravte `.env.local`.
- Migrace: nová migrace do `supabase/migrations/`, pak `npm run db:dev:check` → `npm run db:dev:apply -- --confirm=<dev-ref>`.
- Nikdy nespouštět `supabase db push`, `db reset` ani `migration repair` bez `--db-url` na DEV.
- Testovací data do DEV: přes UI aplikace nebo importní skripty (`node --env-file=.env.local scripts/importBatch1.ts …`), které díky ochraně zapisují jen do DEV. Kopírování produkčních dat do DEV je samostatné rozhodnutí (osobní a obchodní údaje).

**Přepnutí prostředí:** lokálně existuje jen DEV. Produkce se ovládá výhradně z Vercelu. Pokud by bylo výjimečně nutné spustit skript proti produkci, je to vědomý krok (`NEXT_PUBLIC_APP_ENV=production` jen pro jeden příkaz, s domluvou) — ne přepnutí `.env.local`.

## 6. Nasazení FINAL V1 do produkce (později)

1. Na `develop`: zelené testy, typecheck, build; ruční průchod hlavních modulů v DEV.
2. Seznam migrací, které produkce nemá: `npx supabase migration list --db-url <PROD>` (jen čtení) — porovnat s `supabase/migrations/`.
3. **Záloha produkční DB** (Supabase backup / `pg_dump`) těsně před nasazením.
4. Migrace do produkce **samostatně a s potvrzením**, nejdřív `--dry-run`. Pouze aditivní migrace; mazání starých struktur až v pozdějším batchi.
5. Pull request `develop` → `master`, review, merge. Vercel nasadí `master` jako Production.
6. Ověřit produkci: přihlášení, načtení projektů, eventů, katalogu; žádný štítek DEV.
7. Návrat: Vercel *Instant Rollback* na předchozí deployment; data obnovit ze zálohy z bodu 3 jen při skutečné škodě (migrace jsou aditivní, starý kód s novým schématem běží).

## 7. Ověření

| Kontrola | Stav |
|---|---|
| Testy, typecheck, build | ✔ 3037 testů, typecheck a build prochází |
| Ochrana odmítne produkční DB v DEV | ✔ unit testy + skutečný běh migračního skriptu nad současným `.env.local` |
| Produkční web používá PROD | ⚠ **neověřeno** — nasazený commit `5f405e0` ověřen přes GitHub, proměnné na Vercelu ne |
| Lokální aplikace používá DEV | ✖ čeká na DEV údaje (úkol 2) |
| Schéma DEV odpovídá migracím | ✖ čeká na DEV údaje a potvrzení (úkoly 2–3) |
| Testovací zápis do DEV neovlivní PROD | ✖ čeká na DEV údaje |
