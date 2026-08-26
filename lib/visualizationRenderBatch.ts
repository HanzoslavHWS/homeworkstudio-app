/**
 * Visualization v2 — "Vyrenderovat všechny": sequential capture across every saved view (a live
 * WebGL context can't reasonably capture in parallel). Same dependency-injection-for-testability
 * pattern as lib/graphicsProductionPackage.ts's assembleGraphicsProductionZipEntries:
 * `captureAndUploadOne` is injected so this loop is testable under node:test with no live canvas.
 *
 * Deliberately allows PARTIAL success — one view failing (e.g. the print-tool guard, an upload
 * error) never aborts the rest, and the caller gets a precise per-view failure list. This is
 * different from "Stáhnout všechny" (lib/visualizationRenderDownloads.ts), which must never
 * produce a silently incomplete ZIP — those are two different guarantees for two different
 * actions.
 */
import type { VisualizationItem } from "../domain/project.ts";

export type VisualizationRenderBatchTarget = Readonly<{ viewId: string; viewName: string }>;

export type VisualizationRenderBatchProgress = Readonly<{ completed: number; total: number; currentViewName?: string }>;

export type VisualizationRenderBatchOutcome =
  | Readonly<{ ok: true; item: VisualizationItem }>
  | Readonly<{ ok: false; viewName: string; reason: string }>;

export type CaptureAndUploadOne = (target: VisualizationRenderBatchTarget) => Promise<VisualizationRenderBatchOutcome>;

export type VisualizationRenderBatchResult = Readonly<{
  succeeded: readonly VisualizationItem[];
  failed: readonly Readonly<{ viewName: string; reason: string }>[];
}>;

export async function renderVisualizationBatch(
  targets: readonly VisualizationRenderBatchTarget[],
  deps: Readonly<{ captureAndUploadOne: CaptureAndUploadOne; onProgress?: (progress: VisualizationRenderBatchProgress) => void }>,
): Promise<VisualizationRenderBatchResult> {
  const succeeded: VisualizationItem[] = [];
  const failed: { viewName: string; reason: string }[] = [];
  const total = targets.length;
  for (const [index, target] of targets.entries()) {
    deps.onProgress?.({ completed: index, total, currentViewName: target.viewName });
    const outcome = await deps.captureAndUploadOne(target);
    // strict:false narrowing gotcha (see lib/graphicsProductionPackage.ts) — explicit === true.
    if (outcome.ok === true) succeeded.push(outcome.item);
    else failed.push({ viewName: outcome.viewName, reason: outcome.reason });
  }
  deps.onProgress?.({ completed: total, total });
  return { succeeded, failed };
}
