/**
 * ABRA order import — does the order PDF belong to the fair of this project?
 *
 * The "3. Formulář objednávky přijaté ABF" PDF carries NO fair identifier: no fair name or code in the
 * page header, the items or the PDF metadata (checked on the real export). The only identifiers are the
 * ABRA document series of the order numbers ("V238" of "V238-1/2026") and the issue dates — nothing
 * documents which series belongs to which fair, so no fair is ever derived from them.
 *
 * The affiliation therefore can never be VERIFIED. What can be checked are factual contradictions with
 * the target project: another order series than the project's earlier order import, or not a single
 * ordered stand on the project's raster. Either way the user has to confirm explicitly, with the source
 * file and the target fair named; the confirmation is stored on the import record.
 */
import { abraOrderSeries, type AbraOrderTechnicalImport } from "./abraOrderTechnicalImport.ts";
import { ABRA_ORDER_IMPORT_CATEGORY, type TechnicalRasterProject } from "./technicalRaster.ts";
import { normalizeStandNumber } from "./technicalStandNumber.ts";

export type AbraOrderFairFindingKind = "noFairIdentifier" | "noTargetFair" | "seriesDiffers" | "noStandInRaster";

export type AbraOrderFairCheck = Readonly<{
  /** "unverifiable": nothing contradicts, but nothing proves it either. "conflict": a factual contradiction. */
  status: "unverifiable" | "conflict";
  sourceFileName: string;
  orderSeries: readonly string[];
  issueDateRange?: Readonly<{ from: string; to: string }>;
  target: Readonly<{ projectName: string; hall?: string; eventLabel?: string }>;
  /** Ordered stands (with technical services) found among the raster's stand labels; undefined without a raster. */
  standsInRaster?: Readonly<{ matched: number; total: number }>;
  findings: readonly Readonly<{ kind: AbraOrderFairFindingKind; message: string }>[];
  /** The sentence the user confirms. */
  confirmationText: string;
}>;

/** Stored on the import record: what the user confirmed. */
export type AbraOrderFairConfirmation = Readonly<{
  status: AbraOrderFairCheck["status"];
  orderSeries: readonly string[];
  targetEventLabel?: string;
  findings: readonly string[];
  confirmedAt: string;
}>;

/** The order series an earlier order import of the project used (its stored confirmation, else its order lines). */
function previousOrderSeries(project: TechnicalRasterProject): readonly string[] {
  const series = new Set<string>();
  for (const record of project.imports) {
    if (record.category !== ABRA_ORDER_IMPORT_CATEGORY) continue;
    for (const value of record.fairConfirmation?.orderSeries ?? []) series.add(value);
    for (const line of record.orderLines ?? []) series.add(abraOrderSeries(line.orderNumber));
  }
  return [...series].sort();
}

export function checkAbraOrderFairAffiliation(input: Readonly<{
  project: TechnicalRasterProject;
  orderImport: AbraOrderTechnicalImport;
  sourceFileName: string;
  /** The fair the project is assigned to ("FOR BEAUTY 2026"), when it has one. */
  targetEventLabel?: string;
}>): AbraOrderFairCheck {
  const { project, orderImport, sourceFileName, targetEventLabel } = input;
  const { orderSeries, issueDateRange } = orderImport.documents;
  const findings: { kind: AbraOrderFairFindingKind; message: string }[] = [
    { kind: "noFairIdentifier", message: "PDF objednávek neobsahuje identifikátor veletrhu — příslušnost k veletrhu nelze ověřit." },
  ];
  if (!targetEventLabel) findings.push({ kind: "noTargetFair", message: "Projekt nemá přiřazený veletrh — není s čím porovnat." });

  const previous = previousOrderSeries(project);
  const unknownSeries = orderSeries.filter((series) => !previous.includes(series));
  if (previous.length > 0 && unknownSeries.length > 0) {
    findings.push({ kind: "seriesDiffers", message: `Rozpor: dříve importované objednávky v tomto projektu mají řadu ${previous.join(", ")}, nový soubor ${orderSeries.join(", ")}.` });
  }

  const rasterStands = new Set(project.rasterStandLabels.map((label) => normalizeStandNumber(label.normalizedStandNumber)));
  const orderedStands = new Set(orderImport.importedLines.map((line) => normalizeStandNumber(line.standNumber!)));
  const standsInRaster = rasterStands.size > 0 ? { matched: [...orderedStands].filter((stand) => rasterStands.has(stand)).length, total: orderedStands.size } : undefined;
  if (standsInRaster && standsInRaster.total > 0 && standsInRaster.matched === 0) {
    findings.push({ kind: "noStandInRaster", message: `Rozpor: žádný z ${standsInRaster.total} stánků s technickými službami v objednávkách není v rastru projektu.` });
  }

  const conflict = findings.some((finding) => finding.kind === "seriesDiffers" || finding.kind === "noStandInRaster");
  const target = targetEventLabel ? `veletrhu „${targetEventLabel}“` : "veletrhu tohoto projektu";
  return {
    status: conflict ? "conflict" : "unverifiable",
    sourceFileName,
    orderSeries,
    ...(issueDateRange ? { issueDateRange } : {}),
    target: { projectName: project.name, ...(project.hall ? { hall: project.hall } : {}), ...(targetEventLabel ? { eventLabel: targetEventLabel } : {}) },
    ...(standsInRaster ? { standsInRaster } : {}),
    findings,
    confirmationText: conflict
      ? `Přes uvedený rozpor potvrzuji, že soubor „${sourceFileName}“ patří k ${target} (projekt „${project.name}“${project.hall ? `, hala ${project.hall}` : ""}).`
      : `Potvrzuji, že soubor „${sourceFileName}“ patří k ${target} (projekt „${project.name}“${project.hall ? `, hala ${project.hall}` : ""}).`,
  };
}

export function fairConfirmationOf(check: AbraOrderFairCheck, confirmedAt: string = new Date().toISOString()): AbraOrderFairConfirmation {
  return {
    status: check.status,
    orderSeries: check.orderSeries,
    ...(check.target.eventLabel ? { targetEventLabel: check.target.eventLabel } : {}),
    findings: check.findings.map((finding) => finding.message),
    confirmedAt,
  };
}
