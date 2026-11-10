# Převod UI na shadcn/ui (SHAD-01)

Větev `feature/shadcn-ui` (vychází z `develop` 4e1956b). Cílem je jedno společné UI celé aplikace;
první etapa převádí administraci a připravuje sdílený základ. Ostatní moduly zatím běží beze změny.

## Jak to funguje vedle starých stylů

| Soubor | Role |
|---|---|
| `app/app.css` | Vstupní styl (načítá ho `app/layout.tsx`). Pořadí vrstev `theme → base → legacy → components → utilities`, téma, omezený základ nové oblasti. |
| `app/globals.css` | Původní ručně psané styly, celé ve vrstvě `legacy` (jejich vzájemné pořadí se nezměnilo). |
| `components.json` | Konfigurace shadcn/ui (styl `radix-nova`, Radix UI, ikony lucide). |
| `components/ui/*` | Komponenty shadcn/ui + `workspace.tsx` (sdílené pracovní celky). |

Pravidla souběhu:

- **Bez globálního resetu.** Tailwind preflight se nenačítá; jeho práci dělá vrstva `base` jen uvnitř nové
  oblasti `[data-ui]` (kořen administrace v `AdminShell`) a v komponentách shadcn (`[data-slot]`, i v portálech).
- **Utility vyhrávají nad starými styly** díky pořadí vrstev, ne díky `!important`.
- **Holá pravidla starého CSS** pro `label`, `input`, `select` (výška 50 px, sloupcový label, zrušený outline)
  se na novou oblast nevztahují: selektor `:where(:not([data-ui] *, [data-slot], [data-slot] *))` zachovává
  původní specifičnost, staré obrazovky se nemění (pixelové srovnání před/po: 0 %).
- **Kolize názvů tříd:** staré obrazovky používají `hidden` a `visible` jako vlastní stavové třídy (např. skrytá
  vrstva CAD půdorysu). Tailwind je negeneruje (`@source not inline(...)`), jinak by utilita `display: none`
  řádek úplně schovala. Nové UI skrývá podmíněným vykreslením. Hlídá to `tests/uiMigration.test.ts`.
- **Tokeny tématu mají předponu `--ui-*`**, protože starý CSS už používá `--muted` (barva textu) a `--border`.

## Společné téma

Světlé, bez přepínače témat a bez dekorativních animací (balík `tw-animate-css` se záměrně nenačítá).

| Token | Hodnota | Použití |
|---|---|---|
| `primary` | `#17191c` | hlavní akce, aktivní záložky (identita HomeworkStudio) |
| `secondary` / `accent` | `#f1f2f3` / `#eef0f2` | vedlejší plochy, hover |
| `muted` / `muted-foreground` | `#f4f5f6` / `#5c6166` (6,2 : 1) | pozadí, popisky |
| `destructive` | `#b42318` (6,5 : 1) | archivace, odebrání |
| `success` / `warning` / `info` | zelená / jantarová / modrá + světlé varianty | stavy, hlášení |
| `border` / `input` | `#e1e3e5` / `#8b9095` (3,3 : 1) | oddělovače / okraje polí |
| `ring` | `#1f4a7a` | viditelný focus |
| `radius` | 8 px | zaoblení |

Písmo Arial (identita aplikace), pole formulářů Segoe UI (čitelná česká diakritika). Ovládací prvky 36 px
(`h-9`), text 14 px, popisky 13 px. Akce: hlavní `Button` (default), vedlejší `variant="outline"`,
destruktivní `variant="destructive"`, doplňková `ghost` / `link`.

## Komponenty

shadcn/ui (Radix): Button, Input, Textarea, Label, NativeSelect, Select, Checkbox, Switch, Tabs, Table,
Dialog, AlertDialog, Sheet, DropdownMenu, Badge, Tooltip, Card, Alert, Separator, Skeleton.
Úpravy oproti registru: výška prvků 36 px, `NativeSelect` přes celou šířku pole, české texty pro čtečky.

Sdílené pracovní celky (`components/ui/workspace.tsx`) — jediná sada, žádné paralelní varianty:

- `PageHeader` — nadpis, popis/počet, akce stránky;
- `ActionBar` — řádek akcí;
- `FilterPanel` — hledání a filtry (rozložení podle šířky panelu, container queries) + „Další filtry“;
- `Field` — popisek propojený s polem (`htmlFor` ↔ `id`), nápověda a chyba přes `aria-describedby`;
- `BulkActionBar` — jen při výběru: počet, rozsah, akce, „Zrušit výběr“;
- `EmptyState`, `LoadingState`, `Notice` (chyba / upozornění / úspěch / informace);
- `StatusBadge` — stav vždy symbolem i textem, ne jen barvou;
- `SectionCard` — titulovaný blok stránky;
- `ConfirmDialog` — potvrzení místo `window.confirm` (focus na Zrušit, Escape ruší).

## Převedené obrazovky (administrace)

Adresy a struktura administrace zůstaly (`/abf#/administrace/…`).

| Obrazovka | Stav |
|---|---|
| Rámec administrace, oblasti a záložky | převedeno ručně (`AdminShell`) |
| Katalog → Položky: hlavička, filtry, tabulka, výběr, hromadné akce, potvrzení archivace | převedeno ručně |
| Katalog → Vzorníky | převedeno ručně + oprava náhledů (viz níže) |
| Katalog → detail karty (formuláře, obsah kompletu, ceny, aliasy, soubory, publikace) | ovládací prvky převedeny (Button / Input / NativeSelect / Textarea), řádky a hlavička karty, stav jako `StatusBadge`; rozložení sekcí zatím původní |
| Knihovna stánků, Kategorie, Import Excelu | hlavička / kontejner + ovládací prvky převedeny |
| Ceníky (verze, starší, správa cen), Veletrhy, Realizační firmy, Uživatelé | `PageHeader`, ovládací prvky a hlášení převedeny; seznamy a mřížky formulářů zatím původní (responzivně upravené) |

Ovládací prvky se převáděly skriptem nad JSX (jen třídy `primaryButton`, `secondaryButton`, `dangerText`,
`linkButton`, `adminButton*` a tlačítka bez třídy; textová pole, jednoduché selecty, textarey). Checkboxy,
radio, výběr souboru a barvy zůstaly nativní (stylují se základní vrstvou), stejně jako vícenásobné selecty.

Čitelnost: administrace byla napsaná v písmu 7–10 px. Velikosti ve starém CSS se zvedly přímo u zdroje
(12–14 px), jen u pravidel, jejichž každý selektor míří na třídu používanou výhradně administrací.
Zbytek přechodových pravidel je blok „V1-ADMIN-01 / SHAD-01: admin transition bridge“ v `globals.css`;
pravidlo se maže spolu s posledním místem, které ho používá.

### Vzorník Koberce SERBUS — náhledy

Příčina šedých náhledů: panel Vzorníků převzal z varianty jen kód, název a barvu, fotografii zahodil, a sloupec
„Náhled“ byl ovladač barvy s výchozí hodnotou `#cccccc`. Varianty SERBUS žádnou barvu nemají, takže všechny
ukazovaly tutéž šedou.

Nyní: fotografie vzorku (podepsaná adresa z R2), jinak nastavená barva, jinak „Bez náhledu“ (s důvodem v
nápovědě). Barva se upravuje samostatným ovladačem („Nastavit barvu“ / „Zrušit“), nenastavená barva zůstává
nenastavená. Uložení vzorníku fotografie ani původ obrázků neposílá ani nemění. Stav v DEV: 56 barev,
55 fotografií, bez náhledu `PODIUM-PLAT-4962` (fotografie zadržená k ruční kontrole při importu, data
k dispozici nejsou — nic se nedoplňuje ani neodhaduje).

## Zbývající obrazovky celé aplikace

Nepřevedené (běží beze změny, pixelově ověřeno): přihlášení, projekty, úkoly, katalog pro zákazníky,
e-maily, tiskové plochy, technické rastry, kontrola vyúčtování a celý generátor (kroky Projekt, Konfigurátor,
Vizualizace, Souhrn, Export), 3D scéna, PDF výstupy a kreslicí plochy.

Další etapy (návrh):

1. Dokončení administrace: seznam + detail (`adminSplit`/`adminList`) → `Table`/`SectionCard`, formulář
   veletrhu na `Field`, detail karty po sekcích na `SectionCard`; pak smazat přechodový blok.
2. Provozní moduly: Projekty, Úkoly, E-maily, Katalog pro zákazníky, Kontrola vyúčtování.
3. Panely generátoru (bez 3D scény a kreslicích ploch): formuláře kroků, postranní panely, souhrn a export.
4. Tiskové plochy a technické rastry (jen ovládací panely; plátna a PDF beze změny).
5. Přihlášení a správa účtu; nakonec odstranit zbylá holá pravidla a nepoužité třídy z `globals.css`.

## Známá omezení

- Detail karty, veletrhy, ceníky, firmy a uživatelé mají převedené ovládací prvky, ale část rozložení je stále
  původní (přechodový blok CSS).
- Ochrana rozpracovaných změn zůstala v původní podobě (dotaz při odchodu z neuloženého veletrhu, stav
  „Neuložené změny“ a ukládání tlačítkem na kartě); nová ochrana nepřibyla.
- Technické rastry a tiskové plochy nemají v DEV pro testovací účet žádné projekty; ověřeno otevření modulů
  a shoda vzhledu, ne práce v editoru.
- Balík `shadcn` je vývojová závislost (CLI + `shadcn/tailwind.css` pro varianty komponent).
