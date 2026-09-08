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

  if (openProjectId) {
    return (
      <TechnicalRasterEditorPage
        projectId={openProjectId}
        projectRepository={projectRepository}
        catalogPricingRepository={catalogPricingRepository}
        onBackToList={() => setOpenProjectId(null)}
      />
    );
  }

  return <TechnicalRasterProjectListPage projectRepository={projectRepository} events={events} onOpenProject={setOpenProjectId} />;
}
