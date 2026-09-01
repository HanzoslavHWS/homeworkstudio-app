/**
 * E-maily — single source of truth for AI languages/tones/rewrite actions. Adding a future
 * language or tone is exactly one new entry here — never a component/API-route change (both the
 * UI dropdowns and the API route's request validation read from these same arrays).
 */

export type EmailAiLanguage = Readonly<{
  code: string;
  label: string;
  /** English name of the language, sent to the model — never the UI label, which may itself be localized differently later. */
  promptLanguage: string;
  enabled: boolean;
  sortOrder: number;
  /** "primary" languages render outside any dropdown grouping; "more" languages render inside an <optgroup> — purely a UI grouping hint, never read by the API/prompt layer. */
  tier: "primary" | "more";
}>;

export const EMAIL_AI_LANGUAGES: readonly EmailAiLanguage[] = [
  { code: "cs", label: "Čeština", promptLanguage: "Czech", enabled: true, sortOrder: 0, tier: "primary" },
  { code: "en", label: "English", promptLanguage: "English", enabled: true, sortOrder: 1, tier: "primary" },
  { code: "de", label: "Deutsch", promptLanguage: "German", enabled: true, sortOrder: 2, tier: "more" },
  { code: "pl", label: "Polski", promptLanguage: "Polish", enabled: true, sortOrder: 3, tier: "more" },
  { code: "ro", label: "Română", promptLanguage: "Romanian", enabled: true, sortOrder: 4, tier: "more" },
];

export const DEFAULT_EMAIL_AI_LANGUAGE_CODE = "cs";

export function listEnabledEmailAiLanguages(): readonly EmailAiLanguage[] {
  return [...EMAIL_AI_LANGUAGES].filter((language) => language.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function findEmailAiLanguage(code: string): EmailAiLanguage | undefined {
  return EMAIL_AI_LANGUAGES.find((language) => language.code === code && language.enabled);
}

/** Splits the enabled, sorted list by tier — UI convenience for rendering primary options followed by an <optgroup>. */
export function listEmailAiLanguagesByTier(): Readonly<{ primary: readonly EmailAiLanguage[]; more: readonly EmailAiLanguage[] }> {
  const enabled = listEnabledEmailAiLanguages();
  return { primary: enabled.filter((language) => language.tier === "primary"), more: enabled.filter((language) => language.tier === "more") };
}

export type EmailAiTone = Readonly<{
  id: string;
  label: string;
  /** Instruction fragment inserted into the prompt (report neutral, never a fixed literal English string shown to the user). */
  instructionHint: string;
  sortOrder: number;
}>;

export const EMAIL_AI_TONE_OPTIONS: readonly EmailAiTone[] = [
  { id: "natural", label: "Natural", instructionHint: "Write in a natural, professional business tone — polished but not stiff.", sortOrder: 0 },
  { id: "formal", label: "Formal", instructionHint: "Write in a formal, businesslike tone — precise, respectful, no casual phrasing.", sortOrder: 1 },
  { id: "short", label: "Short", instructionHint: "Keep it as short and to the point as possible, while staying polite and complete.", sortOrder: 2 },
  { id: "friendly", label: "Friendly", instructionHint: "Write in a warm, friendly tone while remaining professional.", sortOrder: 3 },
  { id: "firm", label: "Firm", instructionHint: "Write in a firm, assertive tone — clear and direct, without being rude.", sortOrder: 4 },
];

export const DEFAULT_EMAIL_AI_TONE_ID = "natural";

export function listEmailAiTones(): readonly EmailAiTone[] {
  return [...EMAIL_AI_TONE_OPTIONS].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function findEmailAiTone(id: string): EmailAiTone | undefined {
  return EMAIL_AI_TONE_OPTIONS.find((tone) => tone.id === id);
}

export type EmailAiRewriteAction = Readonly<{
  id: string;
  label: string;
  /** Instruction fragment describing the requested edit, applied to the CURRENT result, never the original free text. */
  instruction: string;
  sortOrder: number;
}>;

export const EMAIL_AI_REWRITE_ACTIONS: readonly EmailAiRewriteAction[] = [
  { id: "rephrase", label: "Přeformulovat", instruction: "Rephrase the email body with different wording, keeping exactly the same meaning and facts.", sortOrder: 0 },
  { id: "shorten", label: "Zkrátit", instruction: "Make the email body noticeably shorter and more concise, keeping only the essential meaning and facts.", sortOrder: 1 },
  { id: "more-formal", label: "Více formální", instruction: "Make the tone more formal and businesslike.", sortOrder: 2 },
  { id: "more-casual", label: "Méně formální / přirozenější", instruction: "Make the tone more casual, natural and relaxed, while staying professional.", sortOrder: 3 },
  { id: "more-assertive", label: "Důraznější", instruction: "Make the tone more assertive and direct, without being rude.", sortOrder: 4 },
  { id: "new-subject", label: "Vytvořit nový předmět", instruction: "Keep the email body exactly as it is and only produce a new, different subject line that better reflects it.", sortOrder: 5 },
];

export function listEmailAiRewriteActions(): readonly EmailAiRewriteAction[] {
  return [...EMAIL_AI_REWRITE_ACTIONS].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function findEmailAiRewriteAction(id: string): EmailAiRewriteAction | undefined {
  return EMAIL_AI_REWRITE_ACTIONS.find((action) => action.id === id);
}
