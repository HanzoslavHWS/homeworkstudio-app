/**
 * HWS SEE rich content: the optional right-hand information panel (project-wide, optionally
 * overridden per model) and the extra fields of 3D annotations (image + link). Pure, no I/O.
 *
 * Safety: text is never HTML — it is parsed into plain blocks (paragraphs, bullet lists, **bold**)
 * and rendered by React, which escapes everything. Links accept only absolute https:// URLs;
 * http:// is allowed solely for localhost during local development.
 */

export type SeeLink = Readonly<{ label: string; url: string }>;

export type SeeInfoPanelContent = Readonly<{
  title: string;
  body: string;
  imageFileId?: string;
  links: readonly SeeLink[];
}>;

/** Project-wide panel. `enabled: false` hides the panel (and its trigger) everywhere. */
export type SeeProjectInfoPanel = SeeInfoPanelContent & Readonly<{ enabled: boolean }>;

export const SEE_PANEL_TITLE_MAX = 160;
export const SEE_PANEL_BODY_MAX = 6000;
export const SEE_PANEL_MAX_LINKS = 10;
export const SEE_LINK_LABEL_MAX = 80;
export const SEE_URL_MAX = 2000;
export const SEE_DEFAULT_LINK_LABEL = "Více informací";

export const EMPTY_PROJECT_INFO_PANEL: SeeProjectInfoPanel = { enabled: false, title: "", body: "", links: [] };

export type SeeUrlOptions = Readonly<{ allowLocalHttp: boolean }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// eslint-disable-next-line no-control-regex -- strip control characters except tab/newline
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(CONTROL, "").trim().slice(0, max) : "";
}

/** Why a link is not acceptable (Czech), or undefined when it is fine. */
export function linkProblem(value: unknown, options: SeeUrlOptions): string | undefined {
  if (typeof value !== "string" || !value.trim()) return "Odkaz je prázdný.";
  const raw = value.trim();
  if (raw.length > SEE_URL_MAX) return "Odkaz je příliš dlouhý.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Odkaz musí být celá adresa začínající https://";
  }
  if (url.username || url.password) return "Odkaz nesmí obsahovat přihlašovací údaje.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && options.allowLocalHttp && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return undefined;
  return "Povolené jsou jen odkazy začínající https:// (např. https://www.example.cz).";
}

/** Normalized absolute URL, or undefined when unsafe. */
export function safeExternalUrl(value: unknown, options: SeeUrlOptions): string | undefined {
  return linkProblem(value, options) ? undefined : new URL((value as string).trim()).href;
}

/** Lenient (stored data): invalid links are dropped, never thrown. */
export function normalizeLinks(value: unknown, options: SeeUrlOptions): readonly SeeLink[] {
  if (!Array.isArray(value)) return [];
  const links: SeeLink[] = [];
  for (const entry of value.slice(0, SEE_PANEL_MAX_LINKS)) {
    const url = safeExternalUrl((entry as { url?: unknown } | null)?.url, options);
    if (!url) continue;
    links.push({ label: text((entry as { label?: unknown }).label, SEE_LINK_LABEL_MAX) || SEE_DEFAULT_LINK_LABEL, url });
  }
  return links;
}

export function normalizeInfoPanelContent(value: unknown, options: SeeUrlOptions): SeeInfoPanelContent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const imageFileId = typeof input.imageFileId === "string" && UUID.test(input.imageFileId) ? input.imageFileId : undefined;
  return {
    title: text(input.title, SEE_PANEL_TITLE_MAX),
    body: typeof input.body === "string" ? input.body.replace(CONTROL, "").replace(/\r\n?/gu, "\n").slice(0, SEE_PANEL_BODY_MAX).trim() : "",
    ...(imageFileId ? { imageFileId } : {}),
    links: normalizeLinks(input.links, options),
  };
}

export function normalizeProjectInfoPanel(value: unknown, options: SeeUrlOptions): SeeProjectInfoPanel {
  const content = normalizeInfoPanelContent(value, options);
  if (!content) return EMPTY_PROJECT_INFO_PANEL;
  return { ...content, enabled: (value as { enabled?: unknown }).enabled === true };
}

export function isPanelContentEmpty(content: SeeInfoPanelContent | undefined): boolean {
  return !content || (!content.title && !content.body && !content.imageFileId && content.links.length === 0);
}

/**
 * Fallback rule (shown in the editor too):
 *   1. project panel switched off → no panel, no trigger;
 *   2. the model has its own non-empty content → that content;
 *   3. otherwise the shared project content, if non-empty;
 *   4. otherwise nothing (no trigger).
 */
export function resolveInfoPanel(project: SeeProjectInfoPanel | undefined, sceneOverride: SeeInfoPanelContent | undefined): SeeInfoPanelContent | undefined {
  if (!project?.enabled) return undefined;
  if (!isPanelContentEmpty(sceneOverride)) return sceneOverride;
  const shared: SeeInfoPanelContent = { title: project.title, body: project.body, links: project.links, ...(project.imageFileId ? { imageFileId: project.imageFileId } : {}) };
  return isPanelContentEmpty(shared) ? undefined : shared;
}

export type SeeTextSpan = Readonly<{ text: string; bold: boolean }>;
export type SeeTextBlock =
  | Readonly<{ type: "paragraph"; lines: readonly (readonly SeeTextSpan[])[] }>
  | Readonly<{ type: "list"; items: readonly (readonly SeeTextSpan[])[] }>;

function spans(line: string): readonly SeeTextSpan[] {
  const parts = line.split(/\*\*(.+?)\*\*/gu);
  return parts.map((part, index) => ({ text: part, bold: index % 2 === 1 })).filter((span) => span.text.length > 0);
}

/**
 * Minimal, HTML-free formatting: blank line = new paragraph, line break kept, lines starting with
 * "- " or "• " form a bullet list, **text** is bold. Anything else is plain text.
 */
export function parseRichText(value: string): readonly SeeTextBlock[] {
  const blocks: SeeTextBlock[] = [];
  for (const chunk of value.replace(/\r\n?/gu, "\n").split(/\n\s*\n/u)) {
    const lines = chunk.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    let paragraph: (readonly SeeTextSpan[])[] = [];
    let list: (readonly SeeTextSpan[])[] = [];
    const flushParagraph = () => {
      if (paragraph.length) blocks.push({ type: "paragraph", lines: paragraph });
      paragraph = [];
    };
    const flushList = () => {
      if (list.length) blocks.push({ type: "list", items: list });
      list = [];
    };
    for (const line of lines) {
      const bullet = line.match(/^\s*(?:[-•*])\s+(.*)$/u);
      if (bullet) {
        flushParagraph();
        list.push(spans(bullet[1]));
      } else {
        flushList();
        paragraph.push(spans(line.trim()));
      }
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}

/** Client-side defense in depth: render a stored link only if it is still a safe URL. */
export function renderableUrl(value: string | undefined): string | undefined {
  return value ? safeExternalUrl(value, { allowLocalHttp: true }) : undefined;
}
