# Nápověda a podpora (V1-SUPPORT-01)

Podpora uvnitř aplikace: návody a FAQ, hlášení chyb, návrhů a dotazů se snímky obrazovky a jejich
vyřizování. Podpora patří vždy jedné aplikaci. Zapnutá je jen v ABF Generatoru (`SUPPORT_APP_KEYS`
v `domain/support.ts`), HWS Easy ji zatím nemá. Na rozcestníku není samostatnou aplikací.

## 1. Kde se otevírá

| Kde | Co |
|---|---|
| ABF, boční menu **Nápověda a podpora** (`/abf#/podpora/…`) | Záložky **Návody a FAQ**, **Moje hlášení** a pro správce ABF **Správa podpory** (články, hlášení). Odznak: nová hlášení pro správce, hlášení čekající na doplnění pro autora. |
| ABF, horní lišta **? Nápověda** | Panel *Nápověda k této stránce* nad aktuální obrazovkou: publikované články, které jsou připojené k části aplikace, kde uživatel právě je. Když žádný není, panel nabídne přehled návodů a nahlášení problému. |
| ABF, horní lišta **Nahlásit chybu** | Formulář se otevře v **nové kartě** (`/abf/nahlasit`). Původní karta zůstane beze změny, včetně rozpracovaného projektu a formulářů. Hlášení nese kontext původní stránky, nikdy adresu formuláře (viz níže). Text rozepsaného hlášení přežije opětovné načtení karty, smaže ho až *Zahodit*. Po odeslání se počítadla v původní kartě obnoví sama. Když prohlížeč novou kartu zablokuje, aplikace to oznámí a původní stránku nechá být. |
| Externí účet, `/abf` | V hlavičce stránky *Přidělené projekty* jsou tlačítka **Nápověda a podpora** a **Nahlásit chybu**. |

Adresa `#/podpora/navody/<id>`, `#/podpora/hlaseni/<id>` nebo `#/podpora/sprava/…` přežije obnovení
stránky i tlačítko Zpět.

Části aplikace, ke kterým se připojují články (`SUPPORT_AREAS`): obecné, projekty, generátor, katalog,
import katalogu, ceníky, veletrhy, realizační firmy, uživatelé, úkoly, e-maily, technické rastry,
tiskové plochy, kontrola vyúčtování a podpora.

## 2. Oprávnění

Rozhoduje role **členství v ABF**, a to při každém požadavku. Odebrání členství, změna role nebo
deaktivace účtu proto platí i v už otevřené relaci. Samotný příznak správce HomeworkStudio bez
členství v ABF nedává žádný přístup.

| | Správce ABF | Běžný | Externí |
|---|---|---|---|
| Publikované návody | všechny v aplikaci, i koncepty | interní i obecné | jen články označené *Určeno i pro externí* |
| Správa článků a historie | ano | ne | ne |
| Vytvoření hlášení | ano | ano | ano |
| Vlastní hlášení a odpovědi | ano | ano | ano |
| Cizí hlášení | v rámci aplikace | ne | ne |
| Interní poznámky | ano | ne | ne |

Cizí nebo nedostupný článek, hlášení či příloha vrací stejnou odpověď jako neexistující („neexistuje
nebo k němu nemáte přístup“). Interní poznámky a jejich přílohy server ostatním nikdy nepošle.

## 3. Jak vytvořit návod nebo FAQ

1. **Nápověda a podpora → Správa podpory → Návody a FAQ → + Nový článek.**
2. Vyplňte název, druh (Návod/FAQ), kategorii, krátký úvod a pořadí.
3. Obsah se píše jednoduchým zápisem: `## Nadpis`, `### Podnadpis`, `- odrážka`, `1. krok`,
   `**tučně**`, `_kurzíva_`, `[odkaz](https://…)` nebo `[odkaz](/abf#/podpora/hlaseni)`. HTML ani vlastní
   `<iframe>` se nikdy nevykreslí, zobrazí se jako obyčejný text. Tlačítko **Náhled** ukáže výsledek.
4. Obrázek nebo video nahrajete tlačítkem **Vložit obrázek nebo video**. Na konec textu se vloží
   `![popis](příloha:<id>)`, k článku se připojí uložením. Video z YouTube nebo Vimeo vložíte
   **odkazem**: přehrávač sestaví aplikace (youtube-nocookie / Vimeo dnt) v sandboxu, jiné adresy se
   nepřehrají.
5. Zaškrtněte části aplikace, kde se má článek nabízet v *Nápovědě k této stránce*.
6. **Určeno i pro externí uživatele** zaškrtávejte jen u obecných návodů, nikdy u administrace, cen
   nebo neveřejných postupů.
7. Stav: *Koncept* vidí jen správci, *Publikováno* uživatelé podle tabulky výše, *Archivováno* jen
   správci.
8. **Uložit.** Každé uložení je nová verze s autorem a časem. *Historie verzí* umí starší verzi
   zobrazit a **obnovit jako novou verzi** (historie se nepřepisuje). Když článek mezitím uložil někdo
   jiný, uložení se odmítne a nabídne se načtení aktuální verze, takže se nic tiše nepřepíše.
9. Komentáře a návrhy oprav uživatelů najdete pod článkem. Správce je může *Označit jako vyřešené*
   nebo *Skrýt*. Externí účet vidí jen své vlastní komentáře.

Návody pište jen o ověřené funkčnosti. V DEV nejsou žádné předpřipravené články, testovací články byly
po ověření smazány.

## 4. Jak vyřídit hlášení

1. **Správa podpory → Hlášení.** Filtry stav, druh a autor, odznak v menu ukazuje nová hlášení.
2. Detail obsahuje popis, u chyb kroky a očekávaný a skutečný výsledek, přílohy a *Kontext*
   (aplikace, oblast, bezpečná cesta bez parametrů, verze/build, prohlížeč, velikost okna, autor a čas).
   Připojená zakázka se zobrazí jménem jen tomu, kdo k ní má přístup. Obsah zakázky se do hlášení
   nikdy neukládá.
3. **Odpověď autorovi**, nebo **Interní poznámka** (žlutá, autor ji nikdy nedostane, ani její přílohy).
4. **Stav a řešitel:** Nové → Řeší se → Čeká na doplnění → Vyřešené → Uzavřené. Vyřešené nebo Uzavřené
   lze znovu otevřít (→ Řeší se, v historii jako *Znovu otevřeno*). Řešitelem může být jen aktivní
   správce ABF. Když hlášení mezitím změnil někdo jiný, uložení se odmítne.
5. Jakmile autor odpoví na hlášení ve stavu *Čeká na doplnění*, vrátí se samo do *Řeší se*.
   Do uzavřeného hlášení autor už nepíše (zakládá nové).
6. Historie zaznamenává založení, změny stavu, znovuotevření a změny řešitele.

O nových hlášeních, odpovědích a změnách stavu informují e-mailová upozornění (kap. 6). Napojení
na GitHub podpora nemá.

## 5. Přílohy a snímky obrazovky

- Povolené typy: obrázky **PNG, JPEG, WebP do 10 MB**, videa **MP4, WebM do 100 MB**. Hlášení má
  nejvýš **8 příloh a 60 MB** celkem, odpověď nejvýš 5 příloh, článek nejvýš 20. SVG, HTML a další
  aktivní obsah se odmítá podle názvu i deklarovaného typu. Po nahrání server ověří **skutečný obsah**
  (magické bajty) a velikost uloženého souboru. Co nesouhlasí, smaže.
- Tři způsoby: **Přiložit soubor** (na telefonu fotka nebo snímek z galerie), **Vložit ze schránky**
  nebo Ctrl+V kdekoli ve formuláři a **Snímek původní karty** (`getDisplayMedia`). Výběr prohlížeče
  se otevře na kartách (`displaySurface: "browser"`) a samotnou kartu s formulářem vynechá
  (`selfBrowserSurface: "exclude"`), takže se nabízí karta s aplikací, kde problém vznikl.
  Zdroj vždy vybírá uživatel. Žádá se jen video bez zvuku a po jednom snímku se všechny stopy hned
  zastaví (žádné nahrávání). Když vybraná karta nepošle obraz do 10 s, stopy se zastaví a formulář
  nabídne Ctrl+V. Zrušený výběr není chybou formuláře. Když prohlížeč funkci nemá, tlačítko se
  nezobrazí.
- **Předání kontextu do nové karty:** v adrese formuláře je jen náhodný jednorázový klíč za `#`
  (`/abf/nahlasit#k=<uuid>`). Část za `#` se neposílá na server ani do logů. Kontext původní stránky
  (oblast, cesta bez parametrů, prohlížeč, okno, případně uložená zakázka) se předá přes
  `localStorage` téže domény a platí 2 hodiny. Po odeslání se smaže a staré klíče se uklízejí.
  Obsah formulářů ani tokeny se nepředávají. Formulář otevřený bez klíče upozorní, že kontext chybí,
  a cestu uloží prázdnou.
- Před odesláním je u každé přílohy náhled s možností **Upravit** (obdélník, kresba, **Zakrýt**
  neprůhledným černým obdélníkem) a **Odebrat**. Úpravy se zapečou do pixelů nového PNG a odešle se
  jen upravený obrázek, originál zůstane jen v prohlížeči.
- Do odeslání zůstává vše v prohlížeči. Při odeslání: presign → nahrání do soukromého R2
  (`support/<app>/<id>/<název>`) → ověření → uložení hlášení v jedné transakci. Neověřená příloha
  hlášení zastaví (text zůstane). Při selhání uložení se hlášení nevytvoří a už nahrané přílohy se při
  dalším pokusu použijí znovu. Dvojí odeslání (dvojklik, opakování po ztracené odpovědi) vytvoří jen
  jedno hlášení.
- Soubory se vydávají jen jako odkazy platné **5 minut** a jen po kontrole, že článek nebo hlášení
  smí uživatel číst.
- Úklid: `npm run support:dev:cleanup` (suchý běh) a `-- --apply --confirm=<dev ref>` smažou nahrání
  starší 24 h, která se nikdy nepřipojila k obsahu. Připojené soubory skript bez `--all` nikdy nemaže.

## 6. E-mailová upozornění (V1-SUPPORT-02)

### Kdo dostane e-mail

| Událost | Příjemce |
|---|---|
| Nové hlášení | správci aplikace (aktivní účty s rolí správce ABF) |
| Veřejná odpověď správce | autor hlášení |
| Stav *Čeká na doplnění* | autor hlášení |
| Stav *Vyřešené* | autor hlášení |
| Odpověď autora | přiřazený řešitel, pokud je pořád správcem, jinak všichni správci aplikace |

- Interní poznámky se nikomu neposílají a nikdo nedostane upozornění na svou vlastní akci.
  Jiné změny stavu (Řeší se, Uzavřené, znovuotevření) e-mail neposílají.
- E-mail obsahuje číslo hlášení, předmět, krátkou větu o tom, co se stalo, a odkaz na detail. Autor
  dostane odkaz do *Moje hlášení*, správce do *Správy podpory*. Text odpovědí, popis, interní
  poznámky ani přílohy v e-mailu nejsou, zůstávají v aplikaci.
- Adresa se čte z účtu až při odeslání, takže platí aktuální e-mail účtu. Těsně před odesláním se
  znovu ověří, že účet je aktivní, je pořád členem aplikace a hlášení smí číst. Když ne, e-mail se
  neodešle (v záznamu je *Neodesláno*).

### Evidence, opakování a duplicity

- Uložení hlášení, odpovědi nebo změny stavu e-mail jen **zařadí** do tabulky
  `support_notifications` (jeden řádek = jedna zpráva jednomu příjemci). Odesílá se až po odpovědi
  serveru, takže ukládání na SMTP nikdy nečeká. Chyba fronty ani SMTP uložení nezablokuje.
- Dvojice *událost + příjemce* je v tabulce jedinečná. Opakovaný požadavek (dvojklik, nové odeslání
  po ztracené odpovědi) proto žádnou další zprávu nevytvoří.
- Když odeslání selže, zpráva se automaticky zkusí znovu za 1, 5, 15, 60 a 240 minut. Po 6 pokusech
  se vzdá (záznam *Selhalo*). Souběžné odesílače si zprávy nepřeberou (`FOR UPDATE SKIP LOCKED`),
  takže stejná zpráva neodejde dvakrát.
- **Výpadek fronty** (např. databáze nedostupná ve chvíli uložení): hlášení ani odpověď se neztratí.
  Do logu serveru se zapíše `Support notifications: queueing failed {"ticket":<číslo>,"ticketId":…,
  "eventKey":…}`, kde podle čísla hlášení dohledáte, čeho se výpadek týkal. Správce v detailu hlášení
  uvidí „Chybí záznam upozornění“ (události posledních 7 dní bez záznamu) a tlačítko **Doplnit
  chybějící upozornění**. Upozornění se sestaví z uložených dat se stejnými klíči událostí. Událost,
  která už záznam má, se znovu nezařadí, takže nevznikne druhé hlášení ani druhý e-mail. Opakované
  odeslání téhož hlášení (stejné id odeslání) mezeru doplní také.
- Správce vidí v detailu hlášení oddíl **E-mailová upozornění**: komu, o čem, stav (Čeká / Odesláno /
  Selhalo / Neodesláno), počet pokusů, čas dalšího pokusu a důvod. Autor tento záznam nevidí.

### Konfigurace

Používá se společné SMTP z kap. 9.4 v [AUTH_SETUP.md](AUTH_SETUP.md): `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, případně `SMTP_SECURE=true`. Hodnoty patří jen do
proměnných prostředí (Vercel, `.env.local`).

- **Bez SMTP** se upozornění nikomu neposílají. Ve *Správě podpory* svítí varování „E-mailová
  upozornění nejsou aktivní“ s chybějícími proměnnými a zprávy se evidují jako *Neodesláno*.
  Po doplnění SMTP se staré zprávy dodatečně neposílají.
- **DEV:** zpráva odejde jen na adresy ze `SMTP_DEV_ALLOWED_RECIPIENTS` (e-maily nebo `@domény`).
  Ostatní jsou *Neodesláno*, takže testy nikdy neposílají skutečným lidem.
- **Produkce:** nutná je i `APP_BASE_URL` (adresa aplikace pro odkaz v e-mailu, https). Bez ní
  odeslání selže s důvodem „Chybí adresa aplikace“ a zkouší se znovu.

### Automatické odesílání na hostingu

1. **Hned po uložení:** odesílá se ve stejné funkci po odpovědi (`after()` z `next/server`).
   Nepotřebuje žádné nastavení.
2. **Opakované pokusy:** zpracuje je dávka, kterou spustí
   - každý otevřený klient aplikace: přehled podpory se dotazuje každé 2 minuty a po odpovědi pošle
     až 10 zpráv, jejichž čas přišel. Funguje i bez plánovače, ale jen když má někdo aplikaci otevřenou;
   - **plánovač (doporučeno):** `GET /api/support/notifications/dispatch` s hlavičkou
     `Authorization: Bearer <CRON_SECRET>` pošle až 50 zpráv. Bez `CRON_SECRET` (alespoň 16 znaků)
     odpoví 503, se špatným klíčem 401. Session nepotřebuje.

   **Vercel Cron:** v projektu nastavte proměnnou `CRON_SECRET` (Vercel ji pak sám posílá v hlavičce
   `Authorization`) a do `vercel.json` doplňte:

   ```json
   "crons": [{ "path": "/api/support/notifications/dispatch", "schedule": "*/5 * * * *" }]
   ```

   Plán *Hobby* povoluje cron jen jednou denně (pak `"0 6 * * *"` a opakování během dne zajistí
   otevření klienti). Plán *Pro* zvládne každých 5 minut. Cron běží jen na produkčním nasazení.
   Do `vercel.json` jsem ho zatím **nepřidal**: změna se projeví až nasazením a jeho podobu určuje
   tarif.

   **Jiný hosting:** libovolný plánovač, např.
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<aplikace>/api/support/notifications/dispatch`
   každých 5 minut.

## 7. Data a migrace

Migrace `supabase/migrations/20261111120000_app_support.sql` přidává 7 tabulek (`support_articles`,
`support_article_versions`, `support_article_comments`, `support_tickets`, `support_ticket_messages`,
`support_ticket_events`, `support_attachments`) navázaných na `hws_apps` a `app_users`. Všechny mají
zapnuté RLS a žádné politiky (prohlížeč do databáze nesahá). Dále přidává 5 funkcí
(`support_attach`, `support_create_ticket`, `support_add_message`, `support_update_ticket`,
`support_save_article`), spustitelných jen pro `service_role`. Odeslání téhož hlášení dvakrát
souběžně serializuje zámek `pg_advisory_xact_lock`.

Kód: `domain/support.ts` (pravidla, bezpečný zápis článků, kontext, přílohy, úprava obrázků),
`lib/support/*` (API, úložiště, soubory), `app/api/support/**` (17 rout),
`components/support/*` (UI), testy `tests/support.test.ts`.

Migrace `20261112120000_support_notifications.sql` (V1-SUPPORT-02) přidává tabulku
`support_notifications` (RLS bez politik) a funkci `support_claim_notifications` (jen
`service_role`). Kód upozornění: `lib/support/supportNotifications.server.ts`, pravidla příjemců
`planNotifications` v `domain/support.ts`, společné SMTP `sendSmtpMail` v
`lib/accounts/invitationMailer.server.ts`.

## 8. Návrat zpět (rollback)

Pořadí je důležité: soubory v R2 umí smazat jen úklidový skript, který je součástí kódu podpory,
a potřebuje k tomu ještě existující tabulky. Proto **soubory → zastavení aplikace → databáze → kód**.

**Celá podpora (V1-SUPPORT-01 + V1-SUPPORT-02):**

1. **Soubory příloh**, dokud jsou kód i tabulky na místě (aplikace může ještě běžet):
   `npm run support:dev:cleanup -- --all --apply --confirm=<dev ref>`. Nejdřív bez `--apply`
   (suchý běh). Skript smaže objekty `support/…` v R2 i jejich záznamy.
2. **Zastavte aplikaci** (dev server nebo nasazení) a vypněte plánovač
   `/api/support/notifications/dispatch`, pokud byl nastavený. Mezi kroky 1–4 tak nevzniknou nové
   přílohy, hlášení ani e-maily.
3. **Databáze** (DEV, po ověření cíle), v tomto pořadí:
   1. `supabase/rollback/20261112120000_support_notifications.down.sql` (fronta a evidence e-mailů),
   2. `supabase/rollback/20261111120000_app_support.down.sql` (tabulky, funkce a záznamy migrací
      podpory). Účtů, členství, projektů ani katalogu se nedotkne.
4. **Kód:** přepněte na verzi před V1-SUPPORT-01 (commit před podporou). Pak aplikaci znovu spusťte.

**Jen e-mailová upozornění (V1-SUPPORT-02):** soubory se nemažou. Zastavte aplikaci i plánovač,
spusťte `supabase/rollback/20261112120000_support_notifications.down.sql` (hlášení zůstanou, smaže
se jen evidence e-mailů), vraťte kód na stav před V1-SUPPORT-02 a aplikaci spusťte.
