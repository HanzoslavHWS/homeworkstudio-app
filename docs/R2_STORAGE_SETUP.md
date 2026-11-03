# Cloudflare R2 storage setup

HomeworkStudio používá jeden privátní R2 bucket. Do databázových/lokálních entit ukládá pouze stabilní `storageKey` a metadata; krátkodobé presigned URL se nikdy nepersistují.

## Serverové proměnné

Nastavte v `.env.local` a ve Vercel Environment Variables:

```text
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
```

Proměnné nesmí mít prefix `NEXT_PUBLIC_`. API token omezte na jediný používaný bucket a nezapisujte jeho hodnoty do logů. `.env.local` je již v `.gitignore`.

## CORS pro přímý browser upload

V Cloudflare Dashboard otevřete **R2 object storage → bucket → Settings → CORS Policy → Add CORS policy** a vložte konfiguraci níže. Produkční doménu nahraďte skutečnou HomeworkStudio doménou. Preview origin přidejte pouze jako konkrétní stabilní origin; dynamický wildcard pro všechny Vercel preview deploymenty zde záměrně není.

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "https://homeworkstudio.example.com"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": [
      "Content-Type",
      "x-amz-meta-original-file-name",
      "x-amz-meta-checksum"
    ],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Presigned PUT je svázaný s konkrétním `Content-Type`. Presigned GET/HEAD fungují s privátním bucketem; bucket nemusí a nemá být veřejný. Origin musí odpovídat přesně, bez koncového lomítka a bez URL cesty.

## Organizace bucketu

```text
events/{event}/logo/
events/{event}/cover/
events/{event}/documents/
catalog/furniture/{code}/photos/
catalog/furniture/{code}/thumbnails/
catalog/furniture/{code}/models/
projects/{project}/graphics/
projects/{project}/documents/
projects/{project}/visualizations/
projects/{project}/floorplans/
projects/{project}/exports/
temporary/
```

## Ruční ověření

Po nastavení CORS ověřte v přihlášené aplikaci logo, cover a dokument. Uložte event, obnovte stránku a znovu asset otevřete. Smoke test proti skutečnému R2 není součástí automatických testů, aby omylem nezměnil produkční data. Pokud jej budete provádět, použijte výhradně prefix `temporary/storage-smoke-test/` a po ověření smažte pouze vytvořený testovací objekt.

Fyzické mazání netemporary objektů je záměrně blokováno na API vrstvě, dokud nebude existovat globální reference tracking napříč eventy, projekty a katalogem. Editor odstraní metadata; objekt lze později bezpečně uklidit řízenou údržbou.

## DEV bucket (lokální vývoj)

Mimo produkci (`NEXT_PUBLIC_APP_ENV=development`) je úložiště vypnuté (upload/stažení = 503), dokud neplatí obojí:

- `R2_BUCKET_NAME` = `R2_EXPECTED_BUCKET`,
- název bucketu obsahuje samostatný segment `dev`, `test` nebo `preview` (např. `homeworkstudio-dev`).

Žádný fallback na produkční bucket neexistuje. Ochranu je ale třeba doplnit i na straně Cloudflare: DEV token smí mít přístup **jen** k DEV bucketu.

### Postup v Cloudflare (provádí uživatel)

1. **R2 object storage → Create bucket**: název `homeworkstudio-dev`, lokace Automatic, Standard storage class. Bucket nechte privátní (bez public access / r2.dev URL).
2. **Bucket → Settings → CORS Policy → Add CORS policy**:
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Pokud dev server běží na jiném portu, přidejte i ten origin (např. `http://localhost:3105`).
3. **R2 object storage → Manage R2 API Tokens → Create API token**: oprávnění **Object Read & Write**, *Apply to specific buckets only* → `homeworkstudio-dev`. Po vytvoření zkopírujte Access Key ID, Secret Access Key a S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).
4. Do `.env.local` (jen lokálně, není v Gitu) doplňte:
   ```text
   R2_ACCOUNT_ID=<account-id>
   R2_ACCESS_KEY_ID=<z tokenu>
   R2_SECRET_ACCESS_KEY=<z tokenu>
   R2_BUCKET_NAME=homeworkstudio-dev
   R2_EXPECTED_BUCKET=homeworkstudio-dev
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   ```
5. Restartujte `npm run dev` a spusťte `npm run r2:dev:check` (případně `-- --origin=http://localhost:3105`). Kontrola ověří konfiguraci, CORS (PUT i GET z localhostu) a nahraje, přečte a smaže jeden objekt v `temporary/storage-smoke-test/`. Klíče nevypisuje.

### Co aplikace s DEV bucketem umí (katalog)

| Soubor | Kategorie | Formáty | Limit |
|---|---|---|---|
| Fotografie | `catalog-photo` | JPG, PNG, WebP | 15 MB |
| 3D model (náhled v generátoru) | `catalog-model` | GLB | 100 MB |
| Podklady | `catalog-source` | SKP, DWG, DXF, PDF | 150 MB |
| Ikona technického bodu | `catalog-technical-icon` | SVG, PNG | 2 MB |

Nahrání = podepsaná PUT adresa (10 min) přímo do R2; klíč `catalog/furniture/<karta>/<druh>/<UUID>.<přípona>` (bez kolizí, bez původního názvu v cestě). Karta ukládá jen metadata (`storageKey`, název, typ, velikost) a dostane je až po úspěšném nahrání — přerušený upload kartu nezmění (nanejvýš zůstane neodkázaný objekt). „Odebrat referenci“ odstraní metadata z karty; objekt v bucketu zůstává (mazání mimo `temporary/` je záměrně blokované, viz výše).
