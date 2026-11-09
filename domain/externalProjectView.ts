import { EXTERNAL_PROJECT_OUTPUT_FOLDERS } from "./accessControl.ts";

/**
 * What an EXTERNAL user sees of an assigned 3D project (V1-AUTH-01): identification and the allowed
 * outputs (files in the project's exports / visualizations / floorplans folders). Never the scene,
 * notes, contacts, technical requirements, imported order, prices or anything else of the document.
 */
export type ExternalProjectOutput = Readonly<{ storageKey: string; fileName: string; folder: string }>;
export type ExternalProjectView = Readonly<{
  id: string;
  name: string;
  fairId: string;
  boothNumber: string;
  status: string;
  modifiedAt: string;
  outputs: readonly ExternalProjectOutput[];
}>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Every stored file reference of the project document that lives in an allowed output folder of THIS project. */
export function externalProjectOutputs(projectId: string, document: unknown): readonly ExternalProjectOutput[] {
  const found = new Map<string, ExternalProjectOutput>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const key = record.storageKey;
    if (typeof key === "string") {
      const [root, owner, folder] = key.split("/");
      if (root === "projects" && owner === projectId && folder && EXTERNAL_PROJECT_OUTPUT_FOLDERS.includes(folder) && !key.includes("..") && !found.has(key)) {
        found.set(key, { storageKey: key, fileName: text(record.displayName) || text(record.originalFileName) || key.split("/").pop()!, folder });
      }
    }
    for (const entry of Object.values(record)) walk(entry, depth + 1);
  };
  walk(document, 0);
  return [...found.values()];
}

export function externalProjectView(project: Readonly<Record<string, unknown>> & Readonly<{ id: string }>): ExternalProjectView {
  return {
    id: project.id,
    name: text(project.name),
    fairId: text(project.fairId),
    boothNumber: text(project.boothNumber),
    status: text(project.status),
    modifiedAt: text(project.modifiedAt),
    outputs: externalProjectOutputs(project.id, project),
  };
}
