# Technické rastry

A standalone module for ABF's technical department: matching a hall's measurement raster (a
vector PDF floor plan with stand numbers) against several technical-service PDF exports
(electricity, internet, water, waste, cleaning, ...) keyed by stand number, placing technical
symbols on the raster, and exporting a real vector PDF. Deliberately independent of the booth
generator and print surfaces — no shared state, no shared persistence, no shared PDF pipeline.

## Architecture overview

```
domain/technicalRaster.ts          — the project model + pure mutators (source of truth)
domain/technicalRasterMatching.ts  — stand-number matching engine (spárování)
domain/technicalReportParsers/*    — one parser per service category, category-agnostic
domain/technicalRasterServicePresentation.ts  — CENTRAL symbol/color/label config (untouched by component overrides — see below)
domain/technicalRasterComponentPresentation.ts — per-component override ADAPTER on top of the central config
domain/technicalRasterWorkQueue.ts — derived "K umístění / Hotovo" queue + auto-advance
domain/technicalRasterExport.ts    — export view-model (placements/legend/warnings/filename)
domain/technicalRasterExportPlacementGeometry.ts — rotation-aware normalized -> raw PDF point conversion
lib/technicalRasterVectorPdf.ts    — the vector PDF export pipeline (pdf-lib)
lib/pdf/technicalRasterWhiteRender.ts — "Pracovní — bílé" live editor render (PDF.js only, unrelated to export)
domain/catalogItemsAdmin.ts        — component/catalog card persistence, incl. technicalRaster config
```

### Raster project model

`TechnicalRasterProject` holds two independent layers:

- **The raster**: `sourceRasterAsset` (the uploaded PDF, never modified) + `rasterStandLabels[]`
  (detected stand-number text occurrences, normalized 0-1 page coordinates) + `rasterLayers[]`
  (the PDF's own real Optional Content Groups) + `rasterSettings` (per-project view preferences:
  original/work mode, "Krytí bílé" opacity, hidden technical-symbol categories).
- **Technical services**: `imports[]` (one row per uploaded report PDF) merged into
  `stands[].services[]`, purely by normalized stand number — company name is never the matching
  key.

`TechnicalStand` = `{ id, standNumber, companyName?, services[], notes[], placement, sourceImportIds[] }`.
`TechnicalService` = `{ id, category, externalLabel, quantity, rawValue, sourceImportId, sourcePage,
status, internalProductId?/internalProductCode?, placements? }`. `externalLabel`/`quantity` are
always the raw, verbatim parsed value — never discarded even when `status` is `unresolved_product`.

### SPÁROVÁNÍ vs. UMÍSTĚNÍ — two separate concepts, never conflated

- **Spárování** (`TechnicalStand.placement`) — whether the STAND is matched to a position in the
  raster PDF. Statuses: `unassigned`, `matched_auto`, `matched_manual`, `ambiguous`. A manual
  match is never overwritten by re-matching.
- **Umístění** (`TechnicalService.placements[]`) — whether a technical SERVICE has a physical
  point placed within the stand's own floor position. Each `TechnicalServicePlacement` is
  `{ id, page, xNormalized, yNormalized, createdAt }` — always normalized 0-1, relative to
  `page.getViewport({scale:1})`'s own (rotation-aware) width/height, never CSS/canvas pixels. A
  service can have up to `quantity` placements. The domain layer stores whatever coordinates it's
  given verbatim — it does not itself clamp to [0,1]; that guarantee is enforced at the UI
  boundary (`TechnicalRasterCanvas.tsx`'s `handleStageClick`, which refuses any click outside the
  page before ever calling `placeTechnicalService`).

Never reuse "přiřazeno" for either concept in UI text.

## Service presentation

`domain/technicalRasterServicePresentation.ts`'s `resolveTechnicalServicePresentation(category,
externalLabel)` is the ONE central place that decides `placementBehavior` (`"point" |
"informational" | "none"`), `renderer`, `displayLabel`, `color`, `legendLabel` for a real report
label — every consumer in the app (editor, work queue, export, symbol layer panel) calls this
exact function; there is no second/parallel implementation anywhere.

V1 defaults (verified against real parsed report labels, never invented):

| category | label pattern | placementBehavior | renderer | notes |
|---|---|---|---|---|
| electricity | "Do Nkw ..." | point | powerLabel | "N kW" extracted by regex; unextractable -> honest "EL" fallback, never a guessed number |
| electricity | "Lednicový okruh" / "Non stop" | point | refrigeratedStar | vector asterisk, never a Unicode glyph |
| internet | "Pevná IP" | point | textLabel | "IP" |
| internet | "Internet" (plain) | point | textLabel | "INT" — real cabled drop |
| internet | "WIFI" | **informational** | wifiIcon | conservative decision — quantity likely means device licenses, not distinct physical drop points |
| water | (category-level) | point | waterDrop | no real per-label variant seen |
| waste | "Kontejn 1100 l" etc. | **informational** | fallback | container likely sits outside the booth's own footprint; no confident placement rule |
| cleaning | "Denní úklid" etc. | **none** | fallback | zero spatial meaning, even at qty=40 |
| unknown | anything unrecognized | informational | fallback | `isFallback: true`, `console.warn`, never a guess |

### Component override precedence

`domain/technicalRasterComponentPresentation.ts`'s `resolveTechnicalRasterPresentation(service,
componentConfig?)` wraps the central resolver with a per-field override:

1. `componentConfig`'s own explicit fields (color/renderer/displayLabel/legendLabel/placementBehavior)
2. the central default (per field — a component overriding only `color` still gets every other
   value from the central default)
3. the central resolver's own "?" fallback for a genuinely unknown category/label

`componentConfig.enabled === false` is a stronger, explicit suppression: it forces
`placementBehavior: "none"` regardless of what any other field says — used to hide a component as
a technical marker without touching any already-stored placement (this function has no placement
parameter and returns no placement data; it is structurally incapable of touching
`TechnicalServicePlacement`). Calling with no config (or `{}`) returns byte-identical output to
calling the central resolver directly — this is the app's real, current behavior for every
existing component today, none of which have this config set.

**Not yet wired in**: `resolveTechnicalRasterPresentation` is only called from the component admin
card's own preview and its tests — the real placement/render/export pipeline
(`TechnicalRasterCanvas.tsx`, `lib/technicalRasterVectorPdf.ts`) still calls
`resolveTechnicalServicePresentation` directly. Wiring a real component→service link in is future
work — see "Deliberately not done yet" below.

## Work queue

`domain/technicalRasterWorkQueue.ts` derives everything from live data — nothing is stored:

- `groupStandsByPlacementWorkQueue(matchedStands)` splits already-matched stands into `toPlace`
  (≥1 point service missing a placement), `done` (every point service fully placed), and
  `noPointServices` (no point services at all — never counted as either "to place" or "done").
- "Hotovo" only ever depends on `placementBehavior === "point"` services; `informational`/`none`
  services (including a `quantity: 40` cleaning row) never block or count toward completeness.
- Removing a placement elsewhere is picked up automatically — the grouping is recomputed fresh
  every render, so there is no separate "un-complete" action to call.
- **Auto-advance** (`resolveNextPlacementTarget`): after placing one point of a multi-quantity
  service, stays targeting the same service; once that service is fully placed, targets the
  stand's next missing point service; once the whole stand is done, stops. A "move" (Přemístit)
  never triggers auto-advance — it is a single, self-contained correction.

## PDF export — TRUE VECTOR

`lib/technicalRasterVectorPdf.ts` builds the export PDF with **zero rasterization** of the source
raster:

1. `resolveSourcePageGeometry` — reads the source page's rotation-aware `displayWidth/Height` and
   `viewportTransform` via `pdfjs-dist/legacy/build/pdf.mjs` (a read-only measurement, never a
   render call — deliberately NOT this app's usual `lib/pdf/pdfDocumentLoader.ts` wrapper, whose
   worker-file URL only resolves correctly under webpack/Next's own bundler, not plain Node —
   using the "legacy" pdf.js build keeps this whole pipeline directly unit-testable).
2. `PDFDocument.load` (pdf-lib) + `copyPages` — copies the source page's content
   stream/resources/MediaBox/rotation into the new document, verified end-to-end against the real
   `_IMPORT/Hala 1.pdf` fixture: the copied+saved+re-parsed page still has its original 270+ real
   text items and 22,000+ real vector/text content-stream operators, zero image XObjects (the
   source was never a raster to begin with).
3. `reconstructOcProperties` — `copyPages` does NOT automatically carry over the document
   catalog's `/OCProperties` (what makes Optional Content Groups toggle in a viewer's layers
   panel); this function re-registers it by matching OCG names against the objects `copyPages`
   already copied into the page's own `/Resources/Properties`. Verified to restore all 12 of Hala
   1.pdf's real OCG names, in original order, with the original default ON/OFF state. Never
   blocks the export if reconstruction is partial/impossible — always honestly reports
   `sourceOcgCount`/`reconstructedOcgCount`/`unmatchedOcgNames`.
4. Technical symbols are drawn directly onto the copied page as real pdf-lib vector/text
   primitives (`drawCircle`/`drawText`/`drawSvgPath`/`drawLine`), at raw PDF coordinates computed
   by inverting the SAME `viewportTransform` from step 1 (`domain/technicalRasterExportPlacementGeometry.ts`
   — a plain, textbook affine-matrix inversion, correct for any rotation because it defers to
   pdf.js's own already-trusted forward transform rather than re-deriving PDF rotation matrices
   by hand). No new Optional Content Group is created for the overlay (see "not yet done" below)
   — it is plain, always-visible vector content that never touches or risks the source OCGs.
5. A legend (small header line + used-symbol-types-only swatches) is drawn on a **separate page
   2** — chosen over extending page 1's own MediaBox specifically because it requires zero
   structural changes to the copied page.
6. `newDoc.save()` — the source bytes passed in are never mutated; every export is a brand-new,
   in-memory `Uint8Array`.

Symbol renderers: `powerLabel`/`textLabel`/`fallback` draw a colored circle + centered short text
(the SAME embedded `NotoSansCzech` font this app already uses for jsPDF documents, via
`@pdf-lib/fontkit`); `refrigeratedStar` draws the circle + a real ASCII `"*"` glyph (never a
Unicode `✱`, which the font subset isn't guaranteed to include); `waterDrop` draws a real vector
teardrop via `drawSvgPath`, the same path the editor's own on-screen SVG symbol uses.

## Multi-page, geometry, and export-limit invariants

Verified directly (spec batch 13 hardening pass — `tests/technicalRasterVectorPdfHardening.test.ts`,
32 tests) rather than assumed:

- **Page indexing is consistently 1-based** everywhere in the app's own domain layer
  (`RasterStandLabel.page`, `StandPlacement.rasterPage`, `TechnicalServicePlacement.page`,
  `activePage` UI state) — the ONLY 0-based boundary is the single, already-documented
  `input.page - 1` conversion at the pdf-lib `copyPages` call site.
- **An out-of-range export page fails fast and atomically** — `resolveSourcePageGeometry` checks
  `page` against `document.numPages` and throws a typed `TechnicalRasterVectorExportError`
  (`code: "INVALID_PAGE"`) BEFORE any PDF writing begins; a failed export never returns a
  partial/corrupt byte array.
- **Invalid normalized coordinates are skipped, never clamped, never crash the export.** A
  placement whose `xNormalized`/`yNormalized` is outside `[0,1]` or non-finite (NaN/Infinity) is
  silently excluded from drawing and counted in the result's `skippedInvalidPlacementCount` — a
  clamp was deliberately rejected as an option (it would draw a symbol at a plausible-looking but
  wrong position).
- **Non-zero MediaBox origins and MediaBox-larger-than-CropBox pages both work correctly**,
  including combined with 90°-rotation — verified against real pdf.js viewport transforms, not a
  hand-derived assumption; the page's own CropBox is preserved unchanged by the export (never
  widened/narrowed to match MediaBox).
- **OCG reconstruction is correctly scoped per exported page** in a multi-page source PDF — an OCG
  used only on a different page is reported as unmatched, never fabricated.
- **OCG name collisions** (two distinct OCG objects sharing the same display name) are a known,
  documented limitation of the current name-based matching — never a crash, never silently drops
  every group, but cannot distinguish which of the two colliding source groups a given
  reconstructed group "really" corresponds to.
- **Benchmarked at 500 and 1000 placements** in one export — completes well under 10s, output
  stays proportional (never a multi-MB jump that would indicate a hidden rasterization).
- **20 consecutive exports of the same source never accumulate state** — no growing/duplicate OCG
  registrations between independent calls.

## OCG handling summary

Source OCG existence, names, order, and default ON/OFF state are reconstructed at the catalog
level on a best-effort basis; content itself (all layers, always) survives unconditionally
regardless of whether reconstruction succeeds, since `copyPages` preserves the page's own content
stream/resources either way — reconstruction only affects whether a PDF viewer's OWN layers panel
recognizes them as toggleable groups.

## White mode ("Pracovní — bílé")

Entirely a **live editor preview** concern (`lib/pdf/technicalRasterWhiteRender.ts`), unrelated to
the vector export: a `Proxy` over `CanvasRenderingContext2D` forces only the fill color of
specific, pre-analyzed operator indices to white (at a configurable opacity, "Krytí bílé"),
leaving stroke/geometry/dash/line-width completely untouched. **The vector PDF export does not
support this mode** — see "Deliberately not done yet" below; the export UI shows "Originální
barvy" as the only available option, with an honest explanation, never a silent raster fallback.

## Component "Technické rastry" config + icon assets

A collapsible section on the catalog component admin card (`components/workflow/ComponentAdminPage.tsx`)
lets a component explicitly override `enabled` / `placementBehavior` / a simplified `renderer`
choice ("Automatická"/"Text") / `displayLabel` / `color` / `legendLabel` / `iconAsset`. Stored as
`document.technicalRaster` on the existing `catalog_items.document` JSONB column (`domain/catalogItemsAdmin.ts`)
— no DB migration needed, same whole-value-replace discipline as `photoAsset`/`modelAsset`.
"Obnovit výchozí nastavení" removes the key entirely (never leaves a stray `{}`). Every field is
independently whitelisted/validated server-side (`parseCatalogItemAdminEdit`) — invalid
`placementBehavior`/`renderer` values, non-hex colors, HTML-containing labels, and malformed asset
references are all silently dropped, never partially trusted.

Icon uploads use a dedicated `AssetCategory` (`"catalog-technical-icon"`, `domain/assets.ts`),
restricted to `image/svg+xml` and `image/png` only, 2 MB ceiling. Preview/display always goes
through the SAME `<img src={resolvedUrl}>` pattern every other asset in this app already uses —
browsers never execute scripts embedded in an SVG loaded via `<img>`, so this needed no new
sanitizer. Only the stable `StoredAsset` (with its `storageKey`) is ever persisted — a resolved
signed download URL is always a separate, later, read-time-only lookup, never stored.

## R2 / asset URL lifecycle

Every `StoredAsset` reference persisted anywhere in this app (`photoAsset`, `modelAsset`,
`sourceRasterAsset`, `technicalRaster.iconAsset`, ...) carries only a stable `storageKey` — never
a URL. A real, time-limited download URL is resolved on demand via `getAssetDownloadUrl(storageKey)`
(`hooks/useAssetUrl.ts`), re-resolved per page load, never cached into persisted state.

## `_IMPORT/` real diagnostics

`_IMPORT/` is a local-only, gitignored workspace for real customer fixture files. Two skip-safe
scripts exist and are never required by `npm test`/`npm run build`:

- `npm run test:technical-raster-real` (`scripts/technicalRasterRealDiagnostic.ts`) — the full
  raster + 4-report import/matching pipeline against real fixtures.
- `npm run test:technical-raster-vector-export-real` (`scripts/technicalRasterVectorExportRealDiagnostic.ts`)
  — runs the actual production vector export pipeline against a real fixture and reports
  vectorness/OCG facts (image XObject count, operator count, OCG reconstruction results, text
  selectability). Writes its output PDF into the gitignored `_IMPORT/` for manual inspection.

Both exit 0 with a clear "fixtures not found, skipping" message when `_IMPORT/` (or the specific
files they need) are absent — verified by temporarily removing `_IMPORT/` entirely and confirming
`npm test`/`npm run build` both still pass unaffected.

## Deliberately not done yet

- **Custom component icon is not wired into the editor canvas or the vector PDF export renderer**
  — it is uploaded, stored, and previewed on the admin card only. Drawing it live would need a new,
  generic `renderer` kind (e.g. `"icon"`) touched through both the editor's SVG rendering and
  `lib/technicalRasterVectorPdf.ts`'s drawing code — a deliberate, separately-scoped next step.
- **Vector "Pracovní — bílé" export IS now supported** (corrective batch section 4) — see
  "Vector white mode export" below. The paragraph above described the pre-batch state; kept only
  for history.
- **The "5. Stavby - tisk vše katalog" supplemental-source PDF has no real text parser yet.** The
  RECONCILIATION ENGINE it would feed (`domain/technicalRasterReconciliation.ts` — canonical
  service identity, SHODA/only-report/only-catalog/quantity-mismatch/conflict, and
  `domain/technicalRasterRealization.ts` for "R:" grouping) is implemented and fully tested against
  synthetic mentions. The actual PDF-TEXT parser that would produce those mentions from a real
  export is not implemented, for the same reason every other parser in
  `domain/technicalReportParsers/*` was only ever built against a real fixture file: no real sample
  of this specific catalog PDF was available this batch. Until a real file is provided,
  `TechnicalStand.realizationCompany` can only be set manually (a plain text field on
  `TechnicalStandDetailPanel`, see `setStandRealizationCompany`).
- **The legend's "source-legend-area" placement has no interactive region-picker UI yet.**
  `domain/technicalRasterLegendPlacement.ts` + the export drawing code
  (`lib/technicalRasterVectorPdf.ts`'s `drawInPlaceLegend`) are implemented and tested — passing an
  explicit `TechnicalLegendSourceRegion` already draws the legend directly over that rectangle on
  the named source page, vector, no page resize. What's missing is a way for a user to DEFINE that
  rectangle by hand in the editor (e.g. click-drag on the canvas) — `resolveEffectiveLegendPlacement`
  safely falls back to today's "separate-page" behavior whenever no region is configured, so this
  gap is never a silent/broken export, only a missing convenience.
- **No automatic product/Lxx catalog mapping.** `domain/technicalServiceProductMapping.ts`'s
  mapping table is deliberately empty; every real service currently resolves
  `status: "unresolved_product"` ("Neznámý produkt") until a human explicitly verifies and adds a
  real mapping entry. A label is never guessed onto a catalog code by name similarity.
  `TechnicalService.internalProductId`/`internalProductCode` are the only link that exists today,
  and it is optional/usually unset.
  - New `component technicalRaster` overrides are a completely separate, additive layer — they
    resolve presentation only, never a product/price mapping.
- **Arbitrary SVG is not parsed/rasterized for PDF export.** An uploaded SVG icon is stored and
  previewed as-is; pdf-lib has no general SVG-to-vector-path converter, so exporting an arbitrary
  uploaded SVG (masks/filters/gradients/external refs) is unimplemented — a PNG icon, by contrast,
  can already be embedded as a small image XObject (pdf-lib supports this natively), never
  affecting the vector-ness of the underlying raster page itself.
- **Pricing is not part of Technické rastry**, anywhere — not in the central presentation config,
  not in the component override, not in the export. A component's own pricing data (used
  elsewhere in the app) is never read by this module.

## Real-data facts (general, non-sensitive)

Real diagnostics exist via a local, gitignored `_IMPORT/` fixture set (a hall floor plan PDF +
four category report PDFs) — never committed, never required for the standard test/build
pipeline. Structural facts observed from that fixture set (report counts, OCG counts, matching
outcomes) are used as regression baselines inside the skip-safe diagnostic scripts; no specific
exhibitor names, notes, or report contents are reproduced here or in test fixtures — every
committed test uses synthetic data built directly with this app's own libraries (pdf-lib/jsPDF),
never a real customer document.
