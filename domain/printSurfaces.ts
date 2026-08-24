import type {
  PrintSurface,
  PrintSurfaceFace,
  PrintSurfaceSceneBinding,
} from "./models.ts";

export const P86_PANEL_PRINT_WIDTH_MM = 950;
export const P86_PANEL_PRINT_HEIGHT_MM = 2340;
export const P86_FASCIA_PRINT_WIDTH_MM = 2000;
export const P86_FASCIA_PRINT_HEIGHT_MM = 300;

export const P86_PRINT_SURFACE_NODE_NAMES = {
  backWall01: "HWS_PANEL_950_H2500__BACK_WALL_01__CORE",
  backWall02: "HWS_PANEL_950_H2500__BACK_WALL_02__CORE",
  leftWall01: "HWS_PANEL_950_H2500__LEFT_WALL_01__CORE",
  rightWall01: "HWS_PANEL_950_H2500__RIGHT_WALL_01__CORE",
  fascia: "HWS_FASCIA_2000__FASCIA_01",
} as const;

/**
 * Authored P86 CORE convention: panel width is local X, thickness is local Y and height is
 * local Z. FRONT is the local -Y physical face; BACK is local +Y. Instance rotations therefore
 * never change which physical face a surface id addresses. The fascia print face follows the
 * same local -Y FRONT convention.
 */
const P86_LOCAL_NORMAL_BY_FACE = {
  front: "-y",
  back: "+y",
} as const satisfies Readonly<Record<PrintSurfaceFace, "-y" | "+y">>;

type P86PanelDescriptor = Readonly<{
  id: string;
  name: string;
  nodeName: string;
  group: PrintSurface["group"];
  order: number;
}>;

const P86_PANEL_DESCRIPTORS: readonly P86PanelDescriptor[] = [
  {
    id: "back-wall-01",
    name: "Panel 1",
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.backWall01,
    group: { id: "back-wall", name: "Zadní stěna", order: 0 },
    order: 0,
  },
  {
    id: "back-wall-02",
    name: "Panel 2",
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.backWall02,
    group: { id: "back-wall", name: "Zadní stěna", order: 0 },
    order: 1,
  },
  {
    id: "left-wall-01",
    name: "Panel 1",
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.leftWall01,
    group: { id: "left-wall", name: "Levá stěna", order: 1 },
    order: 0,
  },
  {
    id: "right-wall-01",
    name: "Panel 1",
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.rightWall01,
    group: { id: "right-wall", name: "Pravá stěna", order: 2 },
    order: 0,
  },
];

function panelFaceSurface(
  panel: P86PanelDescriptor,
  face: PrintSurfaceFace,
): PrintSurface {
  return {
    id: `${panel.id}-${face}`,
    name: `${panel.name} ${face.toUpperCase()}`,
    widthMm: P86_PANEL_PRINT_WIDTH_MM,
    heightMm: P86_PANEL_PRINT_HEIGHT_MM,
    orientation: "portrait",
    materialRole: "PRINT_SURFACE",
    active: true,
    assignmentMode: "on-demand",
    group: panel.group,
    order: panel.order * 2 + (face === "front" ? 0 : 1),
    sceneBinding: {
      nodeName: panel.nodeName,
      face,
      coordinateSpace: "node-local",
      localNormalAxis: P86_LOCAL_NORMAL_BY_FACE[face],
    },
  };
}

export const P86_PANEL_PRINT_SURFACES: readonly PrintSurface[] =
  P86_PANEL_DESCRIPTORS.flatMap((panel) => [
    panelFaceSurface(panel, "front"),
    panelFaceSurface(panel, "back"),
  ]);

export const P86_FASCIA_PRINT_SURFACE: PrintSurface = {
  // Existing business id is intentionally retained for every saved P86 project.
  id: "fascia-print",
  name: "Límec",
  widthMm: P86_FASCIA_PRINT_WIDTH_MM,
  heightMm: P86_FASCIA_PRINT_HEIGHT_MM,
  orientation: "landscape",
  materialRole: "PRINT_SURFACE",
  allowanceLinearMeters: 2,
  pricingUnit: "bm",
  productionProfiles: {},
  active: true,
  group: { id: "fascia", name: "Límec", order: 3 },
  order: 0,
  sceneBinding: {
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.fascia,
    face: "front",
    coordinateSpace: "node-local",
    localNormalAxis: "-y",
  },
};

/** Canonical catalog/runtime registry: eight independent panel faces plus legacy fascia-print. */
export const P86_CANONICAL_PRINT_SURFACES: readonly PrintSurface[] = [
  ...P86_PANEL_PRINT_SURFACES,
  P86_FASCIA_PRINT_SURFACE,
];

export type ResolvedPrintSurfaceBinding = Readonly<{
  printSurfaceId: string;
  surface: PrintSurface;
  nodeName: string;
  face: PrintSurfaceFace;
  coordinateSpace: PrintSurfaceSceneBinding["coordinateSpace"];
  localNormalAxis: PrintSurfaceSceneBinding["localNormalAxis"];
}>;

/**
 * Exact business-id -> catalog definition -> authored GLB node/face resolver. It deliberately
 * has no node-name fallback, substring matching or orientation heuristic: an absent explicit
 * sceneBinding is unresolved.
 */
export function resolvePrintSurfaceBinding(
  surfaces: readonly PrintSurface[],
  printSurfaceId: string,
): ResolvedPrintSurfaceBinding | undefined {
  const surface = surfaces.find((candidate) => candidate.id === printSurfaceId);
  if (!surface?.sceneBinding) return undefined;
  return {
    printSurfaceId: surface.id,
    surface,
    nodeName: surface.sceneBinding.nodeName,
    face: surface.sceneBinding.face,
    coordinateSpace: surface.sceneBinding.coordinateSpace,
    localNormalAxis: surface.sceneBinding.localNormalAxis,
  };
}
