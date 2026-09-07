import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailGenerationPrompt, buildEmailRewritePrompt } from "../domain/emailAiPrompt.ts";
import { findEmailAiTone, findEmailAiRewriteAction } from "../domain/emailAiConfig.ts";

const NATURAL_TONE = findEmailAiTone("natural")!;

test("GENERATION PROMPT: instructs no fabrication of facts/dates/prices/names", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "posilam kalkulaci", promptLanguage: "English", tone: NATURAL_TONE });
  assert.match(prompt.system, /never invent or add facts/iu);
  assert.match(prompt.system, /dates.*prices.*names|prices|names/iu);
});

test("GENERATION PROMPT: names the target language and forbids literal word-for-word translation", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "dobry den", promptLanguage: "German", tone: NATURAL_TONE });
  assert.match(prompt.system, /German/u);
  assert.match(prompt.system, /never a literal, word-for-word translation/iu);
});

test("GENERATION PROMPT: the user's free text is carried through verbatim as the user message, never altered", () => {
  const freeText = "dobry den posilam kalkulaci oproti vizualu tam neni stolek";
  const prompt = buildEmailGenerationPrompt({ freeText, promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(prompt.user, freeText);
});

test("GENERATION PROMPT: tone instructionHint is included, and an optional template instruction is appended", () => {
  const formal = findEmailAiTone("formal")!;
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: formal, templateInstruction: "always mention this is a proforma invoice" });
  assert.match(prompt.system, new RegExp(formal.instructionHint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(prompt.system, /proforma invoice/u);
});

test("GENERATION PROMPT: requires JSON {subject, body} output", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.match(prompt.system, /"subject"/u);
  assert.match(prompt.system, /"body"/u);
});

test("REWRITE PROMPT: operates on the CURRENT subject/body, never re-mentions or requires the original free text", () => {
  const action = findEmailAiRewriteAction("shorten")!;
  const prompt = buildEmailRewritePrompt({ currentSubject: "Kalkulace stánku", currentBody: "Dobry den,\n\nposilam kalkulaci.", actionInstruction: action.instruction, promptLanguage: "English" });
  assert.match(prompt.user, /Kalkulace stánku/u);
  assert.match(prompt.user, /posilam kalkulaci/u);
  assert.match(prompt.system, new RegExp(action.instruction.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("REWRITE PROMPT: also forbids fabricating new facts and requires JSON output", () => {
  const action = findEmailAiRewriteAction("more-formal")!;
  const prompt = buildEmailRewritePrompt({ currentSubject: "s", currentBody: "b", actionInstruction: action.instruction, promptLanguage: "English" });
  assert.match(prompt.system, /never invent or add facts/iu);
  assert.match(prompt.system, /"subject"/u);
  assert.match(prompt.system, /"body"/u);
});

// =========================================================================================
// v1.2 — event context, recipient context (sections 2/3/5/6).
// =========================================================================================

test("GENERATION PROMPT: no event given -> no EVENT CONTEXT block at all (never invents an event)", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.doesNotMatch(prompt.system, /EVENT CONTEXT/u);
});

test("GENERATION PROMPT: event given -> includes exactly the given fields, omits absent ones, forbids inventing more", () => {
  const prompt = buildEmailGenerationPrompt({
    freeText: "x",
    promptLanguage: "English",
    tone: NATURAL_TONE,
    eventContext: { id: "evt-1", name: "FOR BEAUTY podzim 2026" },
  });
  assert.match(prompt.system, /EVENT CONTEXT/u);
  assert.match(prompt.system, /FOR BEAUTY podzim 2026/u);
  assert.match(prompt.system, /never invent or add any other event detail/iu);
  assert.doesNotMatch(prompt.system, /venue/iu, "no venue was given, so the word must not appear at all");
});

test("GENERATION PROMPT: event with dates and venue -> both appear in the event context line", () => {
  const prompt = buildEmailGenerationPrompt({
    freeText: "x",
    promptLanguage: "English",
    tone: NATURAL_TONE,
    eventContext: { id: "evt-1", name: "FOR ARCH", dateFrom: "2026-10-01", dateTo: "2026-10-03", venue: "PVA EXPO" },
  });
  assert.match(prompt.system, /2026-10-01/u);
  assert.match(prompt.system, /2026-10-03/u);
  assert.match(prompt.system, /PVA EXPO/u);
});

test("GENERATION PROMPT: no recipient given -> neutral greeting instruction, no name to invent", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.match(prompt.system, /RECIPIENT CONTEXT/u);
  assert.match(prompt.system, /No recipient name was given/iu);
});

test("GENERATION PROMPT: recipient given -> used verbatim, forbids inventing surname/title/gender/position/company", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "Czech", tone: NATURAL_TONE, recipientName: "paní Nováková" });
  assert.match(prompt.system, /paní Nováková/u);
  assert.match(prompt.system, /surname/iu);
  assert.match(prompt.system, /title/iu);
  assert.match(prompt.system, /gender/iu);
  assert.match(prompt.system, /job position/iu);
  assert.match(prompt.system, /company/iu);
});

test("GENERATION PROMPT: strengthened no-fabrication rule lists the v1.2 categories explicitly", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  for (const term of ["prices", "dates", "deadlines", "surnames", "companies", "phone numbers", "email addresses", "order numbers", "dimensions", "customer commitments"]) {
    assert.match(prompt.system, new RegExp(term, "iu"), `expected no-fabrication rule to mention "${term}"`);
  }
});

test("GENERATION PROMPT: event/recipient context never leaks into the user message — that stays the raw freeText", () => {
  const freeText = "posilam kalkulaci";
  const prompt = buildEmailGenerationPrompt({
    freeText,
    promptLanguage: "English",
    tone: NATURAL_TONE,
    eventContext: { id: "evt-1", name: "FOR BEAUTY" },
    recipientName: "Anna",
  });
  assert.equal(prompt.user, freeText);
});

// =========================================================================================
// Real-usage follow-up: additionalContext — structured facts (e.g. print-surfaces' A/B/C list)
// the model may reference for accuracy, but must not proactively dump into the email body.
// =========================================================================================

test("GENERATION PROMPT: additionalContext facts appear in the system prompt with an explicit 'do not list unless asked' instruction, never in the user message", () => {
  const freeText = "posilam podklady";
  const prompt = buildEmailGenerationPrompt({
    freeText, promptLanguage: "English", tone: NATURAL_TONE,
    additionalContext: ["A — Panel — 950 × 2340 mm", "B — Límec — 3000 × 300 mm"],
  });
  assert.match(prompt.system, /A — Panel — 950 × 2340 mm/u);
  assert.match(prompt.system, /B — Límec — 3000 × 300 mm/u);
  assert.match(prompt.system, /do NOT list them out item-by-item/iu);
  assert.equal(prompt.user, freeText);
});

test("GENERATION PROMPT: no additionalContext given -> no grounding block at all (never an empty/confusing section)", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.doesNotMatch(prompt.system, /ADDITIONAL AVAILABLE FACTS/u);
});

test("GENERATION PROMPT: an empty additionalContext array behaves the same as omitting it entirely", () => {
  const prompt = buildEmailGenerationPrompt({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE, additionalContext: [] });
  assert.doesNotMatch(prompt.system, /ADDITIONAL AVAILABLE FACTS/u);
});
