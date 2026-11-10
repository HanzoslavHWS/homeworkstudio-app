# Přihlášení, společné účty, přístupy a role (V1-AUTH-01, V1-AUTH-02)

Navazuje na audit [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md), batche **B2** (uživatelé a session s identitou), **B3** (role a oprávnění) a **B10** (administrace). Sdílené heslo `APP_LOGIN_PASSWORD` je nahrazené účty v Supabase Auth.

**V1-AUTH-02:** jeden člověk má jeden společný účet HomeworkStudio. Přístup do každé aplikace a role v ní jsou samostatné členství. Účty spravuje správce HomeworkStudia ve **Správě uživatelů** (`/sprava-uzivatelu`, odkaz nahoře na rozcestníku). Podrobnosti jsou v kapitole 9.

## 1. Jak to funguje

- **Identita a hesla:** Supabase Auth (`auth.users`). Aplikace žádné heslo neukládá ani nevypisuje do logů.
- **Společný účet a stav:** tabulka `app_users` (jméno, e-mail, aktivní, příznak `is_hws_admin`). **Přístup a role v aplikaci:** tabulka `app_memberships` (jeden řádek na účet × aplikaci). Obojí zapisuje jen server po kontrole oprávnění. Role se nikdy nebere z klienta ani z `user_metadata`.
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

## 2. Role a matice oprávnění v ABF

Platí jen pro účet s členstvím v ABF. Účet bez členství nemá v ABF nic: stránka `/abf`, žádné ABF API ani soubory (403 `no_app_access`), a to ani se starým přiřazením zakázky.

| Modul / akce | Správce | Běžný | Externí |
|---|---|---|---|
| Uživatelé a přiřazení zakázek v ABF (`users.manage`) — role a stav jen ke čtení | ✔ | — | — |
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

Navigace: běžný účet nevidí Administraci. Externí účet vidí na `/abf` jen stránku „Přidělené projekty“.

Společná správa účtů má vlastní oprávnění (`app_users.is_hws_admin`, kap. 9), nezávislé na roli v ABF: Správce ABF ji neotevře a správce HomeworkStudia bez členství neotevře data ABF.

**K potvrzení:** Běžný účet smí *číst* nákupní ceny, protože je potřebuje kontrola vyúčtování. Pokud je mít nemá, stačí odebrat `prices.purchase.read` z role `user` v `domain/accessControl.ts`.

## 3. Chráněná API a úložiště

| Oblast | Routy | Kontrola |
|---|---|---|
| Přihlášení (veřejné) | `/api/auth/login`, `logout`, `session`, `callback`, `password/forgot`, `password/set`, `/auth/confirm` | vlastní (session, jednorázový grant) |
| ABF Uživatelé a přiřazení | `/api/admin/users` (GET), `/api/admin/users/projects` | `users.manage` (+ nové přiřazení jen aktivnímu členovi ABF) |
| Společná správa účtů | `/api/hws/accounts` (GET), `/invite`, `/update`, `/link` | `authorizeAccounts` — správce HomeworkStudia |
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
- běžný účet → 403 na globální administraci;
- účet bez členství v ABF → 403 u každé routy (V1-AUTH-02).

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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` | server, volitelné | odesílání pozvánek e-mailem (kap. 9.4). Bez nich se pozvánka předává odkazem. |
| `SMTP_DEV_ALLOWED_RECIPIENTS` | jen DEV | e-maily nebo `@domény`, kam smí DEV poslat pozvánku nebo upozornění podpory; jiné adresy DEV odmítne |
| `CRON_SECRET` | server, volitelné | opakované odesílání upozornění podpory plánovačem (Vercel Cron), viz [SUPPORT.md](SUPPORT.md) kap. 6 |
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

`supabase/migrations/20261110120000_hws_accounts_app_memberships.sql` (V1-AUTH-02) — popis v kap. 9.5. **DEV: aplikováno 2026-11-10.** Produkce: neaplikováno.

## 7. První správce (jednorázově, ručně)

Nikdo se nestane správcem automaticky: ani první přihlášený, ani všechny stávající účty. První správce se nastaví výslovně pro jednu ověřenou adresu a každá role se jmenuje zvlášť:

```
npm run auth:dev:bootstrap-admin -- --email=<e-mail ověřené osoby> --hws-admin --abf-admin            # suchý běh
npm run auth:dev:bootstrap-admin -- --email=<e-mail> [--name="Jméno"] --hws-admin --abf-admin --apply --confirm=<ref DEV>
```

`--hws-admin` = správce HomeworkStudia, `--abf-admin` = role Správce v ABF. Existující účet si ponechá heslo (odkaz jen s `--link`).

Skript (jen DEV, ochrany prostředí jako ostatní skripty):
- založí účet v Supabase Auth bez odeslání e-mailu, nebo použije existující;
- vytvoří profil nebo nastaví požadované role a účet aktivuje;
- **jen do terminálu** vypíše jednorázový odkaz, kterým si osoba nastaví heslo.

Další účty pak zve správce HomeworkStudia ve Správě uživatelů. Pro produkci se stejný krok provede jednou až při nasazení s produkční konfigurací. Skript do produkce záměrně nezapisuje.

## 8. Omezení

- Limit pokusů o přihlášení v aplikaci (8 neúspěchů / 15 min na e-mail a IP) je jen v paměti jedné instance. Hlavní ochranu dává limit Supabase Auth.
- Stav pozvánky v administraci se čte ze Supabase Auth (pozváno / poslední přihlášení). Zobrazení přesné expirace odkazu Supabase neposkytuje.
- „Projekt“ = 3D projekt / zakázka (`projects`). Technické rastry, tiskové plochy, úkoly a vyúčtování jsou evidence vázané na veletrh. Jsou dostupné provozním rolím a externím nikdy (přiřazení k nim neexistuje).

## 9. Společné účty HomeworkStudio a přístupy do aplikací (V1-AUTH-02)

### 9.1 Model

| Úroveň | Kde | Význam |
|---|---|---|
| Společný účet | `app_users` (id = `auth.users.id`) | identita, jméno, e-mail, aktivita. Deaktivace zablokuje **všechny** aplikace a ukončí přihlášení. |
| Správce HomeworkStudia | `app_users.is_hws_admin` | spravuje účty a přístupy. Data aplikace otevírá jen přes vlastní členství. |
| Členství v aplikaci | `app_memberships (user_id, app_key, role)` | přístup do jedné aplikace s rolí platnou pro ni. Nejvýš jedno na dvojici účet–aplikace. Bez řádku = zákaz. Odebrání zablokuje jen tu aplikaci. |
| Registr aplikací | `hws_apps` (+ zrcadlo `domain/hwsApps.ts`) | stabilní klíč, název, adresa, stav (`available` / `coming_soon`), role aplikace |

Registr dnes obsahuje:

| Aplikace | Klíč | Stav | Adresa | Role |
|---|---|---|---|---|
| ABF Generator | `abf` | dostupná | `/abf` | Správce / Běžný / Externí (beze změny oprávnění) |
| HWS Easy | `hws-easy` | **Připravujeme** — zatím jen karta, žádná aplikace | žádná | Uživatel |

Vazby používají ID účtu, nikdy e-mail. Přístup do budoucího Generatoru 2.0 bude samostatné členství. Neznamená oprávnění k produkčnímu ABF ani propojení dat. DEV a produkce mají oddělené databáze, a tedy i účty.

### 9.2 Výsledná matice oprávnění

| | Správce HWS bez aplikací | Správce ABF (bez HWS) | Běžný ABF | Externí ABF | Účet bez aplikací | Deaktivovaný |
|---|---|---|---|---|---|---|
| Přihlášení, rozcestník | ✔ (zpráva „bez aplikací“) | ✔ | ✔ | ✔ | ✔ (zpráva „bez aplikací“) | — |
| Správa uživatelů (`/sprava-uzivatelu`, `/api/hws/accounts/*`) | ✔ | — | — | — | — | — |
| ABF `/abf`, ABF API a soubory | — | vše | provoz | přidělené zakázky | — | — |
| ABF Administrace → Uživatelé a přiřazení | — | ✔ | — | — | — | — |
| HWS Easy | jen karta „Připravujeme“, pokud má členství | stejně | stejně | stejně | — | — |

Kontroly jsou na serveru při každém požadavku. Role a členství se čtou z databáze, ne z cookie. Změna role, odebrání přístupu i deaktivace proto platí hned při dalším požadavku i v už otevřené session.

### 9.3 Pozvání uživatele a změna přístupu

1. Rozcestník → **Správa uživatelů** → **Pozvat uživatele**.
2. Jméno, e-mail, zaškrtnout aplikace a u každé zvolit roli. Role nezaškrtnuté aplikace se nepoužije.
3. Doručení: **odkaz k ručnímu předání**, nebo **e-mailem** (jen když je nastavené SMTP).
4. **Vytvořit pozvánku.** Postup:
   - vznikne účet;
   - uloží se přístupy;
   - teprve potom je pozvánka „připravená“ a zobrazí se odkaz, případně odejde e-mail.
5. Uživatel otevře jednorázový odkaz, nastaví si heslo a je přihlášený na rozcestníku.

Pravidla:
- **Existující aktivovaný e-mail** nový účet nezaloží (409). Správa nabídne „Upravit přístupy tohoto účtu“ a heslo se nemění.
- **Nedokončenou pozvánku** (účet zatím bez hesla) lze zopakovat. Doplní přístupy bez druhého účtu.
- **Selhání uložení přístupů** nechá pozvánku ve stavu „Nedokončená“. V seznamu je dohledatelná a stačí ji zopakovat.
- **Selhání e-mailu** ponechá účet i přístupy („Odeslání selhalo“). Odkaz lze předat ručně nebo odeslání zopakovat.

**Změna přístupu:** v seznamu **Upravit**. Lze měnit jméno, aktivní účet, příznak správce HomeworkStudia a aplikace s rolemi; ukládá se v jedné transakci. Odkaz pro nové heslo se vytvoří jen na výslovnou žádost. Heslo se změní až tím, že ho uživatel použije. Vlastní účet ani vlastní správu si správce nevypne. Odebráním přístupu se nemažou zakázky, přiřazení, historie ani autorství; účet je jen přestane otevírat.

**Uvnitř ABF** (Administrace → Uživatelé a přiřazení) vidí Správce ABF jen účty s členstvím v ABF, jejich roli a stav (jen ke čtení) a přiřazuje zakázky. Účet se tam objeví sám, jakmile mu správce HomeworkStudia povolí ABF. Deaktivovanému účtu nebo účtu bez ABF nelze přiřadit novou zakázku, odebrat ji lze vždy.

### 9.4 Pozvánky e-mailem (SMTP)

- **Bez SMTP** (dnešní stav DEV): pozvánka se bezpečně předá jednorázovým odkazem. Správa to oznámí a nikdy nenapíše „odesláno“.
- **S SMTP:** nastavte na serveru `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (případně `SMTP_SECURE=true` pro port 465). Hesla patří jen do proměnných prostředí (Vercel, `.env.local`), nikdy do repozitáře. Aplikace pošle jeden e-mail s odkazem (`nodemailer`, bez logování obsahu a přihlašovacích údajů).
- **Ve vývoji (DEV)** odejde e-mail jen na adresy ze `SMTP_DEV_ALLOWED_RECIPIENTS`. Testovací pozvánka se tak omylem nedostane ke skutečnému člověku.
- Odkazy ani tokeny se nikam nelogují a v databázi se neukládají. Evidence pozvánek obsahuje jen stav a krátký důvod chyby.
- „Zapomenuté heslo“ na přihlašovací stránce dál posílá e-mail přes Supabase Auth (kap. 5).

### 9.5 Migrace `20261110120000_hws_accounts_app_memberships`

- **Nové tabulky:**
  - `hws_apps` (registr se dvěma řádky);
  - `app_memberships`;
  - `account_invitations` (stav pozvánek, bez odkazů);
  - všechny s RLS a bez práv pro `anon` / `authenticated`.
- **Nový sloupec** `app_users.is_hws_admin` (výchozí `false`). **Nikdo se nepovýší**; prvního správce určí výslovně skript z kap. 7.
- **Převod rolí:** dosavadní `app_users.role` → členství `abf` se stejnou rolí u všech účtů. Aktivní i deaktivované stavy, ID, hesla, session, přiřazení zakázek a historie zůstávají. Pak se sloupec `role` odstraní.
- **Kontrola rolí:** spouštěč `app_memberships_check_role` odmítne roli, kterou aplikace nedefinuje (i z přímého SQL).
- **Ochrana posledních správců:**
  - poslední aktivní správce HomeworkStudia;
  - poslední aktivní správce každé aplikace (ABF).
  Chrání ji spouštěče na `app_users` i `app_memberships` se společným zámkem `hws_last_admins`, takže ani dvě souběžné změny neprojdou obě (ověřeno v DEV souběžnými transakcemi).
- **Atomické zápisy:** `hws_set_memberships` a `hws_update_account` (jedna transakce, kontrola souběžné úpravy přes `updated_at`). Spouštět je smí jen `service_role`.

**Stav DEV po migraci (2026-11-10):** 1 skutečný účet `info@homeworkstudio.cz`. Je aktivní, má členství `abf = admin` (převedeno) a skriptem z kap. 7 byl výslovně určen jako správce HomeworkStudia. Heslo zůstalo beze změny.

### 9.6 Návrat před V1-AUTH-02

Kód a databáze se vracejí spolu: starý kód čte `app_users.role`, nový ho nemá.

1. Zastavit aplikaci (dev server) proti DEV.
2. Kód: `git -c core.autocrlf=false switch develop` (stav před etapou, `2f8b372`), `npm ci`.
3. Databáze (jen DEV, po kontrole cíle — stejná pravidla jako `db:dev:*`):
   - spustit `supabase/rollback/20261110120000_hws_accounts_app_memberships.down.sql` v jedné transakci;
   - vrátí `app_users.role` z členství ABF;
   - účty bez ABF obnoví jako deaktivované „Externí“ (ve starém modelu stav „bez přístupu“ neexistuje);
   - odstraní registr, členství, pozvánky a příznak správce HomeworkStudia;
   - obnoví původní spouštěč posledního správce;
   - smaže záznam verze z historie migrací.
4. Kontrola: `npm run db:dev:list` (poslední verze `20261109120000`) a přihlášení správce.

Produkce se tím nemění, migrace v ní není.

## 10. Nápověda a podpora (V1-SUPPORT-01)

Podpora uvnitř aplikace používá stejná členství a role jako výše (role v ABF při každém požadavku). Popis, oprávnění, přílohy a návrat zpět: [SUPPORT.md](SUPPORT.md).
