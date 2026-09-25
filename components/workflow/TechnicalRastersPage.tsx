"use client";

import { useState } from "react";
import type { TechnicalRasterProjectRepository } from "../../domain/technicalRaster";
import type { Exhibition } from "../../domain/organizations";
import type { RemoteApiCatalogPricingRepository } from "../../lib/db/catalogPricing.remoteApi.client";
import { TechnicalRasterProjectListPage } from "./technicalRasters/TechnicalRasterProjectListPage";
import { TechnicalRasterEditorPage } from "./technicalRasters/TechnicalRasterEditorPage";

/**
 * Technické rastry — a NEW, standalone module (spec: "Nevkládej jej jako drobný panel dovnitř
 * jiného generátoru"). Same thin-router pattern as PrintSurfacesPage.tsx (a DIFFERENT module) —
 * this component only decides list vs. editor, all real state/logic lives in
 * TechnicalRasterProjectListPage / TechnicalRasterEditorPage.
 */
export function TechnicalRastersPage({
  projectRepository,
  catalogPricingRepository,
  events,
}: {
  projectRepository: TechnicalRasterProjectRepository;
  catalogPricingRepository: RemoteApiCatalogPricingRepository;
  events: readonly Exhibition[];
}) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  // "Automaticky pokračovat v umisťování" (production-workflow batch, part B): a per-session mode
  // preference, default OFF. Held here (not in the editor) so it survives opening another project,
  // while each editor mount still starts with no active placement target. Not persisted across page
  // reloads — there is no per-user UI-preference store to reuse, and rasterSettings is project/export data.
  const [autoContinuePlacement, setAutoContinuePlacement] = useState(false);

  if (openProjectId) {
    return (
      <TechnicalRasterEditorPage
        key={openProjectId}
        projectId={openProjectId}
        projectRepository={projectRepository}
        catalogPricingRepository={catalogPricingRepository}
        onBackToList={() => setOpenProjectId(null)}
        autoContinuePlacement={autoContinuePlacement}
        onAutoContinuePlacementChange={setAutoContinuePlacement}
      />
    );
  }

  return <TechnicalRasterProjectListPage projectRepository={projectRepository} events={events} onOpenProject={setOpenProjectId} />;
}
