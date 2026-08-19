import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenericVariants,
  documentHasVariants,
  P86_INTERNAL_CODE,
  P87_CANONICAL,
  P87_INTERNAL_CODE,
  planAllTypeBoothLines,
  planP86,
  planP87,
  planTypeBoothCatalog,
  planTypeBoothLine,
  T04_CONFIRMED_VARIANTS,
  TYPE_BOOTH_LINE_CODES,
  TYPE_BOOTH_VARIANT_COUNT,
  typeBoothLineDescription,
  typeBoothLineSpec,
  type ExistingCatalogItemRow,
} from "../domain/typeBoothCanonicalization.ts";

function row(overrides: Partial<ExistingCatalogItemRow> = {}): ExistingCatalogItemRow {
  return {
    id: "row-uuid",
    internalCode: null,
    kind: "booth",
    lifecycleStatus: "needs_review",
    displayName: "",
    category: null,
    document: {},
    ...overrides,
  };
}

const P86_ROW = row({
  id: "p86-uuid",
  internalCode: "P86",
  kind: "booth",
  lifecycleStatus: "active",
  displayName: "Kóje 2 × 2 m (P86)",
  category: "Canonical",
  document: { internalCode: "P86", parts: [], printSurfaces: [{ id: "fascia-print" }], pricingEntries: [{ id: "p86-base-czk", currency: "CZK", salePrice: 3640 }] },
});

function t04Row(overrides: Partial<ExistingCatalogItemRow> = {}): ExistingCatalogItemRow {
  return row({
    id: "t04-uuid",
    internalCode: "T04",
    kind: "booth",
    lifecycleStatus: "needs_review",
    displayName: "Typový stánek octanorm - T4",
    category: "Typovky",
    document: {
      internalCode: "T04",
      displayName: "Typový stánek octanorm - T4",
      widthMm: 2000,
      depthMm: 2000,
      sourceSystem: "excel-v6.6",
      sourceKey: "pricelist::typovky::typovy-stanek-octanorm---t4",
      pricingEntries: [{ id: "batch2b-T04-base-czk", currency: "CZK", salePrice: 4400 }],
    },
    ...overrides,
  });
}

// =========================================================================================
// IDENTITY — every real code stays unique, no accidental collisions.
// =========================================================================================

test("all target codes (P86, P87, Txx) are pairwise distinct", () => {
  const all = [P86_INTERNAL_CODE, P87_INTERNAL_CODE, ...TYPE_BOOTH_LINE_CODES];
  assert.equal(new Set(all).size, all.length);
});

test("TYPE_BOOTH_LINE_CODES matches exactly the 10 real Txx lines from the session brief — no invented/missing code", () => {
  assert.deepEqual([...TYPE_BOOTH_LINE_CODES].sort(), ["T04", "T06", "T09", "T12", "T15", "T16", "T18", "T20", "T24", "T25"].sort());
});

// =========================================================================================
// P86 — never touched, never duplicated.
// =========================================================================================

test("planP86: existing P86 row -> noop, never recreated or altered", () => {
  const plan = planP86([P86_ROW]);
  assert.equal(plan.action, "noop");
  assert.equal(plan.internalCode, "P86");
});

test("planP86: absent P86 -> still noop (this migration NEVER creates a P86)", () => {
  const plan = planP86([]);
  assert.equal(plan.action, "noop");
});

// =========================================================================================
// P87 — create only if truly absent, idempotent, no invented data.
// =========================================================================================

test("planP87: absent -> create, with only the confirmed canonical fields, needs_review", () => {
  const plan = planP87([P86_ROW]);
  assert.equal(plan.action, "create");
  assert.ok(plan.insertRow);
  assert.equal(plan.insertRow!.internal_code, "P87");
  assert.equal(plan.insertRow!.kind, "booth");
  assert.equal(plan.insertRow!.lifecycle_status, "needs_review");
  assert.equal(plan.insertRow!.category, "Canonical");
  assert.equal(plan.insertRow!.document.widthMm, 2000);
  assert.equal(plan.insertRow!.document.depthMm, 3000);
});

test("planP87: no invented height, price, GLB, photo, or sourceAssets", () => {
  const plan = planP87([]);
  const doc = plan.insertRow!.document;
  assert.equal("heightMm" in doc, false);
  assert.equal("pricingEntries" in doc, false);
  assert.equal("modelUrl" in doc, false);
  assert.equal("modelAsset" in doc, false);
  assert.equal("photoAsset" in doc, false);
  assert.equal("sourceAssets" in doc, false);
  assert.equal("sourceSystem" in doc, false, "P87 is manually created — never a fake import provenance");
  assert.equal("sourceKey" in doc, false);
});

test("planP87: already exists -> noop, never a duplicate, regardless of which column carries the code", () => {
  const byColumn = planP87([row({ internalCode: "P87", id: "existing-1" })]);
  assert.equal(byColumn.action, "noop");

  const byDocumentOnly = planP87([row({ internalCode: null, document: { internalCode: "P87" }, id: "existing-2" })]);
  assert.equal(byDocumentOnly.action, "noop");
});

test("planP87: idempotent across two consecutive plans against the same DB snapshot", () => {
  const existing = [P86_ROW];
  const first = planP87(existing);
  assert.equal(first.action, "create");
  // Simulate the DB after applying `first`.
  const afterApply = [...existing, row({ id: "p87-uuid", internalCode: "P87", document: first.insertRow!.document })];
  const second = planP87(afterApply);
  assert.equal(second.action, "noop");
});

test("P87_CANONICAL constants match the session brief exactly", () => {
  assert.equal(P87_CANONICAL.displayName, "Kóje 2 × 3 m");
  assert.equal(P87_CANONICAL.widthMm, 2000);
  assert.equal(P87_CANONICAL.depthMm, 3000);
});

// =========================================================================================
// Txx — add variants only if missing, never create/delete the row, never touch kind/category/price.
// =========================================================================================

test("planTypeBoothLine: absent from DB -> noop (this migration never creates new Txx rows)", () => {
  const plan = planTypeBoothLine([], "T04");
  assert.equal(plan.action, "noop");
});

test("planTypeBoothLine: T04 has a CONFIRMED spec — exactly 3 semantic variants (roh vlevo/roh vpravo/řadová), never 4", () => {
  const spec = typeBoothLineSpec("T04");
  assert.equal(spec.confirmed, true);
  assert.equal(spec.variants.length, 3);
  assert.deepEqual(spec.variants.map((v) => v.id), ["t04-corner-left", "t04-corner-right", "t04-inline"]);
  assert.deepEqual(spec.variants, T04_CONFIRMED_VARIANTS);
});

test("planTypeBoothLine: T06..T25 have NO confirmed spec — generic 4-variant placeholder, confirmed=false (per session decision: keep 4 generic, mark unconfirmed)", () => {
  for (const code of TYPE_BOOTH_LINE_CODES.filter((c) => c !== "T04")) {
    const spec = typeBoothLineSpec(code);
    assert.equal(spec.confirmed, false, `${code} must stay unconfirmed`);
    assert.equal(spec.variants.length, TYPE_BOOTH_VARIANT_COUNT);
  }
});

test("planTypeBoothLine: existing T04 with the OLD 4-generic scaffold (from a prior session) -> update, REPLACED with the real 3-variant confirmed set", () => {
  const staleT04 = t04Row({ document: { ...t04Row().document, variants: buildGenericVariants("T04"), variantsConfirmed: false } });
  const plan = planTypeBoothLine([staleT04], "T04");
  assert.equal(plan.action, "update");
  assert.equal(plan.targetId, "t04-uuid");
  const variants = plan.documentPatch!.variants as readonly { id: string; name: string }[];
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((v) => v.id), ["t04-corner-left", "t04-corner-right", "t04-inline"]);
  assert.equal(plan.documentPatch!.variantsConfirmed, true);
});

test("planTypeBoothLine: existing T04 without any variants -> update, patch adds exactly the 3 confirmed variants + description + variantsConfirmed:true", () => {
  const plan = planTypeBoothLine([t04Row()], "T04");
  assert.equal(plan.action, "update");
  const variants = plan.documentPatch!.variants as readonly { id: string; name: string }[];
  assert.deepEqual(variants, T04_CONFIRMED_VARIANTS);
  assert.equal(plan.documentPatch!.variantsConfirmed, true);
  assert.equal(plan.documentPatch!.description, typeBoothLineDescription("T04", true));
});

test("planTypeBoothLine: T06 without variants -> update, 4 generic variants + variantsConfirmed:false + unconfirmed description", () => {
  const t06Row = t04Row({ id: "t06-uuid", internalCode: "T06", document: { ...t04Row().document, internalCode: "T06" } });
  const plan = planTypeBoothLine([t06Row], "T06");
  assert.equal(plan.action, "update");
  const variants = plan.documentPatch!.variants as readonly { id: string; name: string }[];
  assert.equal(variants.length, 4);
  assert.deepEqual(variants.map((v) => v.id), ["t06-v1", "t06-v2", "t06-v3", "t06-v4"]);
  assert.equal(plan.documentPatch!.variantsConfirmed, false);
  assert.equal(plan.documentPatch!.description, typeBoothLineDescription("T06", false));
});

test("planTypeBoothLine: the patch NEVER contains kind/category/lifecycleStatus/pricingEntries/sourceKey — only variants/variantsConfirmed(+description)", () => {
  const plan = planTypeBoothLine([t04Row()], "T04");
  const patchKeys = Object.keys(plan.documentPatch!);
  assert.deepEqual(new Set(patchKeys), new Set(["variants", "variantsConfirmed", "description"]));
});

test("planTypeBoothLine: variant ids are stable and deterministic across repeated calls (never array-index-only)", () => {
  const first = planTypeBoothLine([t04Row()], "T04");
  const second = planTypeBoothLine([t04Row()], "T04");
  assert.deepEqual(first.documentPatch!.variants, second.documentPatch!.variants);
});

test("planTypeBoothLine: variant ids for different lines never collide with each other", () => {
  const t04 = typeBoothLineSpec("T04").variants;
  const t06 = buildGenericVariants("T06");
  const allIds = [...t04, ...t06].map((v) => v.id);
  assert.equal(new Set(allIds).size, allIds.length);
});

test("planTypeBoothLine: T04 already matching the confirmed 3-variant spec (with variantsConfirmed:true) -> noop, idempotent (second run of the migration)", () => {
  const compliant = t04Row({ document: { ...t04Row().document, variants: T04_CONFIRMED_VARIANTS, variantsConfirmed: true } });
  const plan = planTypeBoothLine([compliant], "T04");
  assert.equal(plan.action, "noop");
});

test("planTypeBoothLine: T06 already matching its generic 4-variant spec (with variantsConfirmed:false) -> noop, idempotent", () => {
  const t06Compliant = t04Row({
    id: "t06-uuid",
    internalCode: "T06",
    document: { ...t04Row().document, internalCode: "T06", variants: buildGenericVariants("T06"), variantsConfirmed: false },
  });
  const plan = planTypeBoothLine([t06Compliant], "T06");
  assert.equal(plan.action, "noop");
});

test("planTypeBoothLine: T06 with variants set but MISSING the variantsConfirmed:false flag (last session's shape) -> still update, only to add the flag", () => {
  const t06Missing = t04Row({
    id: "t06-uuid",
    internalCode: "T06",
    document: { ...t04Row().document, internalCode: "T06", variants: buildGenericVariants("T06") },
  });
  const plan = planTypeBoothLine([t06Missing], "T06");
  assert.equal(plan.action, "update");
  assert.deepEqual(plan.documentPatch!.variants, buildGenericVariants("T06"), "variant ids unchanged — only the confirmed flag was missing");
  assert.equal(plan.documentPatch!.variantsConfirmed, false);
});

test("planTypeBoothLine: does not clobber a genuinely human-authored description (one that doesn't start with this module's auto-prefix)", () => {
  const withCustomDescription = t04Row({ document: { ...t04Row().document, description: "Ruční popis zadaný adminem." } });
  const plan = planTypeBoothLine([withCustomDescription], "T04");
  assert.equal(plan.action, "update", "variants still need correcting, so an update happens");
  assert.equal("description" in plan.documentPatch!, false, "existing human-edited description must survive untouched");
});

test("planTypeBoothLine: DOES upgrade its own previously auto-generated description (recognized by prefix) rather than leaving stale text behind", () => {
  const withOldAutoDescription = t04Row({ document: { ...t04Row().document, description: typeBoothLineDescription("T04", false) } });
  const plan = planTypeBoothLine([withOldAutoDescription], "T04");
  assert.equal(plan.action, "update");
  assert.equal(plan.documentPatch!.description, typeBoothLineDescription("T04", true));
});

test("planTypeBoothLine: existing row with kind !== booth is left alone (noop) — migration never silently reclassifies", () => {
  const plan = planTypeBoothLine([t04Row({ kind: "booth_component" })], "T04");
  assert.equal(plan.action, "noop");
});

test("planAllTypeBoothLines: covers exactly the 10 real Txx codes, in order", () => {
  const plan = planAllTypeBoothLines([]);
  assert.deepEqual(plan.map((p) => p.internalCode), [...TYPE_BOOTH_LINE_CODES]);
});

test("documentHasVariants: empty array (P86) and malformed entries never count as 'has variants'", () => {
  assert.equal(documentHasVariants({ variants: [] }), false);
  assert.equal(documentHasVariants({}), false);
  assert.equal(documentHasVariants({ variants: [{ id: "x" }] }), false, "missing name");
  assert.equal(documentHasVariants({ variants: [{ id: "x", name: "Varianta 1" }] }), true);
});

// =========================================================================================
// FULL CATALOG PLAN — matches the real live-audited DB shape (all 12 codes).
// =========================================================================================

test("planTypeBoothCatalog against the real live-audited snapshot: P86 noop, P87 create, all 10 Txx update", () => {
  const existing: readonly ExistingCatalogItemRow[] = [
    P86_ROW,
    ...TYPE_BOOTH_LINE_CODES.map((code) => t04Row({ id: `${code.toLowerCase()}-uuid`, internalCode: code, displayName: `Typový stánek octanorm - ${code}`, document: { ...t04Row().document, internalCode: code } })),
  ];
  const plan = planTypeBoothCatalog(existing);
  const byCode = new Map(plan.map((p) => [p.internalCode, p]));
  assert.equal(byCode.get("P86")!.action, "noop");
  assert.equal(byCode.get("P87")!.action, "create");
  for (const code of TYPE_BOOTH_LINE_CODES) {
    assert.equal(byCode.get(code)!.action, "update", `${code} should need a variants update`);
  }
  const t04Variants = byCode.get("T04")!.documentPatch!.variants as readonly { id: string }[];
  assert.equal(t04Variants.length, 3, "T04 gets its confirmed 3-variant set, not the generic 4");
  const t06Variants = byCode.get("T06")!.documentPatch!.variants as readonly { id: string }[];
  assert.equal(t06Variants.length, 4, "T06 stays on the generic unconfirmed 4-variant scaffold");
});

test("planTypeBoothCatalog is fully idempotent: applying the plan's effects and re-planning yields all noop", () => {
  const existing: readonly ExistingCatalogItemRow[] = [
    P86_ROW,
    ...TYPE_BOOTH_LINE_CODES.map((code) => t04Row({ id: `${code.toLowerCase()}-uuid`, internalCode: code, document: { ...t04Row().document, internalCode: code } })),
  ];
  const firstPlan = planTypeBoothCatalog(existing);

  // Simulate applying every create/update onto a fresh snapshot.
  const afterApply: ExistingCatalogItemRow[] = existing.map((existingRow) => {
    const entry = firstPlan.find((p) => p.targetId === existingRow.id);
    if (!entry || entry.action !== "update") return existingRow;
    return { ...existingRow, document: { ...existingRow.document, ...entry.documentPatch } };
  });
  const p87Entry = firstPlan.find((p) => p.internalCode === "P87")!;
  afterApply.push({ id: "p87-uuid", internalCode: "P87", kind: "booth", lifecycleStatus: "needs_review", displayName: p87Entry.insertRow!.display_name, category: p87Entry.insertRow!.category, document: p87Entry.insertRow!.document });

  const secondPlan = planTypeBoothCatalog(afterApply);
  for (const entry of secondPlan) {
    assert.equal(entry.action, "noop", `${entry.internalCode} should be noop on the second pass, got ${entry.action}: ${entry.reason}`);
  }
});
