/**
 * V1-SUPPORT-01 — in-app support of one HomeworkStudio application: guides and FAQ, reports
 * (bug / idea / question) and their conversation. Pure: no I/O.
 *
 * Every article, report and attachment belongs to ONE application (hws_apps.key). Who may do what is
 * decided from the account's membership role IN THAT APPLICATION — the shared HomeworkStudio
 * administrator flag alone opens nothing here. Support is enabled per application; in this stage
 * only ABF Generator ("abf"), HWS Easy stays "Připravujeme".
 */
import type { AppRole } from "./accessControl.ts";

// ---------------------------------------------------------------------------------------------
// Applications and roles
// ---------------------------------------------------------------------------------------------
export const SUPPORT_APP_KEYS = ["abf"] as const;
export type SupportAppKey = (typeof SUPPORT_APP_KEYS)[number];

export function isSupportAppKey(value: unknown): value is SupportAppKey {
  return typeof value === "string" && (SUPPORT_APP_KEYS as readonly string[]).includes(value);
}

/** manager = administers the app's support; member = internal user; external = external user. */
export type SupportRole = "manager" | "member" | "external";

/** Membership role of the application → support role (ABF: Správce / Běžný / Externí). */
export function supportRoleOf(appKey: SupportAppKey, membershipRole: string | undefined): SupportRole | undefined {
  if (appKey === "abf") {
    const role = membershipRole as AppRole | undefined;
    if (role === "admin") return "manager";
    if (role === "user") return "member";
    if (role === "external") return "external";
  }
  return undefined;
}

export const canManageSupport = (role: SupportRole | undefined) => role === "manager";

// ---------------------------------------------------------------------------------------------
// Areas of the application (stable keys for contextual help)
// ---------------------------------------------------------------------------------------------
export const SUPPORT_AREAS = [
  { key: "abf.general", label: "Obecné", external: true },
  { key: "abf.projects", label: "Projekty a zakázky", external: true },
  { key: "abf.generator", label: "Generátor stánku", external: false },
  { key: "abf.catalog", label: "Katalog", external: false },
  { key: "abf.catalog.import", label: "Katalog — import Excelu", external: false },
  { key: "abf.prices", label: "Ceníky", external: false },
  { key: "abf.events", label: "Veletrhy", external: false },
  { key: "abf.companies", label: "Realizační firmy", external: false },
  { key: "abf.users", label: "Uživatelé a přiřazení", external: false },
  { key: "abf.tasks", label: "Úkoly", external: false },
  { key: "abf.emails", label: "E-maily", external: false },
  { key: "abf.technicalRasters", label: "Technické rastry", external: false },
  { key: "abf.printSurfaces", label: "Tiskové plochy", external: false },
  { key: "abf.settlement", label: "Kontrola vyúčtování", external: false },
  { key: "abf.support", label: "Nápověda a podpora", external: true },
] as const;
export type SupportAreaKey = (typeof SUPPORT_AREAS)[number]["key"];

export function isSupportAreaKey(value: unknown): value is SupportAreaKey {
  return typeof value === "string" && SUPPORT_AREAS.some((area) => area.key === value);
}
export const supportAreaLabel = (key: string) => SUPPORT_AREAS.find((area) => area.key === key)?.label ?? key;

/**
 * Area of the screen the user is on, from the ABF workspace location (section + admin route).
 * Used for contextual help and as the report's context — never a URL with parameters.
 */
export function abfAreaFor(location: Readonly<{ section: string; admin?: Readonly<{ area: string; tab?: string }> }>): SupportAreaKey {
  if (location.section === "admin" && location.admin) {
    const { area, tab } = location.admin;
    if (area === "catalog") return tab === "import" ? "abf.catalog.import" : "abf.catalog";
    if (area === "prices") return "abf.prices";
    if (area === "events") return "abf.events";
    if (area === "companies") return "abf.companies";
    if (area === "users") return "abf.users";
  }
  const bySection: Readonly<Record<string, SupportAreaKey>> = {
    project: "abf.generator",
    projects: "abf.projects",
    tasks: "abf.tasks",
    customerCatalog: "abf.catalog",
    emails: "abf.emails",
    printSurfaces: "abf.printSurfaces",
    technicalRasters: "abf.technicalRasters",
    settlementChecks: "abf.settlement",
    support: "abf.support",
  };
  return bySection[location.section] ?? "abf.general";
}

// ---------------------------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------------------------
export const ARTICLE_KINDS = ["guide", "faq"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export const ARTICLE_KIND_LABELS_CS: Readonly<Record<ArticleKind, string>> = { guide: "Návod", faq: "FAQ" };

export const ARTICLE_STATUSES = ["draft", "published", "archived"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];
export const ARTICLE_STATUS_LABELS_CS: Readonly<Record<ArticleStatus, string>> = { draft: "Koncept", published: "Publikováno", archived: "Archivováno" };

export type ArticleVisibility = Readonly<{ status: ArticleStatus; forExternal: boolean }>;

/**
 * May this role READ the article (and its attachments)? Managers read everything of their app
 * (drafts too, for editing); members read every published article; externals only published
 * articles explicitly marked for external users.
 */
export function canReadArticle(role: SupportRole | undefined, article: ArticleVisibility): boolean {
  if (role === "manager") return true;
  if (article.status !== "published") return false;
  if (role === "member") return true;
  if (role === "external") return article.forExternal;
  return false;
}

/** Comments and suggestions: on articles the user can read; hidden ones only for managers. */
export function canReadComment(role: SupportRole | undefined, comment: Readonly<{ hidden: boolean; authorId: string }>, userId: string): boolean {
  if (role === "manager") return true;
  return !comment.hidden && role !== undefined && (role !== "external" || comment.authorId === userId);
}

// ---------------------------------------------------------------------------------------------
// Article content: a small safe subset of Markdown, rendered without HTML from the author
// ---------------------------------------------------------------------------------------------
export type InlineNode = Readonly<{ type: "text"; text: string }> | Readonly<{ type: "strong"; text: string }> | Readonly<{ type: "em"; text: string }> | Readonly<{ type: "link"; text: string; href: string; external: boolean }>;
export type ContentBlock =
  | Readonly<{ type: "heading"; level: 2 | 3; inline: readonly InlineNode[] }>
  | Readonly<{ type: "paragraph"; inline: readonly InlineNode[] }>
  | Readonly<{ type: "list"; ordered: boolean; items: readonly (readonly InlineNode[])[] }>
  | Readonly<{ type: "image"; attachmentId: string; alt: string }>
  | Readonly<{ type: "video"; attachmentId: string; title: string }>
  | Readonly<{ type: "embed"; provider: "youtube" | "vimeo"; videoId: string; title: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Only https: links and internal paths ("/abf…", never "//host" or "javascript:"). */
export function safeHref(raw: string): Readonly<{ href: string; external: boolean }> | undefined {
  const value = raw.trim();
  if (/^\/(?![/\\])[^\s\u0000-\u001f]*$/u.test(value)) return { href: value, external: false };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return { href: url.toString(), external: true };
  } catch {
    return undefined;
  }
}

/** YouTube / Vimeo link → provider + id (the embed address is built by the app, never taken from the author). */
export function videoEmbedOf(raw: string): Readonly<{ provider: "youtube" | "vimeo"; videoId: string }> | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.replace(/^www\./u, "");
  let id: string | null = null;
  if (host === "youtube.com" || host === "m.youtube.com") id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:embed|shorts)\/([\w-]{11})$/u.exec(url.pathname)?.[1] ?? null;
  else if (host === "youtu.be") id = /^\/([\w-]{11})$/u.exec(url.pathname)?.[1] ?? null;
  if (id && /^[\w-]{11}$/u.test(id)) return { provider: "youtube", videoId: id };
  if (host === "vimeo.com") {
    const vimeo = /^\/(\d{6,12})$/u.exec(url.pathname)?.[1];
    if (vimeo) return { provider: "vimeo", videoId: vimeo };
  }
  return undefined;
}

export function embedUrl(provider: "youtube" | "vimeo", videoId: string): string {
  return provider === "youtube" ? `https://www.youtube-nocookie.com/embed/${videoId}` : `https://player.vimeo.com/video/${videoId}?dnt=1`;
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /\[([^\]]{1,200})\]\(([^)\s]{1,500})\)|\*\*([^*]{1,500})\*\*|_([^_]{1,500})_/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) nodes.push({ type: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) {
      const link = safeHref(match[2]!);
      nodes.push(link ? { type: "link", text: match[1], href: link.href, external: link.external } : { type: "text", text: match[1] });
    } else if (match[3] !== undefined) nodes.push({ type: "strong", text: match[3] });
    else nodes.push({ type: "em", text: match[4]! });
    last = match.index! + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

/**
 * Parses article text. Supported: "## " / "### " headings, "- " and "1. " lists, paragraphs,
 * [odkaz](https://… nebo /abf…), **tučně**, _kurzíva_, ![popis](příloha:<id>) image,
 * !video[popis](příloha:<id>) uploaded video, !video[popis](https://youtu.be/…) YouTube / Vimeo.
 * Anything else is plain text — HTML is never interpreted.
 */
export function parseArticleBody(source: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: InlineNode[][] } | undefined;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", ordered: list.ordered, items: list.items });
    list = undefined;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{2,3})\s+(.+)$/u.exec(line);
    const image = /^!\[([^\]]{0,200})\]\((?:příloha|attachment):([0-9a-f-]{36})\)$/u.exec(line);
    const video = /^!video\[([^\]]{0,200})\]\(([^)\s]+)\)$/u.exec(line);
    const bullet = /^[-*]\s+(.+)$/u.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1]!.length === 2 ? 2 : 3, inline: parseInline(heading[2]!) });
    } else if (image && UUID.test(image[2]!)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "image", attachmentId: image[2]!, alt: image[1]! });
    } else if (video) {
      flushParagraph();
      flushList();
      const attachment = /^(?:příloha|attachment):([0-9a-f-]{36})$/u.exec(video[2]!)?.[1];
      const embed = videoEmbedOf(video[2]!);
      if (attachment && UUID.test(attachment)) blocks.push({ type: "video", attachmentId: attachment, title: video[1]! });
      else if (embed) blocks.push({ type: "embed", ...embed, title: video[1]! });
      else blocks.push({ type: "paragraph", inline: [{ type: "text", text: line }] });
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline((bullet ?? numbered)![1]!));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Attachment ids referenced from the article text. */
export function referencedAttachmentIds(source: string): string[] {
  return [...new Set([...source.matchAll(/(?:příloha|attachment):([0-9a-f-]{36})/gu)].map((match) => match[1]!).filter((id) => UUID.test(id)))];
}

/** Plain text for search (no markup). */
export function articlePlainText(source: string): string {
  return source.replace(/!video\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)/gu, " ").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/[#*_>`-]/gu, " ").replace(/\s+/gu, " ").trim();
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function articleMatches(article: Readonly<{ title: string; summary: string; body: string; category: string }>, query: string, category = ""): boolean {
  if (category && article.category !== category) return false;
  // every word of the query, in any order, without diacritics
  const words = fold(query).split(/\s+/u).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold(`${article.title} ${article.summary} ${article.category} ${articlePlainText(article.body)}`);
  return words.every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------------------------------------
// Reports (hlášení)
// ---------------------------------------------------------------------------------------------
export const TICKET_KINDS = ["bug", "idea", "question"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const TICKET_KIND_LABELS_CS: Readonly<Record<TicketKind, string>> = { bug: "Chyba", idea: "Návrh na zlepšení", question: "Dotaz" };

export const TICKET_STATUSES = ["new", "in_progress", "waiting", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS_CS: Readonly<Record<TicketStatus, string>> = { new: "Nové", in_progress: "Řeší se", waiting: "Čeká na doplnění", resolved: "Vyřešené", closed: "Uzavřené" };

/** Status changes a manager may make. Resolved / closed can be reopened (→ Řeší se). */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ["in_progress", "waiting", "resolved", "closed"],
  in_progress: ["waiting", "resolved", "closed"],
  waiting: ["in_progress", "resolved", "closed"],
  resolved: ["in_progress", "closed"],
  closed: ["in_progress"],
};
export function canChangeStatus(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
export const isReopen = (from: TicketStatus, to: TicketStatus) => (from === "resolved" || from === "closed") && to === "in_progress";

/** Who may see a report: its author, or a manager of the app. */
export function canReadTicket(role: SupportRole | undefined, ticket: Readonly<{ authorId: string }>, userId: string): boolean {
  if (role === undefined) return false;
  return role === "manager" || ticket.authorId === userId;
}

/** Messages a viewer may see: internal notes only for managers. */
export function visibleMessages<T extends Readonly<{ visibility: "public" | "internal" }>>(role: SupportRole | undefined, messages: readonly T[]): T[] {
  return role === "manager" ? [...messages] : messages.filter((message) => message.visibility === "public");
}

export const SUBJECT_MAX = 160;
export const TEXT_MAX = 8000;

export type TicketDraft = Readonly<{ kind: TicketKind; subject: string; description: string; steps?: string; expected?: string; actual?: string }>;

export function ticketDraftProblem(draft: Partial<TicketDraft>): string | undefined {
  if (!draft.kind || !(TICKET_KINDS as readonly string[]).includes(draft.kind)) return "Zvolte druh hlášení.";
  if (!draft.subject?.trim()) return "Vyplňte předmět.";
  if (draft.subject.trim().length > SUBJECT_MAX) return `Předmět může mít nejvýš ${SUBJECT_MAX} znaků.`;
  if (!draft.description?.trim()) return "Vyplňte popis.";
  for (const field of [draft.description, draft.steps, draft.expected, draft.actual]) if ((field ?? "").length > TEXT_MAX) return `Text může mít nejvýš ${TEXT_MAX} znaků.`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Automatic context of a report — never tokens, passwords, form contents, projects or URL parameters
// ---------------------------------------------------------------------------------------------
export type ClientContext = Readonly<{ area: string; path: string; browser: string; viewport: string }>;

/** Only the path and the app's own hash route; query string and anything secret-looking removed. */
export function safeContextPath(pathname: string, hash = ""): string {
  const path = pathname.split("?")[0]!.slice(0, 200);
  const route = hash.split("?")[0]!.replace(/[^#/\w\-.]/gu, "").slice(0, 200);
  const cleaned = `${path}${route}`.replace(/(token|password|heslo|secret|key)[^/]*/giu, "…");
  return /^\/[\w\-./#…]*$/u.test(cleaned) ? cleaned : "/";
}

export function browserName(userAgent: string): string {
  const ua = userAgent.slice(0, 400);
  const pick = (name: string, pattern: RegExp) => {
    const version = pattern.exec(ua)?.[1];
    return version ? `${name} ${version.split(".")[0]}` : undefined;
  };
  const browser = pick("Edge", /Edg\/([\d.]+)/u) ?? pick("Opera", /OPR\/([\d.]+)/u) ?? pick("Firefox", /Firefox\/([\d.]+)/u) ?? pick("Chrome", /Chrome\/([\d.]+)/u) ?? pick("Safari", /Version\/([\d.]+).*Safari/u) ?? "Neznámý prohlížeč";
  const os = /Windows/u.test(ua) ? "Windows" : /Android/u.test(ua) ? "Android" : /iPhone|iPad/u.test(ua) ? "iOS" : /Mac OS X/u.test(ua) ? "macOS" : /Linux/u.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

export function sanitizeClientContext(value: unknown): ClientContext {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof input[key] === "string" ? (input[key] as string).slice(0, max) : "");
  const viewport = /^\d{2,5}×\d{2,5}$/u.test(text("viewport", 20)) ? text("viewport", 20) : "";
  return {
    area: isSupportAreaKey(input.area) ? (input.area as string) : "abf.general",
    // empty = the original page is unknown (a report form opened without its context) — never "/"
    path: !text("path", 300) ? "" : safeContextPath(text("path", 300).split("#")[0]!, text("path", 300).includes("#") ? `#${text("path", 300).split("#").slice(1).join("")}` : ""),
    browser: text("browser", 80).replace(/[^\w .·/-]/gu, ""),
    viewport,
  };
}

// ---------------------------------------------------------------------------------------------
// Attachments: limits and real content type (magic bytes), never active content
// ---------------------------------------------------------------------------------------------
export const ATTACHMENT_TYPES = {
  "image/png": { kind: "image", label: "PNG" },
  "image/jpeg": { kind: "image", label: "JPEG" },
  "image/webp": { kind: "image", label: "WebP" },
  "video/mp4": { kind: "video", label: "MP4" },
  "video/webm": { kind: "video", label: "WebM" },
} as const;
export type AttachmentMime = keyof typeof ATTACHMENT_TYPES;
export type AttachmentKind = "image" | "video";

export const SUPPORT_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  ticketAttachments: 8,
  ticketTotalBytes: 60 * 1024 * 1024,
  messageAttachments: 5,
  articleAttachments: 20,
} as const;

export const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);

export const LIMITS_TEXT_CS = `Obrázky PNG, JPEG nebo WebP do ${formatBytes(SUPPORT_LIMITS.imageBytes)}, videa MP4 nebo WebM do ${formatBytes(SUPPORT_LIMITS.videoBytes)}. Hlášení nejvýš ${SUPPORT_LIMITS.ticketAttachments} příloh a ${formatBytes(SUPPORT_LIMITS.ticketTotalBytes)} celkem.`;

export function isAttachmentMime(value: unknown): value is AttachmentMime {
  return typeof value === "string" && Object.hasOwn(ATTACHMENT_TYPES, value);
}

/** Declared file before upload: allowed type and within its limit. */
export function attachmentProblem(mime: unknown, size: unknown, fileName: unknown): string | undefined {
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 200) return "Neplatný název souboru.";
  if (/\.(svg|html?|xhtml|xml|js|mjs|exe|bat|cmd|ps1|php)$/iu.test(fileName)) return "Tento typ souboru není povolený (aktivní obsah).";
  if (!isAttachmentMime(mime)) return "Povolené jsou jen obrázky PNG, JPEG, WebP a videa MP4, WebM.";
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return "Soubor je prázdný.";
  const limit = ATTACHMENT_TYPES[mime].kind === "image" ? SUPPORT_LIMITS.imageBytes : SUPPORT_LIMITS.videoBytes;
  if (size > limit) return `Soubor je větší než ${formatBytes(limit)}.`;
  return undefined;
}

/** The real type from the first bytes of the stored object (not from the name or the browser). */
export function sniffAttachmentType(bytes: Uint8Array): AttachmentMime | undefined {
  const at = (index: number, ...values: number[]) => values.every((value, offset) => bytes[index + offset] === value);
  const ascii = (index: number, text: string) => [...text].every((char, offset) => bytes[index + offset] === char.charCodeAt(0));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) return "video/mp4";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return undefined;
}

export function safeFileName(name: string): string {
  const base = name.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\w.-]+/gu, "-").replace(/-+/gu, "-").replace(/^[-.]+/u, "").slice(-80);
  return base || "soubor";
}

// ---------------------------------------------------------------------------------------------
// Screenshot editing: applied to the pixels, so a redaction cannot be undone from the sent file
// ---------------------------------------------------------------------------------------------
export type Point = Readonly<{ x: number; y: number }>;
export type ImageEdit =
  | Readonly<{ type: "rect"; from: Point; to: Point }>
  | Readonly<{ type: "draw"; points: readonly Point[] }>
  | Readonly<{ type: "redact"; from: Point; to: Point }>;

export const MARK_COLOR = [220, 38, 38, 255] as const;
export const REDACT_COLOR = [0, 0, 0, 255] as const;

type Pixels = { data: Uint8ClampedArray | number[]; width: number; height: number };

function paint(image: Pixels, x: number, y: number, color: readonly number[]) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return;
  const offset = (py * image.width + px) * 4;
  for (let channel = 0; channel < 4; channel++) image.data[offset + channel] = color[channel]!;
}

function line(image: Pixels, from: Point, to: Point, color: readonly number[], thickness: number) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
  const half = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    for (let dx = -half; dx <= half; dx++) for (let dy = -half; dy <= half; dy++) paint(image, x + dx, y + dy, color);
  }
}

/** Applies the edits to RGBA pixels in place (rectangle outline, freehand line, opaque redaction). */
export function applyImageEdits(image: Pixels, edits: readonly ImageEdit[], thickness = 4): Pixels {
  for (const edit of edits) {
    if (edit.type === "redact") {
      const x0 = Math.max(0, Math.floor(Math.min(edit.from.x, edit.to.x)));
      const x1 = Math.min(image.width - 1, Math.ceil(Math.max(edit.from.x, edit.to.x)));
      const y0 = Math.max(0, Math.floor(Math.min(edit.from.y, edit.to.y)));
      const y1 = Math.min(image.height - 1, Math.ceil(Math.max(edit.from.y, edit.to.y)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(image, x, y, REDACT_COLOR);
    } else if (edit.type === "rect") {
      const corners = [edit.from, { x: edit.to.x, y: edit.from.y }, edit.to, { x: edit.from.x, y: edit.to.y }];
      for (let index = 0; index < 4; index++) line(image, corners[index]!, corners[(index + 1) % 4]!, MARK_COLOR, thickness);
    } else {
      for (let index = 1; index < edit.points.length; index++) line(image, edit.points[index - 1]!, edit.points[index]!, MARK_COLOR, thickness);
    }
  }
  return image;
}

export const hasRedaction = (edits: readonly ImageEdit[]) => edits.some((edit) => edit.type === "redact");

// ---------------------------------------------------------------------------------------------
// Cleanup of unfinished uploads (scripts/supportCleanup.ts)
// ---------------------------------------------------------------------------------------------
type CleanupRow = Readonly<{ id: string; status: string; createdAt: string; storageKey: string }>;

/**
 * Rows whose file may be deleted: only support/ keys; normally only uploads never attached to saved
 * content and older than the cutoff. `all` (rollback of the whole feature) takes every support file.
 */
export function selectCleanup<T extends CleanupRow>(rows: readonly T[], olderThan: Date, all: boolean): T[] {
  return rows.filter((row) => row.storageKey.startsWith("support/") && (all || (row.status !== "attached" && Date.parse(row.createdAt) < olderThan.getTime())));
}

// ---------------------------------------------------------------------------------------------
// E-mail notifications (V1-SUPPORT-02)
// ---------------------------------------------------------------------------------------------
export const NOTIFICATION_KINDS = ["new_ticket", "staff_reply", "waiting", "resolved", "author_reply"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationAudience = "author" | "manager";
export const NOTIFICATION_KIND_LABELS_CS: Readonly<Record<NotificationKind, string>> = {
  new_ticket: "Nové hlášení",
  staff_reply: "Odpověď správce",
  waiting: "Žádost o doplnění",
  resolved: "Vyřešeno",
  author_reply: "Odpověď autora",
};
export const NOTIFICATION_STATUS_LABELS_CS: Readonly<Record<string, string>> = { pending: "Čeká", sending: "Odesílá se", sent: "Odesláno", failed: "Selhalo", skipped: "Neodesláno" };

export type NotificationEvent =
  | Readonly<{ type: "created" }>
  | Readonly<{ type: "message"; visibility: "public" | "internal" }>
  | Readonly<{ type: "status"; to: TicketStatus }>;
export type PlannedNotification = Readonly<{ recipientId: string; kind: NotificationKind; audience: NotificationAudience }>;

/**
 * Who gets an e-mail about one event. Never the actor (no message about one's own action), never
 * anything about an internal note. New report → the app's managers. Public reply of someone other
 * than the author, a request for more information (Čeká na doplnění) or Vyřešené → the author. The
 * author's reply → the assignee when one is set (and is still a manager), otherwise the managers.
 */
export function planNotifications(input: Readonly<{ event: NotificationEvent; actorId: string; authorId: string | null; assigneeId: string | null; managerIds: readonly string[] }>): PlannedNotification[] {
  const { event, actorId, authorId, assigneeId, managerIds } = input;
  const toManagers = (kind: NotificationKind): PlannedNotification[] => [...new Set(managerIds)].filter((id) => id !== actorId).map((recipientId) => ({ recipientId, kind, audience: "manager" }));
  const toAuthor = (kind: NotificationKind): PlannedNotification[] => (authorId && authorId !== actorId ? [{ recipientId: authorId, kind, audience: "author" }] : []);
  if (event.type === "created") return toManagers("new_ticket");
  if (event.type === "status") return event.to === "waiting" ? toAuthor("waiting") : event.to === "resolved" ? toAuthor("resolved") : [];
  if (event.visibility === "internal") return [];
  if (authorId && actorId === authorId) {
    if (assigneeId && assigneeId !== actorId && managerIds.includes(assigneeId)) return [{ recipientId: assigneeId, kind: "author_reply", audience: "manager" }];
    return toManagers("author_reply");
  }
  return toAuthor("staff_reply");
}

/** Automatic retries after a failed send: 1, 5, 15, 60 and 240 minutes, then the message is given up. */
export const NOTIFICATION_RETRY_MINUTES = [1, 5, 15, 60, 240] as const;
export const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_MINUTES.length + 1;
export function nextNotificationAttempt(attempts: number, now: Date): Date | null {
  const minutes = NOTIFICATION_RETRY_MINUTES[attempts - 1];
  return attempts >= NOTIFICATION_MAX_ATTEMPTS || minutes === undefined ? null : new Date(now.getTime() + minutes * 60_000);
}

/** Checked again right before sending: the account is active and may still read the report in that role. */
export function mayReceiveNotification(input: Readonly<{ audience: NotificationAudience; role: SupportRole | undefined; isActive: boolean; isAuthor: boolean }>): boolean {
  if (!input.isActive || !input.role) return false;
  return input.audience === "manager" ? input.role === "manager" : input.isAuthor || input.role === "manager";
}
