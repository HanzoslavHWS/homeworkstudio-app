export type ProjectPackageFile = Readonly<{
  id: string;
  name: string;
  folderId: string;
  sourceType: "generated" | "uploaded";
  mimeType: string;
  includeInZip: boolean;
  dataReference?: string;
}>;

export type ProjectPackageFolder = Readonly<{
  id: string;
  name: string;
  parentId?: string;
}>;

export type ProjectPackage = Readonly<{
  projectId: string;
  rootName: string;
  folders: readonly ProjectPackageFolder[];
  files: readonly ProjectPackageFile[];
}>;

export const PROJECT_PACKAGE_FOLDERS: readonly ProjectPackageFolder[] = [
  { id: "project", name: "01_Projekt" },
  { id: "visualizations", name: "02_Vizualizace" },
  { id: "visualizations-working", name: "pracovni", parentId: "visualizations" },
  { id: "visualizations-final", name: "finalni", parentId: "visualizations" },
  { id: "plans", name: "03_Pudorysy" },
  { id: "plans-technical", name: "technicky", parentId: "plans" },
  { id: "plans-electrical", name: "elektro", parentId: "plans" },
  { id: "plans-complete", name: "kompletni", parentId: "plans" },
  { id: "graphics", name: "04_Grafika" },
  { id: "graphics-input", name: "dodana_data", parentId: "graphics" },
  { id: "graphics-print", name: "tiskove_podklady", parentId: "graphics" },
  { id: "technical", name: "05_Technicke" },
  { id: "technical-electrical", name: "elektro", parentId: "technical" },
  { id: "technical-water", name: "voda", parentId: "technical" },
  { id: "technical-waste", name: "odpad", parentId: "technical" },
  { id: "export", name: "06_Export" },
  { id: "export-customer", name: "zakaznik", parentId: "export" },
  { id: "export-internal", name: "interni", parentId: "export" },
  { id: "source", name: "07_Zdrojova_data" },
  { id: "event-documents", name: "event_dokumenty", parentId: "source" },
];

export function createProjectPackage(
  projectId: string,
  rootName: string,
  files: readonly ProjectPackageFile[] = [],
): ProjectPackage {
  return { projectId, rootName, folders: PROJECT_PACKAGE_FOLDERS, files };
}

export function packageFolderPath(
  projectPackage: ProjectPackage,
  folderId: string,
): string {
  const parts: string[] = [];
  let current = projectPackage.folders.find((folder) => folder.id === folderId);
  while (current) {
    parts.unshift(current.name);
    current = current.parentId
      ? projectPackage.folders.find((folder) => folder.id === current?.parentId)
      : undefined;
  }
  return [projectPackage.rootName, ...parts].join("/");
}

export interface SketchUpExportProvider {
  readonly id: string;
  exportProject(projectId: string): Promise<{ fileName: string; data: Blob }>;
}
