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
