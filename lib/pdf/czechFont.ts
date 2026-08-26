/**
 * Shared Unicode-font registration for every jsPDF document this app generates. jsPDF's built-in
 * Helvetica/Times/Courier fonts only support WinAnsi encoding — no č/ř/ě/ů/š/ž/etc. — which
 * garbled Czech text in the first Graphics Production Package v1 manifest.pdf (confirmed by
 * generating and visually inspecting a real PDF during that batch). Extracted out of
 * lib/graphicsProductionPdf.ts (Graphics Production Package v1) into its own module so
 * Visualization v2's presentation PDF can reuse the EXACT SAME embedded font — never a second
 * embed (see lib/fonts/graphicsProductionFont.ts for the subset/license details).
 */
import { NOTO_SANS_CZECH_BOLD_BASE64, NOTO_SANS_CZECH_REGULAR_BASE64 } from "../fonts/graphicsProductionFont.ts";

export const FONT_FAMILY = "NotoSansCzech";

/** Minimal jsPDF surface every PDF module in this app depends on — kept narrow and hand-typed since jsPDF ships no first-class TS types for its full API. */
export type PdfDoc = Readonly<{
  setFont: (name: string, style?: string) => void;
  setFontSize: (size: number) => number;
  text: (text: string | string[], x: number, y: number, options?: Readonly<{ align?: "left" | "center" | "right" }>) => void;
  setDrawColor: (r: number, g: number, b: number) => void;
  setLineWidth: (width: number) => void;
  rect: (x: number, y: number, w: number, h: number) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  addImage: (imageData: string, format: string, x: number, y: number, w: number, h: number) => void;
  addPage: () => void;
  addFileToVFS: (fileName: string, base64: string) => void;
  addFont: (fileName: string, fontName: string, style: string) => void;
  internal: { pageSize: { getWidth: () => number; getHeight: () => number } };
  output: (type: "arraybuffer") => ArrayBuffer;
}>;

/** Registers both weights of the embedded Czech-diacritics-capable font onto a fresh jsPDF document. Call once per document, before the first setFont(FONT_FAMILY, ...). */
export function registerCzechFont(doc: PdfDoc): void {
  doc.addFileToVFS("NotoSansCzech-Regular.ttf", NOTO_SANS_CZECH_REGULAR_BASE64);
  doc.addFont("NotoSansCzech-Regular.ttf", FONT_FAMILY, "normal");
  doc.addFileToVFS("NotoSansCzech-Bold.ttf", NOTO_SANS_CZECH_BOLD_BASE64);
  doc.addFont("NotoSansCzech-Bold.ttf", FONT_FAMILY, "bold");
}
