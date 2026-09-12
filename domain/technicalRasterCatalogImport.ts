/**
 * Technické rastry — corrective batch (post real-file acceptance test) section 7/8/9: a parser for
 * the SUPPLEMENTAL/CONTROL source "5. Stavby - tisk vše katalog" — a real customer export, verified
 * against the actual fixture `_IMPORT/realizacky.pdf` (never a guessed/invented layout, per this
 * batch's own explicit instruction). This is a genuinely different report LAYOUT from the primary
 * technical reports (domain/technicalReportParsers/* — a wide table with one column per service
 * type): this catalog is a vertical "one block per stand" report, so it gets its OWN parser here
 * rather than being forced into `parseGenericStandTable`'s table-column model. It reuses that same
 * module's `PdfTextItem`/`groupTextItemsIntoRows` — the shared, already-tested "reconstruct rows
 * from positioned PDF text" primitive — rather than re-deriving row grouping a second time.
 *
 * Real layout, verified directly against the fixture (see the batch report for the actual dumped
 * text/coordinates):
 *
 *   [column-header row, repeats on every page] "Stánek" / "Číslo dokladu" / "Externí číslo"
 *   [[a blank divider row]]
 *   <standNumber>              <documentNumber>                     <- HEADER row (x≈28 / x≈116)
 *   <companyName>  <tradeName>              R: <realizationCompany> <- COMPANY row (always the very
 *                                                                       next row after HEADER)
 *   Šířka: ... Hloubka: ... Stavba od ABF: ...                      <- dimensions, skipped
 *   PLOCHA ...                              <area>  m2              <- area summary, skipped
 *   <item label>                                       <qty> <unit> <- ITEM row (x≈28 / anywhere)
 *     <note text, indented>                                         <- NOTE row (x≈45, single token)
 *   ... more ITEM/NOTE rows ...
 *   [page break — the NEXT stand's own item rows may continue with NO new HEADER row at all,
 *    interrupted only by the repeated column-header row above, which is skipped as noise]
 *   <next standNumber>         <next documentNumber>                <- next HEADER row
 *   ...
 *   Výtisk sestavil(a) ... dne ... strana ...                       <- page footer, skipped
 *
 * A HEADER row is detected by its OWN most distinctive, position-independent signal — a token
 * shaped like this customer's real document-number format (e.g. "V229-5/2026") sitting in the
 * document-number column — NOT by assuming a stand number is always present: the real fixture
 * contains at least one stand whose OWN number is genuinely blank in the source (verified directly,
 * not a hypothetical) — that stand is still captured (company/R:/items), just with `standNumber:
 * undefined`, and a warning explaining why, never a fabricated number.
 */
import { groupTextItemsIntoRows, type PdfTextItem, type PdfTextRow } from "./technicalReportTableParsing.ts";
import type { TechnicalReconciliationMention } from "./technicalRasterReconciliation.ts";

// ============================================================================
// Row-shape constants — calibrated against the real fixture's own column positions. A small
// tolerance band around each, never an exact-pixel match (a different print/export run of the same
// report type could shift a point or two).
// ============================================================================

const LEFT_COLUMN_X_RANGE: readonly [number, number] = [18, 38];
const DOCUMENT_NUMBER_X_RANGE: readonly [number, number] = [105, 128];
const NOTE_COLUMN_X_RANGE: readonly [number, number] = [38, 55];
/** This customer's real document-number shape (e.g. "V229-5/2026", "V229-21/2026") — a letter prefix, digits, a dash, more digits, a slash, a 4-digit year. */
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z]?\d+-\d+\/\d{4}$/u;
const QUANTITY_UNIT_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(.+)$/u;

function inRange(x: number, range: readonly [number, number]): boolean {
  return x >= range[0] && x <= range[1];
}

// ============================================================================
// Parsed shape — a richer, DEDICATED model (never reusing ParsedTechnicalReport, which is shaped
// for the primary reports' own per-category quantity columns — this source has its own distinct
// fields: documentNumber, tradeName, realizationCompanyRaw, arbitrary catalog item rows).
// ============================================================================

export type CatalogItemRow = Readonly<{
  /** Verbatim item label text — NEVER discarded/normalized here (spec: "raw source text"). */
  label: string;
  quantity: number;
  unit: string;
  /** The verbatim "<N> <unit>" token exactly as printed (e.g. "1,0 ks", "9,0 bm") — kept alongside the parsed quantity/unit for full traceability. */
  rawQuantityText: string;
  /** Note lines immediately following this item (spec: "poznámkové řádky mezi položkami" — attached to the item they follow, never treated as items themselves). */
  notes: readonly string[];
  page: number;
}>;

export type ParsedCatalogStand = Readonly<{
  /** Undefined ONLY when the source itself has no stand number for this block (a real, verified case in the fixture) — never fabricated. */
  standNumber?: string;
  documentNumber?: string;
  companyName?: string;
  /** A second name column the source prints alongside the company name — in every real sample seen so far it repeats the same company name, but the report clearly reserves a separate column for it (a genuine trade/catalog name), so it is kept distinct rather than assumed identical. */
  tradeName?: string;
  /** Raw text after the "R:" prefix, exactly as printed (e.g. "CREATIV EXPO, s.r.o.") — undefined when the stand's own "R:" line is entirely absent. Canonical grouping is ALWAYS resolved later via domain/technicalRasterRealization.ts's resolveTechnicalRealizationGroup, never re-implemented here. */
  realizationCompanyRaw?: string;
  items: readonly CatalogItemRow[];
  /** The page the stand's own HEADER row started on. */
  page: number;
}>;

export type ParsedCatalogImportWarning = Readonly<{ message: string; page?: number; rawText?: string }>;

export type ParsedCatalogImport = Readonly<{
  stands: readonly ParsedCatalogStand[];
  warnings: readonly ParsedCatalogImportWarning[];
}>;

// ============================================================================
// Row classification
// ============================================================================

type ClassifiedRow =
  | Readonly<{ kind: "header"; standNumber?: string; documentNumber: string; page: number }>
  | Readonly<{ kind: "columnHeader" }>
  | Readonly<{ kind: "footer" }>
  | Readonly<{ kind: "dimensions" }>
  | Readonly<{ kind: "area" }>
  | Readonly<{ kind: "preamble" }>
  | Readonly<{ kind: "company"; companyName?: string; tradeName?: string; realizationCompanyRaw?: string }>
  | Readonly<{ kind: "note"; text: string }>
  | Readonly<{ kind: "item"; label: string; rawQuantityText: string; page: number }>
  | Readonly<{ kind: "unrecognized"; text: string; page: number }>;

/**
 * CORRECTIVE BATCH (3rd) section 15 — known document header/footer metadata this real report
 * prints on every page (verified directly against the fixture), never a finding worth surfacing as
 * a warning: the print title, the printing company's own name, the selection-criteria caption, the
 * job/zakázka reference, and the two "ANO/NE" document-level flags. Matched by stable PREFIX (their
 * own values after the colon vary per export run) — never by an exact full-row match, which a
 * genuinely different real export could silently miss.
 */
const KNOWN_DOCUMENT_METADATA_PREFIXES = ["5. Stavby - tisk vše katalog", "Firma:", "Výběrové podmínky", "Zakázka:", "Stavba od ABF:", "Včetně revizí:"];

function isKnownDocumentMetadataRow(text: string): boolean {
  return KNOWN_DOCUMENT_METADATA_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function classifyRow(row: PdfTextRow): ClassifiedRow {
  const items = row.items; // groupTextItemsIntoRows already drops blank/whitespace-only tokens.
  const documentNumberItem = items.find((item) => inRange(item.x, DOCUMENT_NUMBER_X_RANGE) && DOCUMENT_NUMBER_PATTERN.test(item.str.trim()));
  if (documentNumberItem) {
    const standNumberItem = items.find((item) => inRange(item.x, LEFT_COLUMN_X_RANGE));
    return { kind: "header", standNumber: standNumberItem?.str.trim(), documentNumber: documentNumberItem.str.trim(), page: row.page };
  }
  if (items.some((item) => item.str.trim() === "Stánek")) return { kind: "columnHeader" };
  if (items[0]?.str.trim().startsWith("Výtisk sestavil")) return { kind: "footer" };
  if (items[0]?.str.trim().startsWith("Šířka:")) return { kind: "dimensions" };
  if (items[0]?.str.trim().toUpperCase().startsWith("PLOCHA")) return { kind: "area" };
  const text = items.map((item) => item.str.trim()).join(" ").trim();
  // Checked BEFORE the "item" shape heuristic below: several of these known metadata lines (e.g.
  // "Výběrové podmínky pro sestavení tisku") happen to have exactly two tokens starting inside the
  // same left-column x-range a real item label uses, which previously misclassified them as an
  // "item row found outside a stand block" and produced a spurious warning.
  if (isKnownDocumentMetadataRow(text)) return { kind: "preamble" };
  if (items.length === 1 && inRange(items[0]!.x, NOTE_COLUMN_X_RANGE)) return { kind: "note", text: items[0]!.str.trim() };
  if (items.length >= 2 && inRange(items[0]!.x, LEFT_COLUMN_X_RANGE)) {
    return { kind: "item", label: items[0]!.str.trim(), rawQuantityText: items[items.length - 1]!.str.trim(), page: row.page };
  }
  return { kind: "unrecognized", text, page: row.page };
}

/** A "company" row is identified STRUCTURALLY (always the row immediately after a HEADER row — verified against every stand in the real fixture), never by its own content shape, since a company/trade name can be almost any text. Called only when the walker already knows it's expecting one. */
function parseCompanyRow(row: PdfTextRow): Extract<ClassifiedRow, { kind: "company" }> {
  const items = row.items;
  const realizationItem = items.find((item) => /^r\s*:/iu.test(item.str.trim()));
  const realizationCompanyRaw = realizationItem ? realizationItem.str.trim().replace(/^r\s*:\s*/iu, "").trim() || undefined : undefined;
  const remaining = items.filter((item) => item !== realizationItem);
  const companyName = remaining[0]?.str.trim() || undefined;
  const tradeName = remaining[1]?.str.trim() || undefined;
  return { kind: "company", companyName, tradeName, realizationCompanyRaw };
}

// ============================================================================
// Orchestration — a small explicit state machine, never a single monolithic regex over the whole
// document (spec: "Parser musí bezpečně rozlišit: produktovou/service row, poznámku, nový stánek,
// pokračování předchozího stánku").
// ============================================================================

export function parseSupplementalCatalogPdf(items: readonly PdfTextItem[]): ParsedCatalogImport {
  const rows = groupTextItemsIntoRows(items);
  const stands: ParsedCatalogStand[] = [];
  const warnings: ParsedCatalogImportWarning[] = [];

  let current: { standNumber?: string; documentNumber?: string; companyName?: string; tradeName?: string; realizationCompanyRaw?: string; items: CatalogItemRow[]; page: number } | undefined;
  let expectingCompanyRow = false;

  function flushCurrent(): void {
    if (!current) return;
    stands.push({
      standNumber: current.standNumber,
      documentNumber: current.documentNumber,
      companyName: current.companyName,
      tradeName: current.tradeName,
      realizationCompanyRaw: current.realizationCompanyRaw,
      items: current.items,
      page: current.page,
    });
    current = undefined;
  }

  for (const row of rows) {
    if (expectingCompanyRow) {
      const company = parseCompanyRow(row);
      if (current) {
        current.companyName = company.companyName;
        current.tradeName = company.tradeName;
        current.realizationCompanyRaw = company.realizationCompanyRaw;
      }
      expectingCompanyRow = false;
      continue;
    }

    const classified = classifyRow(row);
    switch (classified.kind) {
      case "header": {
        flushCurrent();
        if (!classified.standNumber) {
          warnings.push({
            message: `Stánek s dokladem "${classified.documentNumber}" nemá v katalogu uvedené číslo stánku — záznam byl zachycen, ale nelze jej spárovat se stánkem (chybí spojovací klíč).`,
            page: classified.page,
          });
        }
        current = { standNumber: classified.standNumber, documentNumber: classified.documentNumber, items: [], page: classified.page };
        expectingCompanyRow = true;
        break;
      }
      case "item": {
        if (!current) {
          warnings.push({ message: `Položka "${classified.label}" nalezena mimo blok stánku — byla ignorována.`, page: classified.page, rawText: classified.label });
          break;
        }
        const match = QUANTITY_UNIT_PATTERN.exec(classified.rawQuantityText);
        const quantity = match ? Number(match[1]!.replace(",", ".")) : Number.NaN;
        const unit = match ? match[2]!.trim() : classified.rawQuantityText;
        if (!Number.isFinite(quantity)) {
          warnings.push({
            message: `Položka "${classified.label}" u stánku ${current.standNumber ?? "(bez čísla)"} má nerozpoznané množství "${classified.rawQuantityText}" — položka byla zachycena s množstvím 0.`,
            page: classified.page,
            rawText: classified.rawQuantityText,
          });
        }
        current.items.push({
          label: classified.label,
          quantity: Number.isFinite(quantity) ? quantity : 0,
          unit,
          rawQuantityText: classified.rawQuantityText,
          notes: [],
          page: classified.page,
        });
        break;
      }
      case "note": {
        if (current && current.items.length > 0) {
          const lastItem = current.items[current.items.length - 1]!;
          current.items[current.items.length - 1] = { ...lastItem, notes: [...lastItem.notes, classified.text] };
        }
        // A note with no preceding item in the current stand is silently dropped (spec: notes are
        // metadata on an item, never a finding worth surfacing on their own) — mirrors this app's
        // own primary-report parsers' discipline of never inventing an item to hang a note on.
        break;
      }
      case "columnHeader":
      case "footer":
      case "dimensions":
      case "area":
      case "preamble":
        break;
      case "unrecognized": {
        if (classified.text) warnings.push({ message: `Neočekávaný řádek v katalogu, ignorován: "${classified.text}"`, page: classified.page, rawText: classified.text });
        break;
      }
      default:
        break;
    }
  }
  flushCurrent();

  return { stands, warnings };
}

// ============================================================================
// Reconciliation bridge (corrective batch section 10) — extracts the SUBSET of a stand's catalog
// items that map to a known technical-service category, in the EXACT shape
// domain/technicalRasterReconciliation.ts's reconcileTechnicalReportAndCatalog expects. Never a
// second classification system: category detection here is deliberately narrow/conservative
// (matches only real observed catalog label PREFIXES — this source's own labels are sometimes
// column-width-TRUNCATED, e.g. "ELEKTRICKÁ ENERGIE - NOČNÍ PROUD (LEDNI" cuts off mid-word, so
// matching is done on the stable PREFIX only, never on text that might be truncated away).
// ============================================================================

const NEGATION_PREFIX_PATTERN = /^bez\s+/iu;

/**
 * Deliberately STEM-based, never an exact-prefix match on one specific grammatical case: Czech
 * declines "elektrická energie" (nominative, the normal positive label) to "elektrické energie"
 * (genitive) after "bez" ("bez elektrické energie" — verified directly against the real fixture's
 * own "BEZ ELEKTRICKÉ ENERGIE" negation row). Matching the shared stem "elektrick...energi" instead
 * of one exact spelling means a negated row is correctly recognized as the SAME category it negates
 * without a separate, parallel per-case pattern list.
 */
function classifyCatalogItemCategory(label: string): string | undefined {
  const text = NEGATION_PREFIX_PATTERN.test(label) ? label.replace(NEGATION_PREFIX_PATTERN, "") : label;
  // Deliberately NO \w/\b — JavaScript's \w and \b are both defined against ASCII word characters
  // only, so BOTH silently fail on Czech diacritic letters (verified directly against the real
  // fixture, twice: a \b before "Ú" in "ÚKLID" never matches, and \w* stops dead right before the
  // "É" in the genitive "ELEKTRICKÉ" — the exact ending Czech grammar requires after "bez", e.g.
  // this fixture's own real "BEZ ELEKTRICKÉ ENERGIE" negation row). `\p{L}` (a Unicode "any letter"
  // property escape, available since this file already uses the `u` flag) is used instead wherever
  // a variable Czech word-ending needs to be consumed, so a grammatical case change can never
  // silently break category detection again. Plain substring matching (no boundaries) elsewhere is
  // the same discipline domain/technicalRasterServicePresentation.ts's own patterns already use
  // (e.g. WIFI_PATTERN, FIXED_IP_PATTERN).
  if (/elektrick\p{L}*\s+energi/iu.test(text) || /\d+\s*kw/iu.test(text)) return "electricity";
  if (/internet/iu.test(text)) return "internet";
  if (/(^|[^\p{L}])vod[aouy]([^\p{L}]|$)|přívod\s+vody/iu.test(text)) return "water";
  if (/kontejn|odvoz\s+odpadu|vana\s*\d/iu.test(text)) return "waste";
  if (/úklid/iu.test(text)) return "cleaning";
  return undefined;
}

/**
 * Every technical-service mention in ONE stand's own catalog items, ready to feed directly into
 * `reconcileTechnicalReportAndCatalog` alongside the primary report's own mentions. A stand with no
 * `standNumber` (the real fixture's own blank-stand-number case) produces NO mentions at all — it
 * genuinely cannot be reconciled without a join key; the caller already has a warning for this from
 * `parseSupplementalCatalogPdf` itself.
 */
export function extractTechnicalMentionsFromCatalogStand(stand: ParsedCatalogStand): readonly TechnicalReconciliationMention[] {
  if (!stand.standNumber) return [];
  const mentions: TechnicalReconciliationMention[] = [];
  for (const item of stand.items) {
    const negated = NEGATION_PREFIX_PATTERN.test(item.label);
    const category = classifyCatalogItemCategory(item.label);
    if (!category) continue;
    mentions.push({ standNumber: stand.standNumber, category, externalLabel: item.label, quantity: item.quantity, negated: negated || undefined });
  }
  return mentions;
}
