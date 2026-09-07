"use client";

import { useState } from "react";
import type { PrintSurfaceProjectRepository } from "../../domain/printSurfaceProject";
import type { RealizationCompanyRepository } from "../../domain/realizationCompany";
import type { PrintSurfacePresetRepository } from "../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimensionRepository } from "../../domain/printSurfaceProductionDimension";
import type { PrintSurfaceExportRepository } from "../../domain/printSurfaceExport";
import type { Exhibition } from "../../domain/organizations";
import type { PriceListRepository } from "../../domain/priceListRepository";
import type { RemoteApiCatalogPricingRepository } from "../../lib/db/catalogPricing.remoteApi.client";
import type { PrintSurfaceEmailContext } from "../../domain/printSurfaceEmailContext";
import { PrintSurfaceProjectListPage } from "./printSurfaces/PrintSurfaceProjectListPage";
import { PrintSurfaceEditorPage } from "./printSurfaces/PrintSurfaceEditorPage";

/**
 * "Tiskové plochy" V2 — database-first, real listable/openable projects (spec section 1/5).
 * Clicking the sidebar tab no longer jumps straight into a blank editor: it opens the project
 * HOME/LIST first, and only opening (or creating) a project switches to the editor. This
 * component is just the thin router between those two screens — all real state/logic lives in
 * PrintSurfaceProjectListPage and PrintSurfaceEditorPage.
 */
export function PrintSurfacesPage({
  projectRepository,
  companyRepository,
  presetRepository,
  productionDimensionRepository,
  exportRepository,
  priceListRepository,
  catalogPricingRepository,
  events,
  onEmailHandoff,
  initialProjectId,
}: {
  projectRepository: PrintSurfaceProjectRepository;
  companyRepository: RealizationCompanyRepository;
  presetRepository: PrintSurfacePresetRepository;
  productionDimensionRepository: PrintSurfaceProductionDimensionRepository;
  exportRepository: PrintSurfaceExportRepository;
  priceListRepository: PriceListRepository;
  catalogPricingRepository: RemoteApiCatalogPricingRepository;
  events: readonly Exhibition[];
  onEmailHandoff: (context: PrintSurfaceEmailContext) => void;
  /** "Zpět na Tiskové plochy" (spec section 22) — reopens this project instead of showing the list, read once as this component's initial state since BoothGenerator fully unmounts/remounts it on every workspaceSection change away and back. */
  initialProjectId?: string;
}) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(initialProjectId ?? null);

  if (openProjectId) {
    return (
      <PrintSurfaceEditorPage
        projectId={openProjectId}
        projectRepository={projectRepository}
        companyRepository={companyRepository}
        presetRepository={presetRepository}
        productionDimensionRepository={productionDimensionRepository}
        exportRepository={exportRepository}
        priceListRepository={priceListRepository}
        catalogPricingRepository={catalogPricingRepository}
        events={events}
        onBackToList={() => setOpenProjectId(null)}
        onEmailHandoff={onEmailHandoff}
      />
    );
  }

  return (
    <PrintSurfaceProjectListPage
      projectRepository={projectRepository}
      companyRepository={companyRepository}
      presetRepository={presetRepository}
      productionDimensionRepository={productionDimensionRepository}
      events={events}
      onOpenProject={setOpenProjectId}
    />
  );
}
