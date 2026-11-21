/**
 * What HWS SEE sends to browsers. Pure. Server-only fields (storageKey, pinHash) are removed here
 * and nowhere else, so every API response goes through these functions.
 */
import type { SeeProjectInfoPanel } from "./seeContent.ts";
import type { SeeUploadLimits } from "./seeFiles.ts";
import {
  hasUnpublishedChanges,
  type SeeAnnotation,
  type SeeFile,
  type SeeProject,
  type SeeProjectAggregate,
  type SeePublication,
  type SeePublicationMode,
  type SeeScene,
  type SeeSnapshotDocument,
  type SeeSnapshotScene,
} from "./seeProject.ts";

export type SeeEditorFile = Omit<SeeFile, "storageKey">;

export type SeeEditorPublication = Omit<SeePublication, "pinHash" | "snapshot" | "accessEpoch"> & Readonly<{
  hasPin: boolean;
  snapshotSceneCount: number;
  snapshotDocumentCount: number;
}>;

export type SeeEditorView = Readonly<{
  project: SeeProject;
  scenes: readonly SeeScene[];
  annotations: readonly SeeAnnotation[];
  files: readonly SeeEditorFile[];
  publication?: SeeEditorPublication;
  hasUnpublishedChanges: boolean;
  limits: SeeUploadLimits;
  backend: "supabase" | "local";
  /** How files reach visitors (signed-url | stream | hybrid) — shown in the publication panel. */
  delivery?: "signed-url" | "stream" | "hybrid";
  /** PIN mode: wrong attempts in the current window; locked = whole presentation temporarily blocked. */
  pinSecurity?: Readonly<{ recentFailures: number; locked: boolean }>;
}>;

export function editorFileView(file: SeeFile): SeeEditorFile {
  const { storageKey: _storageKey, ...rest } = file;
  return rest;
}

export function editorPublicationView(publication: SeePublication): SeeEditorPublication {
  const { pinHash, snapshot, accessEpoch: _accessEpoch, ...rest } = publication;
  return {
    ...rest,
    hasPin: Boolean(pinHash),
    snapshotSceneCount: snapshot?.scenes.length ?? 0,
    snapshotDocumentCount: snapshot?.documents.length ?? 0,
  };
}

export function toEditorView(
  aggregate: SeeProjectAggregate,
  limits: SeeUploadLimits,
  backend: "supabase" | "local",
  extras: Readonly<{ pinSecurity?: SeeEditorView["pinSecurity"]; delivery?: SeeEditorView["delivery"] }> = {},
): SeeEditorView {
  return {
    ...(extras.pinSecurity ? { pinSecurity: extras.pinSecurity } : {}),
    ...(extras.delivery ? { delivery: extras.delivery } : {}),
    project: aggregate.project,
    scenes: aggregate.scenes,
    annotations: aggregate.annotations,
    files: aggregate.files.filter((file) => !file.deletedAt && file.status !== "rejected").map(editorFileView),
    publication: aggregate.publication ? editorPublicationView(aggregate.publication) : undefined,
    hasUnpublishedChanges: hasUnpublishedChanges(aggregate),
    limits,
    backend,
  };
}

export type SeePublicUnavailableReason = "paused" | "archived" | "unpublished";

export type SeePublicManifest =
  | Readonly<{ state: "ok"; mode: SeePublicationMode; title: string; description: string; revision: number; scenes: readonly SeeSnapshotScene[]; documents: readonly SeeSnapshotDocument[]; infoPanel?: SeeProjectInfoPanel }>
  | Readonly<{ state: "pin-required"; reason?: "expired" }>
  | Readonly<{ state: "not-found" }>
  | Readonly<{ state: "unavailable"; reason: SeePublicUnavailableReason }>;

export const SEE_PUBLIC_STATE_MESSAGES_CS = {
  "not-found": "Prezentace neexistuje nebo odkaz již neplatí.",
  paused: "Prezentace je dočasně pozastavená.",
  archived: "Prezentace byla archivována a již není dostupná.",
  unpublished: "Prezentace není zveřejněná.",
  expired: "Platnost přístupu vypršela. Zadejte PIN znovu.",
} as const;

/** Copy texts: link and PIN are deliberately two separate messages. */
export function invitationTexts(input: Readonly<{ projectName: string; url: string; mode: SeePublicationMode; pin?: string }>): Readonly<{ link: string; pin?: string }> {
  const link = input.mode === "pin"
    ? `Dobrý den,\nposíláme odkaz na 3D prezentaci „${input.projectName}“:\n${input.url}\n\nPrezentace je chráněná PINem, který vám pošleme zvlášť.`
    : `Dobrý den,\nposíláme odkaz na 3D prezentaci „${input.projectName}“:\n${input.url}`;
  return input.mode === "pin" && input.pin
    ? { link, pin: `PIN k 3D prezentaci „${input.projectName}“: ${input.pin}` }
    : { link };
}

export function embedSnippet(input: Readonly<{ url: string; width: string; height: string; title: string }>): string {
  const size = (value: string, fallback: string) => (/^\d{1,4}(px|%|vh)?$/u.test(value.trim()) ? (/^\d+$/u.test(value.trim()) ? `${value.trim()}px` : value.trim()) : fallback);
  const title = input.title.replace(/[<>"&]/gu, "");
  return `<iframe src="${input.url}" title="${title}" style="width:${size(input.width, "100%")};height:${size(input.height, "650px")};border:0;max-width:100%" allow="fullscreen" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}
