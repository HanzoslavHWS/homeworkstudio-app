# Přihlášení, role a administrace uživatelů (V1-AUTH-01)

Navazuje na audit [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md), batche **B2** (uživatelé a session s identitou), **B3** (role a oprávnění) a **B10** (administrace). Sdílené heslo `APP_LOGIN_PASSWORD` je nahrazené účty v Supabase Auth.

## 1. Jak to funguje

- **Identita a hesla:** Supabase Auth (`auth.users`). Aplikace žádné heslo neukládá ani nevypisuje do logů.
- **Profil, role a stav účtu:** tabulka `app_users`. Zapisuje ji jen server po kontrole oprávnění. Role se nikdy nebere z klienta ani z `user_metadata`.
- **Session:**
  - Podepsaná HttpOnly cookie `homeworkstudio_session` (HMAC, `APP_SESSION_SECRET`) nese jen ID session a ID uživatele.
  - Při každém autorizovaném požadavku server ověří řádek `app_sessions` (neodvolaný, neprošlý) a `app_users` (aktivní účet).
  - Doba nečinnosti je 12 h. Okno se samo prodlužuje (`/api/auth/session` při práci v aplikaci). Absolutní maximum je 14 dní.
  - Session ukončí odhlášení, deaktivace účtu i nastavení nového hesla.
- **Supabase token** z přihlášení se okamžitě zahazuje. Prohlížeč nikdy nedostane Supabase JWT a s databází mluví výhradně přes API routy aplikace.
- **Přiřazení projektů:** tabulka `project_members` (3D projekt / zakázka `projects.id` ↔ uživatel).
- **Jeden mechanismus oprávnění:**
  - Matice je v [domain/accessControl.ts](../domain/accessControl.ts).
  - Vynucuje ji [lib/auth/requestAuth.ts](../lib/auth/requestAuth.ts) (`authorize`, `authorizeProject`, `authorizeFile`, `denyUnless`), a to v každé API routě i stránce.
  - Navigace se podle stejné matice jen skrývá. Skrytí položky menu není zabezpečení.
- **Proxy** ([proxy.ts](../proxy.ts)) je jen první brána: ověří podpis cookie. Přihlašovací stránky, callback a jejich API jsou veřejné, takže nevzniká smyčka přesměrování.
- **Databáze:**
  - Všechny tabulky mají RLS bez politik a nové tabulky nemají žádná práva pro `anon` / `authenticated`.
  - Business RPC jsou jen pro `service_role`.
  - Skutečný přihlášený uživatel s vlastním JWT proto přímo v databázi nic nepřečte ani nezapíše (ověřeno v DEV, viz kap. 6).

## 2. Role a matice oprávnění

| Modul / akce | Správce | Běžný | Externí |
|---|---|---|---|
| Uživatelé, role, přiřazení projektů (`users.manage`) | ✔ | — | — |
| 3D projekty (zakázky) — seznam, detail, úpravy | všechny | jen přiřazené + vlastní nově založené | jen přiřazené, **jen čtení**, zúžený výřez (název, veletrh, stánek, stav, výstupy) |
| Založení projektu (`projects.create`) | ✔ | ✔ (autor je přiřazen automaticky) | — |
| Soubory projektu (R2 `projects/<id>/…`) | ✔ | přiřazené projekty | jen čtení výstupů přiřazeného projektu: `exports`, `visualizations`, `floorplans` |
| Katalog — čtení (`catalog.read`) | ✔ | ✔ | — |
| Katalog — správa (karty, kategorie, vzorníky, aliasy, import ABF) | ✔ | — | — |
| Zákaznický katalog (PDF, předvolby) | ✔ | ✔ | — |
| Prodejní ceny — čtení / zápis | ✔ / ✔ | ✔ / — | — |
| Nákupní ceny — čtení / zápis | ✔ / ✔ | ✔ / — | — |
| Veletrhy — čtení / správa | ✔ / ✔ | ✔ / — | — |
| Realizační firmy — čtení / správa | ✔ / ✔ | ✔ / — | — |
| Úkoly, e-maily, tiskové plochy, technické rastry, kontrola vyúčtování, AI | ✔ | ✔ | — |
| Synchronizace katalogu tiskových ploch | ✔ | — | — |

Navigace: běžný účet nevidí sekce Knihovna stánků, Katalog komponent, Výstavy / eventy, Ceníky, Ceníky (verze), Správa cen, Realizační firmy a Uživatelé. Externí účet vidí jen stránku „Přidělené projekty“. Generátor `/abf` ho vrátí na úvod.

**K potvrzení:** Běžný účet smí *číst* nákupní ceny, protože je potřebuje kontrola vyúčtování. Pokud je mít nemá, stačí odebrat `prices.purchase.read` z role `user` v `domain/accessControl.ts`.

## 3. Chráněná API a úložiště

| Oblast | Routy | Kontrola |
|---|---|---|
| Přihlášení (veřejné) | `/api/auth/login`, `logout`, `session`, `callback`, `password/forgot`, `password/set`, `/auth/confirm` | vlastní (session, jednorázový grant) |
| Uživatelé | `/api/admin/users`, `/update`, `/link`, `/projects` | `users.manage` |
| Projekty | `/api/projects/list`, `/save`, `/delete` | přihlášení + `authorizeProject` (role + přiřazení), seznam filtrovaný na serveru |
| Soubory R2 | `/api/assets/presign`, `/download`, `/delete` | `authorizeFile` podle prefixu storageKey (modul, nebo projekt + složka) |
| Katalog | `/api/catalog/items`, `/api/catalog-admin/*` | `catalog.read` (GET), `catalog.manage` (zápisy) |
| Zákaznický katalog | `/api/customer-catalog/presets` | `customerCatalog.use` |
| Ceny | `/api/price-lists/*`, `/api/pricing/*`, `/api/pricing-admin/*`, `/api/price-versions*`, `/api/purchase-prices*` | `prices.sale.read/write`, `prices.purchase.read/write` |
| Veletrhy | `/api/events/list`, `/save`, `/config` | `events.read` / `events.manage` |
| Realizační firmy | `/api/realization-companies*` | `realizationCompanies.read` / `.manage` |
| Úkoly | `/api/tasks/*` | `tasks.use` |
| E-maily a AI | `/api/emails/*`, `/api/visualizations/ai-generate` | `emails.use`, `ai.use` |
| Tiskové plochy | `/api/print-surfaces/*` | `printSurfaces.use`, synchronizace `printSurfaces.catalogSync` |
| Technické rastry | `/api/technical-rasters/*` | `technicalRasters.use` |
| Kontrola vyúčtování | `/api/settlement-checks/*` | `settlement.use` |

Automatický test ([tests/auth.test.ts](../tests/auth.test.ts)) prochází **všechny** soubory `app/api/**/route.ts` a u každé metody ověří tři věci:
- bez přihlášení → 401;
- externí účet → 403 (mimo vlastní projekty a soubory);
- běžný účet → 403 na globální administraci.

Nová routa bez kontroly tak test neprojde.

**Podepsané odkazy na soubory:** R2 URL vydané před deaktivací účtu nebo odebráním přiřazení platí do vypršení:
- stažení nejvýše 15 minut;
- nahrání nejvýše 10 minut.

Nové odkazy už server nevydá.

## 4. Proměnné prostředí

| Proměnná | Kde | Význam |
|---|---|---|
| `APP_SESSION_SECRET` | server | ≥ 32 náhodných znaků; podpis session cookie a jednorázového grantu pro nastavení hesla |
| `APP_BASE_URL` | server | adresa aplikace pro odkazy z pozvánek a obnovy hesla. **Mimo vývoj povinná a https.** V DEV musí mířit na `localhost` (bez ní se použije lokální adresa požadavku). Odkaz z DEV tak nikdy nevede do produkce. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | server | jako dosud; Supabase Auth používá stejný projekt (DEV / PROD podle prostředí) |
| `E2E_LOGIN_EMAIL`, `E2E_LOGIN_PASSWORD` | jen DEV `.env.local` | účet (Správce) pro skripty `eventAdminE2E`, `priceVersionsE2E`, `seedPricingB1TestProject` |
| ~~`APP_LOGIN_PASSWORD`~~ | — | zrušeno |

Chybějící konfigurace nebo migrace nikdy neotevře přístup. Server odpoví 503 s popisem („Přihlášení není nakonfigurované“, „chybí migrace“) a nikdy to nevydává za špatné heslo.

## 5. Nastavení Supabase Auth (dashboard, pro každý projekt zvlášť)

1. **Authentication → Sign In / Providers → Email:**
   - zapnuto;
   - **„Allow new users to sign up“ vypnout.** Bez profilu v `app_users` by se cizí účet stejně nedostal dál, ale veřejná registrace být nemá. Pozvánky a zakládání správcem fungují i s vypnutou registrací.
2. **Authentication → URL Configuration:**
   - *Site URL* = adresa aplikace daného prostředí (DEV např. `http://localhost:3000`, PROD produkční https adresa);
   - *Redirect URLs* = `<APP_BASE_URL>/auth/callback`.
   DEV projekt nesmí mít v seznamu produkční adresu a naopak.
3. **E-maily:**
   - Pozvánky a odkazy nového hesla od správce aplikace **neposílá**. Vytvoří je (`admin.generateLink`) a správce je předá sám.
   - E-mail posílá jen „Zapomenuté heslo“ na přihlašovací stránce (`resetPasswordForEmail`), a to jen pro existující aktivní účet. Odkaz vede na `/auth/callback`. Výchozí šablona Supabase funguje beze změny.
   - Výchozí SMTP Supabase posílá jen na adresy členů týmu projektu a má nízké limity. Pro skutečné kolegy je potřeba vlastní SMTP (Authentication → Emails → SMTP).
4. Platnost odkazů (OTP / magic link expiry) řídí Supabase Auth (výchozí 24 h). Odkaz je jednorázový. Po jeho otevření má uživatel 15 minut na nastavení hesla.

## 6. Migrace

`supabase/migrations/20261106120000_app_users_sessions_project_members.sql`:
- tabulky `app_users`, `app_sessions`, `project_members` (RLS, bez práv pro `anon`/`authenticated`);
- trigger **poslední aktivní správce**: nelze ho deaktivovat, degradovat ani smazat. Platí to pro jakoukoli cestu včetně přímého SQL a je to serializované zámkem, takže dva souběžné požadavky neprojdou oba;
- trigger, který při deaktivaci odvolá všechna přihlášení.

Migrace nemění žádnou existující tabulku ani data a žádné staré projekty nikomu nepřiřazuje. **DEV (wpbivmobbqcqmyehunog): aplikováno 2026-11-06.** Produkce: neaplikováno.

## 7. První správce (jednorázově, ručně)

Nikdo se nestane správcem automaticky: ani první přihlášený, ani všechny stávající účty. První správce se nastaví výslovně pro jednu ověřenou adresu:

```
npm run auth:dev:bootstrap-admin -- --email=<e-mail ověřené osoby>                       # suchý běh
npm run auth:dev:bootstrap-admin -- --email=<e-mail> --name="Jméno" --apply --confirm=<ref DEV>
```

Skript (jen DEV, ochrany prostředí jako ostatní skripty):
- založí účet v Supabase Auth bez odeslání e-mailu, nebo použije existující;
- vytvoří či povýší profil na aktivního Správce;
- **jen do terminálu** vypíše jednorázový odkaz, kterým si osoba nastaví heslo.

Další účty pak zakládá Správce v aplikaci (Administrace → Uživatelé). Pro produkci se stejný krok provede jednou až při nasazení s produkční konfigurací. Skript do produkce záměrně nezapisuje.

## 8. Omezení

- Limit pokusů o přihlášení v aplikaci (8 neúspěchů / 15 min na e-mail a IP) je jen v paměti jedné instance. Hlavní ochranu dává limit Supabase Auth.
- Stav pozvánky v administraci se čte ze Supabase Auth (pozváno / poslední přihlášení). Zobrazení přesné expirace odkazu Supabase neposkytuje.
- „Projekt“ = 3D projekt / zakázka (`projects`). Technické rastry, tiskové plochy, úkoly a vyúčtování jsou evidence vázané na veletrh. Jsou dostupné provozním rolím a externím nikdy (přiřazení k nim neexistuje).
