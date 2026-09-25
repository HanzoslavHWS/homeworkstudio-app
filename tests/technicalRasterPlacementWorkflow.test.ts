import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assignStandManually,
  createTechnicalRasterProject,
  effectiveServicePlacements,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  requiredPlacementCount,
  type ParsedTechnicalReport,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
} from "../domain/technicalRaster.ts";
import {
  nextPlacementQueueStand,
  orderedPlacementQueue,
  resolvePlacementAdvance,
  resolveShortcutPlacementTarget,
  shouldContinuePlacementSession,
  type PlacementSessionKind,
  type PlacementSessionTarget,
} from "../domain/technicalRasterWorkQueue.ts";
import { isEditableShortcutTarget, resolvePlacementShortcut } from "../domain/technicalRasterPlacementShortcuts.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// Production-workflow batch, part B — fast placement: U / Escape shortcuts and the optional
// "Automaticky pokračovat v umisťování" mode. The editor delegates every decision to the pure
// helpers tested here (no DOM test library in this repo); source guards pin the editor wiring.
// =========================================================================================

type ServiceSpec = Readonly<{ category: string; externalLabel: string; quantity: number }>;

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}
function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}

/** Matched stands, each with its own services (one import per service so categories merge like real imports). Stand order in `specs` is intentionally NOT natural order where it matters. */
function buildProject(specs: Readonly<Record<string, readonly ServiceSpec[]>>, options: { unmatched?: readonly string[] } = {}): TechnicalRasterProject {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  let counter = 0;
  for (const [standNumber, services] of Object.entries(specs)) {
    for (const service of services) {
      counter += 1;
      const report: ParsedTechnicalReport = {
        category: service.category,
        rows: [{ standNumber, services: [{ ...service, rawValue: String(service.quantity), sourcePage: 1 }], notes: [] }],
        warnings: [],
      };
      project = mergeTechnicalRasterImport(project, makeImport(service.category, `imp-${counter}`), report, () => ({ status: "unresolved_product" as const }));
    }
  }
  for (const stand of project.stands) {
    if (options.unmatched?.includes(stand.standNumber)) continue;
    project = assignStandManually(project, stand.id, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  }
  return project;
}

function standId(project: TechnicalRasterProject, standNumber: string): string {
  return project.stands.find((stand) => stand.standNumber === standNumber)!.id;
}
function service(project: TechnicalRasterProject, standNumber: string, externalLabel: string): TechnicalService {
  return project.stands.find((stand) => stand.standNumber === standNumber)!.services.find((candidate) => candidate.externalLabel === externalLabel)!;
}
function describeTarget(project: TechnicalRasterProject, target: PlacementSessionTarget | undefined): string | undefined {
  if (!target) return undefined;
  const stand = project.stands.find((candidate) => candidate.id === target.standId)!;
  return `${stand.standNumber}:${stand.services.find((candidate) => candidate.id === target.serviceId)!.externalLabel}`;
}

/**
 * Mirrors TechnicalRasterEditorPage.handleCanvasClick exactly: place -> if the project reference is
 * unchanged, nothing was committed and the target stays -> otherwise resolvePlacementAdvance.
 */
function simulateClick(
  project: TechnicalRasterProject,
  target: PlacementSessionTarget,
  autoContinue: boolean,
  point = { page: 1, xNormalized: 0.3, yNormalized: 0.4 },
): Readonly<{ project: TechnicalRasterProject; target?: PlacementSessionTarget; selectStandId?: string; committed: boolean }> {
  const next = placeTechnicalService(project, target.standId, target.serviceId, point);
  if (next === project) return { project, target, committed: false };
  const advance = resolvePlacementAdvance(next.stands, target.standId, target.serviceId, autoContinue);
  return { project: next, target: advance.target, selectStandId: advance.selectStandId, committed: true };
}

const EL_2KW: ServiceSpec = { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 };
const EL_FRIDGE: ServiceSpec = { category: "electricity", externalLabel: "Lednicový okruh", quantity: 1 };
const WIFI_5: ServiceSpec = { category: "internet", externalLabel: "WIFI", quantity: 5 };
const CLEANING_40: ServiceSpec = { category: "cleaning", externalLabel: "Denní úklid", quantity: 40 };

async function readEditorSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
}

// =========================================================================================
// Shortcut resolution
// =========================================================================================

const enabled = { placementActive: false, shortcutsEnabled: true };
const active = { placementActive: true, shortcutsEnabled: true };
const canvasTarget = { tagName: "CANVAS" };

test("SHORTCUT: U (either case) starts the next placement when no placement is active", () => {
  assert.equal(resolvePlacementShortcut({ key: "u", target: canvasTarget }, enabled), "startNextPlacement");
  assert.equal(resolvePlacementShortcut({ key: "U", target: canvasTarget }, enabled), "startNextPlacement");
});

test("SHORTCUT: Escape cancels an active placement; does nothing when nothing is active", () => {
  assert.equal(resolvePlacementShortcut({ key: "Escape", target: canvasTarget }, active), "cancelPlacement");
  assert.equal(resolvePlacementShortcut({ key: "Escape", target: canvasTarget }, enabled), undefined);
});

test("SHORTCUT: U never fires inside input / textarea / select / contenteditable (incl. nested in a contenteditable ancestor)", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
    assert.equal(resolvePlacementShortcut({ key: "u", target: { tagName } }, enabled), undefined, tagName);
    assert.equal(resolvePlacementShortcut({ key: "Escape", target: { tagName } }, active), undefined, `Escape in ${tagName} is left to the field`);
  }
  assert.equal(resolvePlacementShortcut({ key: "u", target: { tagName: "DIV", isContentEditable: true } }, enabled), undefined);
  const nested = { tagName: "SPAN", isContentEditable: false, closest: (selector: string) => (selector.includes("contenteditable") ? { tagName: "DIV" } : null) };
  assert.equal(isEditableShortcutTarget(nested), true);
  assert.equal(resolvePlacementShortcut({ key: "u", target: nested }, enabled), undefined);
  assert.equal(isEditableShortcutTarget({ tagName: "BUTTON", closest: () => null }), false);
});

test("SHORTCUT: browser/system combos, auto-repeat, IME composition and already-handled events are ignored", () => {
  assert.equal(resolvePlacementShortcut({ key: "u", ctrlKey: true, target: canvasTarget }, enabled), undefined, "Ctrl+U (view source) untouched");
  assert.equal(resolvePlacementShortcut({ key: "u", metaKey: true, target: canvasTarget }, enabled), undefined);
  assert.equal(resolvePlacementShortcut({ key: "u", altKey: true, target: canvasTarget }, enabled), undefined);
  assert.equal(resolvePlacementShortcut({ key: "u", repeat: true, target: canvasTarget }, enabled), undefined);
  assert.equal(resolvePlacementShortcut({ key: "u", isComposing: true, target: canvasTarget }, enabled), undefined);
  assert.equal(resolvePlacementShortcut({ key: "Escape", defaultPrevented: true, target: canvasTarget }, active), undefined);
  assert.equal(resolvePlacementShortcut({ key: "x", target: canvasTarget }, enabled), undefined);
});

test("SHORTCUT: U is ignored while a placement is already active, and nothing fires outside the placement step", () => {
  assert.equal(resolvePlacementShortcut({ key: "u", target: canvasTarget }, active), undefined);
  assert.equal(resolvePlacementShortcut({ key: "u", target: canvasTarget }, { placementActive: false, shortcutsEnabled: false }), undefined);
  assert.equal(resolvePlacementShortcut({ key: "Escape", target: canvasTarget }, { placementActive: true, shortcutsEnabled: false }), undefined);
});

// =========================================================================================
// U target selection
// =========================================================================================

test("U TARGET: selected matched stand with a missing point -> that stand's first missing service", () => {
  const project = buildProject({ "1A02": [EL_2KW], "1A01": [EL_2KW, EL_FRIDGE] });
  assert.equal(describeTarget(project, resolveShortcutPlacementTarget(project.stands, standId(project, "1A02"))), "1A02:Do 3kW 230V");
});

test("U TARGET: nothing selected -> the FIRST stand of the existing work queue (natural stand-number order)", () => {
  const project = buildProject({ "1A10": [EL_2KW], "1A2": [EL_2KW] });
  assert.equal(describeTarget(project, resolveShortcutPlacementTarget(project.stands, undefined)), "1A2:Do 3kW 230V");
});

test("U TARGET: selected stand already complete / unmatched -> the next queue stand after it; nothing placeable -> undefined", () => {
  let project = buildProject({ "1A01": [EL_2KW], "1A02": [EL_2KW], "1A03": [EL_2KW] }, { unmatched: ["1A03"] });
  project = placeTechnicalService(project, standId(project, "1A01"), service(project, "1A01", "Do 3kW 230V").id, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  assert.equal(describeTarget(project, resolveShortcutPlacementTarget(project.stands, standId(project, "1A01"))), "1A02:Do 3kW 230V");
  assert.equal(describeTarget(project, resolveShortcutPlacementTarget(project.stands, standId(project, "1A03"))), "1A02:Do 3kW 230V", "an unmatched stand is never placed into — its markers would be invisible");
  project = placeTechnicalService(project, standId(project, "1A02"), service(project, "1A02", "Do 3kW 230V").id, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  assert.equal(resolveShortcutPlacementTarget(project.stands, undefined), undefined, "no random stand invented when the queue is empty");
});

test("QUEUE: orderedPlacementQueue is the K UMÍSTĚNÍ bucket (matched, missing points) in natural order; next-after wraps around", () => {
  const project = buildProject({ "1A10": [EL_2KW], "1A2": [EL_2KW], "1A3": [EL_2KW] }, { unmatched: ["1A3"] });
  assert.deepEqual(orderedPlacementQueue(project.stands).map((stand) => stand.standNumber), ["1A2", "1A10"]);
  assert.equal(nextPlacementQueueStand(project.stands, standId(project, "1A2"))?.standNumber, "1A10");
  assert.equal(nextPlacementQueueStand(project.stands, standId(project, "1A10"))?.standNumber, "1A2", "wraps");
  assert.equal(nextPlacementQueueStand(project.stands, standId(project, "1A3"))?.standNumber, "1A10", "an off-queue stand resolves by its natural position");
});

// =========================================================================================
// Auto-continue scenarios (spec section 31, 1-11)
// =========================================================================================

test("AUTO 1: auto OFF, single service -> one placement, placement mode ends (unchanged behavior)", () => {
  const project = buildProject({ "1A01": [EL_2KW] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, false);
  assert.equal(result.committed, true);
  assert.equal(result.target, undefined);
  assert.equal(effectiveServicePlacements(service(result.project, "1A01", "Do 3kW 230V")).length, 1);
});

test("AUTO OFF: a multi-placement service stays active until requiredPlacementCount is met, then placement mode ends", () => {
  const project = buildProject({ "1A01": [{ ...EL_2KW, quantity: 3 }, EL_FRIDGE], "1A02": [EL_2KW] });
  const serviceId = service(project, "1A01", "Do 3kW 230V").id;
  let state = simulateClick(project, { standId: standId(project, "1A01"), serviceId }, false);
  assert.equal(state.target?.serviceId, serviceId, "after #1 the same service stays active");
  state = simulateClick(state.project, state.target!, false, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  assert.equal(state.target?.serviceId, serviceId, "after #2 the same service stays active");
  state = simulateClick(state.project, state.target!, false, { page: 1, xNormalized: 0.6, yNormalized: 0.6 });
  assert.equal(effectiveServicePlacements(service(state.project, "1A01", "Do 3kW 230V")).length, 3);
  assert.equal(state.target, undefined, "after the final required click placement mode ends");
  assert.equal(state.selectStandId, undefined);
});

test("AUTO OFF: completing a service never activates another service on the same stand", () => {
  const project = buildProject({ "1A01": [EL_2KW, EL_FRIDGE] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, false);
  assert.equal(result.committed, true);
  assert.equal(result.target, undefined, "Lednicový okruh is NOT auto-activated");
  assert.equal(result.selectStandId, undefined);
});

test("AUTO OFF: completing a stand never selects or activates another stand; U remains the manual way to start it", () => {
  const project = buildProject({ "1A01": [EL_2KW], "1A02": [EL_2KW] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, false);
  assert.equal(result.target, undefined);
  assert.equal(result.selectStandId, undefined, "1A02 is NOT auto-selected");
  assert.equal(describeTarget(result.project, resolveShortcutPlacementTarget(result.project.stands, standId(project, "1A01"))), "1A02:Do 3kW 230V", "pressing U explicitly starts the next item");
});

test("AUTO OFF: WiFi qty 5 / Cleaning qty 40 end placement after their single required click", () => {
  const project = buildProject({ "1A01": [WIFI_5, CLEANING_40, EL_2KW] });
  const wifi = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "WIFI").id }, false);
  assert.equal(wifi.target, undefined);
  const cleaning = simulateClick(wifi.project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Denní úklid").id }, false);
  assert.equal(cleaning.target, undefined);
});

test("AUTO 2: auto ON, two services on the same stand -> first click completes the first, the second becomes active", () => {
  const project = buildProject({ "1A01": [EL_2KW, EL_FRIDGE] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, true);
  assert.equal(describeTarget(result.project, result.target), "1A01:Lednicový okruh");
});

test("AUTO 3: auto ON, a service requiring 3 placements stays active for clicks 1-2 and advances only after click 3", () => {
  const project = buildProject({ "1A01": [{ ...EL_2KW, quantity: 3 }, EL_FRIDGE] });
  const serviceId = service(project, "1A01", "Do 3kW 230V").id;
  assert.equal(requiredPlacementCount(service(project, "1A01", "Do 3kW 230V")), 3);
  let state = simulateClick(project, { standId: standId(project, "1A01"), serviceId }, true);
  assert.equal(state.target?.serviceId, serviceId, "after #1 still the same service");
  state = simulateClick(state.project, state.target!, true, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  assert.equal(state.target?.serviceId, serviceId, "after #2 still the same service");
  state = simulateClick(state.project, state.target!, true, { page: 1, xNormalized: 0.6, yNormalized: 0.6 });
  assert.equal(describeTarget(state.project, state.target), "1A01:Lednicový okruh", "after #3 advances");
  assert.equal(effectiveServicePlacements(service(state.project, "1A01", "Do 3kW 230V")).length, 3);
});

test("AUTO 4: auto ON, WiFi qty 5 -> ONE placement completes it (requiredPlacementCount = 1), advances immediately", () => {
  const project = buildProject({ "1A01": [WIFI_5, EL_2KW] });
  assert.equal(requiredPlacementCount(service(project, "1A01", "WIFI")), 1);
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "WIFI").id }, true);
  assert.equal(effectiveServicePlacements(service(result.project, "1A01", "WIFI")).length, 1);
  assert.equal(describeTarget(result.project, result.target), "1A01:Do 3kW 230V");
});

test("AUTO 5: auto ON, Cleaning qty 40 -> ONE placement completes it, advances immediately", () => {
  const project = buildProject({ "1A01": [CLEANING_40], "1A02": [EL_2KW] });
  assert.equal(requiredPlacementCount(service(project, "1A01", "Denní úklid")), 1);
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Denní úklid").id }, true);
  assert.equal(describeTarget(result.project, result.target), "1A02:Do 3kW 230V");
});

test("AUTO 6: auto ON, last service on a stand -> the next queue stand's first missing placement becomes active (and selected)", () => {
  const project = buildProject({ "1A03": [EL_2KW], "1A01": [EL_2KW], "1A02": [EL_FRIDGE, WIFI_5] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, true);
  assert.equal(describeTarget(result.project, result.target), "1A02:Lednicový okruh", "follows the natural K UMÍSTĚNÍ order: 1A01 -> 1A02 -> 1A03");
  assert.equal(result.selectStandId, standId(project, "1A02"));
});

test("AUTO 6b: auto ON walks the whole queue in order with one click per required point — never a coordinate of its own", () => {
  let project = buildProject({ "1A02": [WIFI_5], "1A01": [EL_2KW, CLEANING_40], "1A03": [{ ...EL_2KW, quantity: 2 }] });
  let target = resolveShortcutPlacementTarget(project.stands, undefined);
  const visited: string[] = [];
  let clicks = 0;
  while (target) {
    visited.push(describeTarget(project, target)!);
    const point = { page: 1, xNormalized: 0.01 * (clicks + 1), yNormalized: 0.02 * (clicks + 1) };
    const result = simulateClick(project, target, true, point);
    clicks += 1;
    project = result.project;
    target = result.target;
  }
  assert.deepEqual(visited, ["1A01:Do 3kW 230V", "1A01:Denní úklid", "1A02:WIFI", "1A03:Do 3kW 230V", "1A03:Do 3kW 230V"]);
  const allPlacements = project.stands.flatMap((stand) => stand.services.flatMap((candidate) => effectiveServicePlacements(candidate)));
  assert.equal(allPlacements.length, clicks, "exactly one placement per user click");
  assert.deepEqual(allPlacements.map((placement) => placement.xNormalized).sort(), Array.from({ length: clicks }, (_, index) => 0.01 * (index + 1)).sort(), "every coordinate came from a click");
});

test("AUTO 7: auto ON, last service in the entire queue -> placement mode ends cleanly", () => {
  const project = buildProject({ "1A01": [EL_2KW] });
  const result = simulateClick(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, true);
  assert.equal(result.target, undefined);
  assert.equal(result.selectStandId, undefined);
});

test("AUTO 8: auto ON, a failed/refused placement does not advance — the same target stays active", () => {
  let project = buildProject({ "1A01": [EL_2KW, EL_FRIDGE] });
  const target = { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id };
  project = placeTechnicalService(project, target.standId, target.serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const refused = simulateClick(project, target, true);
  assert.equal(refused.committed, false, "service already full -> placeTechnicalService refuses (same reference)");
  assert.equal(refused.target, target, "target unchanged, no advance");
  const stale = simulateClick(project, { standId: "missing-stand", serviceId: "missing" }, true);
  assert.equal(stale.committed, false);
});

test("AUTO 9/10: Escape stops the session via the single cancel path and never turns the auto preference off", async () => {
  const source = await readEditorSource();
  const cancel = source.slice(source.indexOf("function handleCancelPlacement()"), source.indexOf("shortcutHandlersRef.current = {"));
  assert.match(cancel, /setPlacementMode\(undefined\);/u);
  assert.ok(!cancel.includes("onAutoContinuePlacementChange"), "cancel never touches the preference");
  assert.ok(!cancel.includes("setProject("), "cancel never deletes completed placements");
  const run = source.slice(source.indexOf("shortcutHandlersRef.current = {"), source.indexOf("function handleServiceSymbolClick("));
  assert.match(run, /if \(action === "cancelPlacement"\) handleCancelPlacement\(\);/u, "Escape uses the SAME handler as the button");
  assert.match(source, /onCancel=\{handleCancelPlacement\}/u);
});

test("AUTO 11: manual specific-service selection while auto ON is honored, then continuation resumes from the remaining queue", () => {
  const project = buildProject({ "1A01": [EL_2KW], "1A02": [EL_2KW], "1A03": [EL_FRIDGE, EL_2KW] });
  // The user explicitly clicks Umístit on 1A03's second service, out of queue order.
  const manual = { standId: standId(project, "1A03"), serviceId: service(project, "1A03", "Do 3kW 230V").id };
  const first = simulateClick(project, manual, true);
  assert.equal(describeTarget(first.project, first.target), "1A03:Lednicový okruh", "finishes the chosen stand first");
  const second = simulateClick(first.project, first.target!, true);
  assert.equal(describeTarget(second.project, second.target), "1A01:Do 3kW 230V", "then resumes the queue (wrapping past the end)");
});

// =========================================================================================
// Editor wiring (source guards)
// =========================================================================================

test("SOURCE: exactly one window keydown listener, registered once ([] deps) with matching cleanup", async () => {
  const source = await readEditorSource();
  assert.equal((source.match(/addEventListener\("keydown"/gu) ?? []).length, 1);
  assert.match(source, /window\.addEventListener\("keydown", handleKeyDown\);\s*return \(\) => window\.removeEventListener\("keydown", handleKeyDown\);\s*\}, \[\]\);/u);
  assert.match(source, /const action = resolvePlacementShortcut\(event, handlers\);/u);
});

test("SOURCE: canvas click only advances after a committed placement (unchanged project reference = no advance)", async () => {
  const source = await readEditorSource();
  const click = source.slice(source.indexOf("function handleCanvasClick("), source.indexOf("function handleClearAssignment("));
  const guard = click.indexOf("if (next === current) return;");
  const advance = click.indexOf("advancePlacementAfterCommit(next");
  assert.ok(guard > 0 && advance > guard);
  assert.match(source, /resolvePlacementAdvance\(updatedProject\.stands, standId, serviceId, shouldContinuePlacementSession\(session, autoContinuePlacement\)\)/u);
});

test("SOURCE: active placement is cleared when leaving the placement step or switching project; the preference lives in TechnicalRastersPage", async () => {
  const source = await readEditorSource();
  assert.match(source, /if \(step !== "assignment"\) setPlacementMode\(undefined\);/u);
  assert.match(source, /setPlacementMode\(undefined\);\s*setPlacementNotice\(""\);\s*setSelectedStandId\(undefined\);\s*setAssignmentActiveStandId\(undefined\);\s*\}, \[projectId\]\);/u);
  const router = await readFile(new URL("../components/workflow/TechnicalRastersPage.tsx", import.meta.url), "utf8");
  assert.match(router, /const \[autoContinuePlacement, setAutoContinuePlacement\] = useState\(false\);/u, "default OFF");
  assert.match(router, /key=\{openProjectId\}/u, "a new project always mounts a fresh editor (no stale target)");
});

test("SOURCE: labelled auto-continue toggle, shortcut hint, and the banner's visible 'Zrušit umisťování' + auto indicator text", async () => {
  const source = await readEditorSource();
  assert.match(source, /<input\s+type="checkbox"\s+checked=\{autoContinuePlacement\}/u);
  assert.match(source, /<span>Automaticky pokračovat v umisťování<\/span>/u);
  assert.match(source, /autoContinue=\{autoContinuePlacement\}/u);
  const panel = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterPlacementContextPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /"Zrušit umisťování"/u);
  assert.match(panel, /Automatické pokračování: zapnuto/u);
});

// =========================================================================================
// Placement SESSION kind — "Umístit chybějící postupně" is an explicit sequential session that
// continues regardless of the global auto-continue preference; normal Umístit and U follow it.
// =========================================================================================

/** Runs clicks until the session ends (or `maxClicks`), exactly like the editor: the session kind is carried to every next target. */
function runSession(
  project: TechnicalRasterProject,
  start: PlacementSessionTarget,
  session: PlacementSessionKind,
  autoContinuePreference: boolean,
  maxClicks = 50,
): Readonly<{ project: TechnicalRasterProject; visited: readonly string[]; endTarget?: PlacementSessionTarget }> {
  let target: PlacementSessionTarget | undefined = start;
  const visited: string[] = [];
  for (let click = 0; target && click < maxClicks; click += 1) {
    visited.push(describeTarget(project, target)!);
    const result = simulateClick(project, target, shouldContinuePlacementSession(session, autoContinuePreference), { page: 1, xNormalized: 0.01 * (click + 1), yNormalized: 0.5 });
    project = result.project;
    target = result.target;
  }
  return { project, visited, endTarget: target };
}

test("SESSION: shouldContinuePlacementSession — manual follows the preference, sequentialExplicit always continues", () => {
  assert.equal(shouldContinuePlacementSession("manual", false), false);
  assert.equal(shouldContinuePlacementSession("manual", true), true);
  assert.equal(shouldContinuePlacementSession("sequentialExplicit", false), true);
  assert.equal(shouldContinuePlacementSession("sequentialExplicit", true), true);
});

test("SESSION: normal Umístit + auto OFF stops after the current service", () => {
  const project = buildProject({ "1A01": [EL_2KW, EL_FRIDGE], "1A02": [EL_2KW] });
  const run = runSession(project, { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id }, "manual", false);
  assert.deepEqual(run.visited, ["1A01:Do 3kW 230V"]);
  assert.equal(run.endTarget, undefined);
});

test("SESSION: U + auto OFF (a manual session) stops after the current service — a multi-point service still completes first", () => {
  const project = buildProject({ "1A01": [{ ...EL_2KW, quantity: 2 }, EL_FRIDGE], "1A02": [EL_2KW] });
  const start = resolveShortcutPlacementTarget(project.stands, undefined)!;
  const run = runSession(project, start, "manual", false);
  assert.deepEqual(run.visited, ["1A01:Do 3kW 230V", "1A01:Do 3kW 230V"]);
  assert.equal(run.endTarget, undefined);
});

test("SESSION: 'Umístit chybějící postupně' + auto OFF continues to the next service AND the next queue stand until nothing remains", () => {
  const project = buildProject({ "1A02": [WIFI_5, { ...EL_2KW, quantity: 2 }], "1A01": [EL_2KW, CLEANING_40], "1A03": [EL_FRIDGE] });
  const stand = project.stands.find((candidate) => candidate.standNumber === "1A01")!;
  const start = { standId: stand.id, serviceId: resolveNextPlacementTargetForTest(stand) };
  const run = runSession(project, start, "sequentialExplicit", false);
  assert.deepEqual(run.visited, ["1A01:Do 3kW 230V", "1A01:Denní úklid", "1A02:WIFI", "1A02:Do 3kW 230V", "1A02:Do 3kW 230V", "1A03:Lednicový okruh"],
    "next service -> next stand; WiFi 5 / Cleaning 40 need one click each; the 2-point service stays active for both");
  assert.equal(run.endTarget, undefined, "ends when nothing remains");
  assert.equal(orderedPlacementQueue(run.project.stands).length, 0);
});

test("SESSION: auto ON behavior is unchanged — a manual session continues exactly like an explicit sequential one", () => {
  const project = buildProject({ "1A01": [EL_2KW, EL_FRIDGE], "1A02": [EL_2KW] });
  const start = { standId: standId(project, "1A01"), serviceId: service(project, "1A01", "Do 3kW 230V").id };
  const manualOn = runSession(project, start, "manual", true);
  const sequentialOff = runSession(project, start, "sequentialExplicit", false);
  assert.deepEqual(manualOn.visited, ["1A01:Do 3kW 230V", "1A01:Lednicový okruh", "1A02:Do 3kW 230V"]);
  assert.deepEqual(sequentialOff.visited, manualOn.visited);
});

function resolveNextPlacementTargetForTest(stand: TechnicalRasterProject["stands"][number]): string {
  return resolveShortcutPlacementTarget([stand], stand.id)!.serviceId;
}

test("SESSION SOURCE: the sequential button starts a sequentialExplicit session; Umístit and U start manual sessions; the advance carries the session kind", async () => {
  const source = await readEditorSource();
  const sequential = source.slice(source.indexOf("function handlePlaceMissingSequentially("), source.indexOf("function advancePlacementAfterCommit("));
  assert.match(sequential, /session: "sequentialExplicit"/u);
  const place = source.slice(source.indexOf("function handlePlaceService("), source.indexOf("function handleMovePlacement("));
  assert.match(place, /session: "manual"/u);
  const shortcut = source.slice(source.indexOf("function handleStartNextPlacement("), source.indexOf("function handleRemovePlacement("));
  assert.match(shortcut, /session: "manual"/u);
  const advance = source.slice(source.indexOf("function advancePlacementAfterCommit("), source.indexOf("function handleStartNextPlacement("));
  assert.match(advance, /shouldContinuePlacementSession\(session, autoContinuePlacement\)/u);
  assert.match(advance, /mode: "place", session \}/u, "the next target keeps the same session kind");
  assert.ok(!source.includes("onAutoContinuePlacementChange?.(true)") && !source.includes("onAutoContinuePlacementChange?.(false)"), "the global preference is never mutated programmatically");
});

test("SESSION SOURCE: Escape / Zrušit umisťování end the explicit sequential session through the single cancel path, never touching the global preference", async () => {
  const source = await readEditorSource();
  const cancel = source.slice(source.indexOf("function handleCancelPlacement()"), source.indexOf("shortcutHandlersRef.current = {"));
  assert.match(cancel, /setPlacementMode\(undefined\);/u, "clearing placementMode drops the session kind with it — no stale sequential session survives");
  assert.ok(!cancel.includes("onAutoContinuePlacementChange") && !cancel.includes("autoContinuePlacement"));
  assert.match(source, /if \(action === "cancelPlacement"\) handleCancelPlacement\(\);/u);
  assert.equal(resolvePlacementShortcut({ key: "Escape", target: canvasTarget }, active), "cancelPlacement", "Escape resolves to cancel while any session (incl. sequential) is active");
  assert.match(source, /if \(step !== "assignment"\) setPlacementMode\(undefined\);/u, "a step change also ends it");
});
