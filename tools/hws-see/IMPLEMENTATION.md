# HWS SEE — implementační plán a architektura

Stav k 21. 11. 2026. Zadání: `tools/hws-see/SPEC.md`. Průběžný stav a blokery: `tools/hws-see/STATUS.md`.

## 1. Zjištěná skutečnost (inspekce repozitáře)

| Oblast | Zjištění |
|---|---|
| Repozitář | `homeworkstudio-app-web` = worktree živé webové větve (`master`, nasazováno na Vercel / app.homeworkstudio.cz). **Ne** ABF DEV (`develop` v hlavní složce). Práce na větvi `feature/hws-see-mvp` vytvořené z `master` (a9ead51). |
| Stack | Next.js 16.3 (App Router, `proxy.ts` místo middleware), React 19, TypeScript 7 (`strict: false`), čisté CSS (`app/globals.css`, žádné shadcn/Tailwind na této větvi), `three` 0.185 (už používán ABF CAD viewerem), `@supabase/supabase-js` (service-role pouze na serveru), `@aws-sdk/client-s3` + presigner pro Cloudflare R2. |
| Testy | `node --test` nad `.ts` soubory (type stripping), handlery rout exportované jako `handleX(request, …, depsFactory)` a testované s fake repozitáři. Žádný lint skript v `package.json`. |
| Launcher | `app/page.tsx` → `components/Launcher.tsx`, data v `data/launcherApps.ts` (HWS Easy „Připravujeme“, ABF Generator `/abf`). |
| Lehký login | `/login` → `POST /api/auth/login` porovná **jedno sdílené heslo** `APP_LOGIN_PASSWORD`, vydá HMAC‑podepsanou HttpOnly cookie `homeworkstudio_session` (`lib/auth/session.ts`, TTL 12 h). Session je **ověřitelná na serveru**, ale **nenese identitu osoby**. `proxy.ts` chrání vše kromě `/login`. |
| Admin registr aplikací/účtů | Na `master` **neexistuje**. (Per-account registr `hws_apps`/`app_memberships` existuje jen ve vývojové větvi `develop`, V1-AUTH-02 — mimo rozsah.) |
| DB | Supabase Postgres, migrace v `supabase/migrations/`, RLS zapnuté bez politik, přístup jen přes API routy se service-role klientem. |
| Úložiště | Jeden privátní R2 bucket, presigned PUT/GET (`lib/storage/cloudflareR2.server.ts`), whitelist prefixů v `domain/assets.ts`. |
| Deploy | Vercel (bez `vercel.json`/`next.config`), env proměnné ve Vercelu, `.env.example` vzor. |

## 2. Architektura modulu

```
Portál /  ──(karta HWS SEE)──▶ /see ──▶ /see/new  (Nový projekt)
                                    └─▶ /see/projects  (Projekty) ──▶ /see/projects/[id]  (editor)
Veřejně (bez loginu):  /see/p/[slug]   /see/embed/[slug]
```

### Vrstvy
- `domain/seeProject.ts` — typy, stavy (`active/paused/archived/deleted`, publikace `draft/published`, režim **jen** `public | pin`), validace, snapshot publikace, filtr dokumentů pro scénu. Čisté funkce.
- `domain/seeFiles.ts` — povolené typy (GLB, PDF, JPG, PNG), limity z env, kontrola magic bytes, neprůhledné klíče objektů `hws-see/o/<uuid>.<ext>`.
- `domain/seeViews.ts` — jediné místo, kde se z dat odstraní serverová pole (`storageKey`, `pinHash`, `accessEpoch`) před odesláním do prohlížeče; texty pozvánek, embed snippet.
- `lib/see/auth.server.ts` — **adapter identity**: `currentUser`, `requireViewerEditor`, `requireViewerAdmin`, `SEE_ENTITLEMENT = "hws_see"`. Dnes vrací poctivý sdílený účet „Současný portálový účet“ (`portal:shared`) při platné serverově ověřené portálové session.
- `lib/see/security.server.ts` — PIN (PBKDF2‑SHA256, 600 000 iterací, sůl 16 B), generování PINu/slugu/grant tokenu (CSPRNG), HMAC tickety, hashované klíče klientů/návštěvníků (bez surových IP).
- `lib/see/repository*.ts` — rozhraní + Supabase implementace (jen tabulky `see_*`) + in-memory implementace (testy a explicitní lokální dev režim).
- `lib/see/storage.server.ts` — R2 (presigned PUT/GET, HEAD, range GET pro kontrolu obsahu, stream) + lokální disk pro dev.
- `lib/see/service.server.ts` — veškerá business logika (projekty, editor, upload+ověření, publikace, PIN + rate limit, veřejný přístup, statistiky, doručení souborů).
- `lib/see/proxyRules.ts` + `proxy.ts` — explicitní veřejné výjimky a bezpečnostní hlavičky.
- `app/api/see/**` — tenké route handlery; `app/see/**` stránky; `components/see/**` UI (`SeeViewer` = three.js).

### Datový model (migrace `supabase/migrations/20261121120000_hws_see.sql`)
`see_projects`, `see_scenes`, `see_annotations`, `see_files`, `see_file_scene_links`, `see_publications`, `see_access_grants`, `see_pin_attempts`, `see_events` + funkce `see_record_view`. Čistě aditivní, RLS na všech tabulkách. Rollback: `supabase/rollbacks/20261121120000_hws_see.down.sql` (mimo `migrations/`, aby jej `supabase db push` nikdy nespustil).

### Publikace a bezpečnost
- Režimy **přesně dva**: `public` (kdokoli s odkazem) a `pin` (serverově ověřený číselný PIN). CHECK constraint v DB, validace v API, test.
- Publikovaný obsah = **snapshot** (`see_publications.snapshot`) — rozpracované změny se k návštěvníkům nedostanou do „Publikovat znovu“. Smazání souboru se ale projeví okamžitě.
- `access_epoch` se zvýší při každé bezpečnostní změně (nový PIN, změna režimu, zrušení publikace, rotace odkazu, pauza, archivace, smazání) → všechny granty i vydané tickety okamžitě neplatné; navíc se granty explicitně revokují.
- PIN: 8 číslic (vlastní 8–12), jen hash. Rate limit: 5 chybných pokusů / 15 min na hashovaného klienta + 50 / 15 min na publikaci, kontrola **před** výpočtem hashe, 400 ms zpoždění po chybě, `Retry-After`.
- Grant: 32 B náhodný token, v DB jen SHA‑256, TTL 120 min; HttpOnly cookie (`SameSite=None; Secure; Partitioned` v produkci, cesta omezená na API jednoho odkazu) + fallback hlavičkou `x-see-grant` z paměti stránky pro iframe s blokovanými cookies třetích stran (stejná serverová kontrola).
- Každý požadavek na model/dokument jde přes `/api/see/public/[slug]/files/[fileId]` → kontrola publikace, stavu projektu, grantu a příslušnosti souboru ke snapshotu → krátká URL (presigned R2 GET 60 s, nebo `SEE_FILE_DELIVERY=stream` s re-validací epochy při každém čtení).
- `noindex` (meta + `X-Robots-Tag`), `Referrer-Policy: no-referrer` na veřejných stránkách, administrace `X-Frame-Options: DENY` + `frame-ancestors 'none'`, embed `frame-ancestors` dle `SEE_EMBED_FRAME_ANCESTORS` (výchozí `'self' https:`).
- Statistiky: počítá se jen skutečné otevření (POST z načtené stránky po autorizaci), bez botů/prefetch, dedupe 30 min; návštěvník = HMAC(den|IP|UA) — bez surových IP, nepropojitelné mezi dny.

### 3D viewer (`components/see/SeeViewer.tsx`)
Čisté `three` (už v repu, žádná druhá implementace): GLTFLoader + Draco (self-hosted `public/see/draco/`) + Meshopt, PBR s RoomEnvironment (PMREM, studiové „HDRI“), ACES tone mapping, sRGB, 3 předvolby světla, expozice, pozadí; OrbitControls (myš + dotyk), resize, fullscreen, loading/error/empty stavy, dispose zdrojů, limit pixel ratio na mobilech, kamera přizpůsobená poměru stran. Popisky = HTML overlay promítaný z 3D bodu s detekcí zakrytí; vkládání raycastem do geometrie, souřadnice v prostoru modelu (kořen GLB se netransformuje).

## 3. Postup DEV → produkce (Cloudflare / Supabase / Vercel)

1. **Review** větve `feature/hws-see-mvp` (`git diff master...feature/hws-see-mvp`).
2. **DB (DEV projekt, ne produkce):** spustit `supabase/migrations/20261121120000_hws_see.sql` v SQL editoru DEV Supabase, ověřit tabulky + `see_record_view`.
3. **R2:** doporučeno vytvořit bucket `hws-see-prod` (a `hws-see-dev`), API token s oprávněním *Object Read & Write* jen na tento bucket (musí umět i CopyObject a DeleteObject — překlíčování při zrušení přístupu, §5). Bucket **neveřejný** (žádná public URL / r2.dev).
   CORS bucketu (přesné originy, bez wildcardů):
   ```json
   [{ "AllowedOrigins": ["https://app.homeworkstudio.cz", "http://localhost:3000"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["Content-Type"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
      "MaxAgeSeconds": 3600 }]
   ```
   Alternativa bez nového bucketu: nechat `SEE_R2_BUCKET_NAME` prázdné → sdílený bucket s prefixem `hws-see/` (generické `/api/assets/*` tento prefix záměrně nepřijímají).
4. **Vercel env (Preview i Production zvlášť):** `SEE_R2_BUCKET_NAME`, volitelně `SEE_MAX_MODEL_MB`, `SEE_MAX_DOCUMENT_MB`, `SEE_FILE_URL_TTL_SECONDS`, `SEE_PIN_GRANT_TTL_MINUTES`, `SEE_FILE_DELIVERY`, `SEE_EMBED_FRAME_ANCESTORS`. **Nikdy** `SEE_BACKEND` v cloudu (v produkci je stejně ignorováno). Ostatní (Supabase, R2 účet, `APP_SESSION_SECRET`) už existují.
5. Ověřit na Preview proti DEV DB/bucketu akceptační scénář (SPEC §10) v anonymním okně.
6. Teprve po schválení: migrace do produkční DB (ručně), merge do `master`, push = produkční deploy (Vercel). Nic z toho neprovedl Claude.

## 4. Napojení na budoucí jednotnou administraci
- Aplikace má klíč `hws-see`, entitlement `hws_see`, role `editor`/`admin` (`lib/see/auth.server.ts`, `data/launcherApps.ts → entitlement`).
- Až bude na produkci per-account login (např. V1-AUTH-02 `app_memberships`): přidat `hws-see` do registru aplikací, v `resolveActor` načíst účet a jeho membership → vrátit `SeeActor` s reálným `id/label` a rolemi; launcher kartu zobrazit podle membership. Routy už všechny jdou přes `requireViewerEditor` / `requireViewerAdmin`; sloupce `created_by/updated_by(_label)` už existují.

## 5. Iterace 2 (21. 11. 2026) — P2, audit, okamžité zneplatnění, výkon

### KTX2 / Basis Universal
- Viewer: `KTX2Loader` s transcoderem z `public/see/basis/` (kopie `three/examples/jsm/libs/basis`, verze odpovídá `three` 0.185) → textury se převádějí do nativního GPU formátu (ASTC/ETC2/BC7/…), méně paměti GPU, rychlejší mobil. Draco (`public/see/draco/`) a Meshopt zůstávají.
- Proxy výjimka jen pro 4 konkrétní statické soubory dekodérů (`lib/see/proxyRules.ts`).
- Server při uploadu čte **jen JSON blok GLB** (`domain/seeFiles.ts → inspectGlb`): ověří glTF 2.0, zjistí rozšíření, počty meshí/materiálů/textur, typy obrázků, odhad trojúhelníků. GLB s *povinným* rozšířením, které viewer neumí (např. `KHR_materials_pbrSpecularGlossiness`), se odmítne (422) místo toho, aby se rozbil až u zákazníka. Výsledek se ukládá do `see_files.model_info` a editor z něj ukazuje doporučení k optimalizaci.

### Embed politika pro každou prezentaci
- `see_publications.embed_policy` (`default | allowlist | none`) + `embed_origins` (max. 20, jen `https://host`, `https://*.host`, lokálně `http://localhost:port`).
- `proxy.ts` (Next 16 = Node.js runtime) při každém požadavku na `/see/embed/<slug>` načte politiku publikace (`lib/see/embedPolicy.server.ts`) a pošle odpovídající `Content-Security-Policy: frame-ancestors …`. Neznámý slug / nedostupná DB → globální politika (stránka stejně nic neukáže).
- Řídí jen *vkládání*; přístup k obsahu dál chrání odkaz a PIN. Změna politiky neodhlašuje návštěvníky (nemění epochu).

### Okamžité zneplatnění přístupu k souborům
| Mechanismus | Co zastaví | Kdy | Náklady / omezení |
|---|---|---|---|
| `access_epoch` + revokace grantů | nové požadavky na manifest/soubory/tickety | okamžitě | žádné |
| **Překlíčování objektů** (`SEE_REKEY_ON_REVOKE`, výchozí zapnuto) | již vydané presigned R2 URL | okamžitě (404) | CopyObject + DeleteObject na každý soubor projektu; rozběhnutý přenos z R2 doběhne |
| Krátké TTL presigned URL (`SEE_FILE_URL_TTL_SECONDS`, 60 s) | zbytek, pokud překlíčování selže | ≤ TTL | — |
| `SEE_FILE_DELIVERY=stream` | i **rozběhnuté stahování** (kontrola každé 3 s) | okamžitě | bajty přes funkci portálu (egress, limity Vercelu – ověřit) |
| `SEE_FILE_DELIVERY=hybrid` | dokumenty jako `stream`, modely přes překlíčované presigned URL | okamžitě | kompromis pro velké GLB |
| Cloudflare Worker + R2 binding s kontrolou tokenu (nenasazeno) | vše na hraně CDN | okamžitě | vyžaduje produkční Cloudflare — doporučení do budoucna |
| Rotace R2 API klíče | všechny URL celé aplikace | okamžitě | nouzová brzda, zasáhne i ABF |

Překlíčování se spouští při každém **zpřísnění**: zrušení publikace, nový PIN, přepnutí na PIN, nový odkaz, pozastavení, archivace, smazání projektu a odstranění souboru v editoru. Pořadí copy → zápis do DB → delete starého zaručuje, že obsah nikdy nezmizí; selhání se vrací editoru jako varování (přístup je přesto zablokovaný na úrovni aplikace).

### Další bezpečnostní úpravy z auditu
- CSRF: všechny requesty s tělem musí mít `Content-Type: application/json`, `Sec-Fetch-Site: cross-site` nebo cizí `Origin` → 403 (`lib/see/http.server.ts`).
- PIN DoS: globální strop 50 chyb / 15 min se počítá od pozdějšího z „před 15 min“ a „nastavení PINu“ → správce zámek ukončí novým PINem; editor zobrazuje počet chyb a stav zámku.
- Doručené soubory: `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'` nastavuje i proxy (jinak by ji přepsal).

### Výkon vieweru (bez snížení kvality materiálů)
- Render na vyžádání (v klidu 0 draw callů), snížené rozlišení jen během tažení na telefonu, MSAA vypnuté jen na ≥2× displejích telefonů, `powerPreference` podle zařízení — čistá funkce `domain/seeViewerProfile.ts`.
- Anizotropní filtrování textur (desktop 8×, mobil 4×), statické matice modelu, test zakrytí popisků až v klidu.
- Přednačítání ostatních modelů projektu na pozadí (vypnuto při Save-Data / 2G / ≤ 2 GB RAM), sdílené požadavky, cache až 3 scén, kompilace shaderů mimo obrazovku tam, kde GPU umí `KHR_parallel_shader_compile`.
- Tone mapping Khronos **PBR Neutral** místo ACES — věrné základní barvy produktových materiálů.

## 6. Iterace P3 (21. 11. 2026) — připravenost na produkci

### Robustnost R2 a částečných operací
- Vlastní S3 klient HWS SEE (`createSeeR2Client`): timeout spojení 5 s / požadavku 60 s, 3 pokusy SDK s backoffem; sdílený klient ABF beze změny.
- Výpadky (timeout, ECONNREFUSED/ENOTFOUND…, 5xx, 429) → `SeeStorageUnavailableError` → HTTP **503 + Retry-After: 30** s českou zprávou. Odmítnutí kvůli konfiguraci (403 AccessDenied) se jako výpadek **nemaskuje**.
- Upload: presign bez zápisu při výpadku; „complete“ je idempotentní, při výpadku zůstává soubor `pending` (nikdy `rejected`, bajty se nemažou), opakování po obnovení projde. Opuštěné uploady (presigned PUT dávno vypršel) se nepočítají do limitů a nezobrazují — **nic se nemaže**.
- Prohlížeč: opakování přímého PUT (3×, backoff) a ověření (3× při 0/408/429/5xx), srozumitelné hlášky „Spojení se přerušilo, zkouším znovu (2/3)…“; 403 u PUT = vypršelý odkaz → výzva k novému nahrání (`domain/seeRetry.ts`).
- Překlíčování (`rekeyOneFile`): kopie → **ověření kopie (HEAD, velikost)** → **compare-and-set** v DB (`update … where storage_key = old`) → smazání starého objektu. Neznámý výsledek zápisu do DB → záznam se znovu přečte a kopie se smaže jen tehdy, když na ni prokazatelně nic neukazuje. Souběžné akce (nový PIN + nový odkaz + pauza) nikdy nevytvoří záznam ukazující na neexistující objekt (25 kol náhodného vkládání chyb v testech).
- Uložení editoru je idempotentní celkový stav — selhání uprostřed opraví opakované „Uložit“. Změna stavu projektu zapisuje nejdřív projekt (pauza blokuje odkaz sama o sobě), pak publikaci.
- Bezpečnost okamžitého zneplatnění: nové klíče jsou náhodné UUID (neuhodnutelné), R2 je silně konzistentní (smazaný objekt je okamžitě 404 pro všechny), presigned S3 URL nejsou cachované CDN, epocha + revokace grantů blokují aplikační vrstvu ještě před prací s R2 → výpadek R2 nikdy nezabrání zrušení přístupu.

### 3D viewer
- Indikátor načítání po fázích: „Připravuji přístup…“ → „Stahuji model X / Y MB“ + lišta (neurčitá při neznámé velikosti) → „Zpracovávám model…“; upozornění u modelů > 30 MB.
- Selhání: 1 tiché opakování s čerstvou URL (vypršelá / překlíčovaná URL, přerušené spojení), pak chyba s **„Zkusit znovu“**; poškozený soubor / nepodporovaná komprese bez zbytečného opakování; ztráta WebGL kontextu → „Obnovit stránku“.
- Kamera: čistá funkce `domain/seeCameraFit.ts` (testováno 2 mm – 80 km, poměry 0,46–2,4, model 50 km od počátku); užší rozsah near/far (poměr 12 000 místo 200 000) = méně „blikání“ souběžných ploch.
- Fullscreen celé prezentace (lišty zůstávají), náhradní CSS režim tam, kde Fullscreen API chybí nebo ho prohlížeč tiše odmítne (iPhone, iframe bez `allow`), Escape zavírá; bezpečné okraje (notch), větší body popisků na dotyku, bez kontextového menu při dlouhém stisku.
- Nasvícení/PBR ověřeno PBR mapou (kovovost × drsnost, emisivní materiál) — beze změny presetů, chovají se fyzikálně správně.

### Administrace
- Ochrana neuložených změn: potvrzení při odchodu odkazem, varování prohlížeče při zavření/obnovení a **záloha konceptu v `sessionStorage`** s nabídkou „Obnovit / Zahodit“ (pokrývá i tlačítko Zpět, které App Router zablokovat neumí). Totéž pro rozpracovaný „Nový projekt“.
- Zprávy: potvrzení se samy skryjí (6 s), chyby a varování zůstávají do zavření, `aria-live`; varování z překlíčování se ukáže i v Projektech; štítek „Neuložené změny“; kontrola prázdných názvů před uložením.
- Projekty: „Publikováno – odkaz blokován“ u pozastavených/archivovaných, „Publikace zrušena“, datum posledního otevření.

### Nasazení
- `npm run see:env-check -- --target=preview|production` (`scripts/hwsSeeEnvCheck.ts`, `lib/see/envCheck.ts`) — offline, nevypisuje tajné hodnoty.
- `tools/hws-see/migration-dry-run.mjs` — všech 19 migrací + HWS SEE + rollback v PGlite (PostgreSQL 17), 35 kontrol.
- `tools/hws-see/r2-cors.json`, `tools/hws-see/DEPLOYMENT.md` (Supabase, R2, Vercel, smoke test, rollback).
- Zjištění: Next 16 `proxy` bufferuje těla požadavků jen do 10 MB → lokální upload routa `/api/see/dev-storage` je z matcheru vyjmutá a session kontroluje sama (produkční uploady jdou přímo do R2, proxy je nevidí).
