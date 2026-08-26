import assert from "node:assert/strict";
import test from "node:test";
import { renderVisualizationBatch, type CaptureAndUploadOne, type VisualizationRenderBatchProgress } from "../lib/visualizationRenderBatch.ts";
import type { VisualizationItem } from "../domain/project.ts";

function customerRender(viewId: string): VisualizationItem {
  return { id: `r-${viewId}`, name: viewId, sourceViewId: viewId, viewId, imageDataUrl: "data:image/png;base64,AA==", type: "customer", purpose: "working", createdAt: "2026-08-26T10:00:00.000Z", reviewStatus: "unreviewed" };
}

// =========================================================================================
// Visualization v2 — sequential "Vyrenderovat všechny" batch (report sections 8/29/30): one
// capture at a time, one failure never aborts the rest, progress is monotonic.
// =========================================================================================

test("BATCH: calls captureAndUploadOne once per target, in the given order", async () => {
  const calls: string[] = [];
  const captureAndUploadOne: CaptureAndUploadOne = async (target) => {
    calls.push(target.viewId);
    return { ok: true, item: customerRender(target.viewId) };
  };
  const result = await renderVisualizationBatch(
    [{ viewId: "v1", viewName: "Hlavní" }, { viewId: "v2", viewName: "Levý" }, { viewId: "v3", viewName: "Pravý" }],
    { captureAndUploadOne },
  );
  assert.deepEqual(calls, ["v1", "v2", "v3"]);
  assert.equal(result.succeeded.length, 3);
  assert.equal(result.failed.length, 0);
});

test("BATCH: one view failing does not abort the rest — partial success with a precise failure list", async () => {
  const captureAndUploadOne: CaptureAndUploadOne = async (target) => {
    if (target.viewId === "v2") return { ok: false, viewName: target.viewName, reason: "print-tool-active" };
    return { ok: true, item: customerRender(target.viewId) };
  };
  const result = await renderVisualizationBatch(
    [{ viewId: "v1", viewName: "Hlavní" }, { viewId: "v2", viewName: "Levý" }, { viewId: "v3", viewName: "Pravý" }],
    { captureAndUploadOne },
  );
  assert.deepEqual(result.succeeded.map((item) => item.viewId), ["v1", "v3"]);
  assert.deepEqual(result.failed, [{ viewName: "Levý", reason: "print-tool-active" }]);
});

test("BATCH: progress reports monotonically increasing completed/total, ending at total/total", async () => {
  const progressCalls: VisualizationRenderBatchProgress[] = [];
  const captureAndUploadOne: CaptureAndUploadOne = async (target) => ({ ok: true, item: customerRender(target.viewId) });
  await renderVisualizationBatch(
    [{ viewId: "v1", viewName: "Hlavní" }, { viewId: "v2", viewName: "Levý" }],
    { captureAndUploadOne, onProgress: (progress) => progressCalls.push(progress) },
  );
  assert.deepEqual(progressCalls.map((p) => p.completed), [0, 1, 2]);
  assert.ok(progressCalls.every((p) => p.total === 2));
});

test("BATCH: a fully-failed batch still returns a defined result with every view listed as failed, never throws", async () => {
  const captureAndUploadOne: CaptureAndUploadOne = async (target) => ({ ok: false, viewName: target.viewName, reason: "capture-failed" });
  const result = await renderVisualizationBatch([{ viewId: "v1", viewName: "Hlavní" }], { captureAndUploadOne });
  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 1);
});

test("BATCH: an empty target list resolves immediately with empty results, no captureAndUploadOne calls", async () => {
  let calls = 0;
  const captureAndUploadOne: CaptureAndUploadOne = async (target) => { calls++; return { ok: true, item: customerRender(target.viewId) }; };
  const result = await renderVisualizationBatch([], { captureAndUploadOne });
  assert.equal(calls, 0);
  assert.deepEqual(result, { succeeded: [], failed: [] });
});
