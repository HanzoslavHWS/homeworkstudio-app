/**
 * Visualization v3 — deterministic fake AI provider. No real provider exists in this repo yet
 * (confirmed by audit: zero AI SDK/client anywhere). This produces a genuinely valid, decodable
 * PNG — never a stub string — so the full pipeline (resize, compositing, validation) can be
 * exercised end-to-end without a network call or a real API key. Output is byte-identical for
 * identical input (seeded, not random) so tests can assert exact equality across repeated calls.
 */
import { encodeRgbaToPng, pngBytesToDataUrl } from "./pngEncoder.ts";
import type {
  VisualizationAiCapabilities,
  VisualizationAiGenerateInput,
  VisualizationAiGenerateResult,
  VisualizationAiProvider,
} from "./visualizationAiProvider.server.ts";

const PRESET_BASE_COLOR: Readonly<Record<string, Readonly<{ r: number; g: number; b: number }>>> = {
  "clean-hall": { r: 235, g: 235, b: 240 },
  "modern-hall": { r: 210, g: 215, b: 225 },
  "light-studio": { r: 245, g: 243, b: 238 },
};

const LIGHTING_TINT: Readonly<Record<string, Readonly<{ r: number; g: number; b: number }>>> = {
  neutral: { r: 0, g: 0, b: 0 },
  warm: { r: 18, g: 8, b: -12 },
  cool: { r: -12, g: -4, b: 16 },
};

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small seeded PRNG (mulberry32) — deterministic across runs/platforms, no external dependency. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export class DeterministicFakeAiProvider implements VisualizationAiProvider {
  readonly id = "deterministic-fake";
  readonly capabilities: VisualizationAiCapabilities = {
    supportsMask: false,
    supportsMultipleReferenceImages: false,
    supportsTransparentInput: false,
    supportedAspectRatios: ["1:1", "4:3", "16:9", "3:2"],
    maxInputSize: { widthPx: 1024, heightPx: 1024 },
  };

  async generateEnvironment(input: VisualizationAiGenerateInput): Promise<VisualizationAiGenerateResult> {
    if (input.widthPx <= 0 || input.heightPx <= 0) return { ok: false, reason: "invalid-response" };

    const base = PRESET_BASE_COLOR[input.environmentPreset] ?? PRESET_BASE_COLOR["clean-hall"]!;
    const tint = LIGHTING_TINT[input.lightingPreset] ?? LIGHTING_TINT.neutral!;
    const seedText = `${input.environmentPreset}|${input.peoplePreset}|${input.lightingPreset}|${input.widthPx}x${input.heightPx}`;
    const random = mulberry32(hashSeed(seedText));

    const width = input.widthPx;
    const height = input.heightPx;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const verticalShade = 1 - (y / height) * 0.25; // subtle floor-to-ceiling gradient, a cheap stand-in for hall lighting falloff
      for (let x = 0; x < width; x++) {
        const grain = (random() - 0.5) * 6;
        const offset = (y * width + x) * 4;
        rgba[offset] = clampByte((base.r + tint.r) * verticalShade + grain);
        rgba[offset + 1] = clampByte((base.g + tint.g) * verticalShade + grain);
        rgba[offset + 2] = clampByte((base.b + tint.b) * verticalShade + grain);
        rgba[offset + 3] = 255;
      }
    }

    const png = encodeRgbaToPng(width, height, rgba);
    return {
      ok: true,
      environmentImageDataUrl: pngBytesToDataUrl(png),
      widthPx: width,
      heightPx: height,
      model: "deterministic-fake-v1",
    };
  }
}
