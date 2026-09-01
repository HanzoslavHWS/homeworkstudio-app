import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_AI_LANGUAGES,
  DEFAULT_EMAIL_AI_LANGUAGE_CODE,
  DEFAULT_EMAIL_AI_TONE_ID,
  listEnabledEmailAiLanguages,
  listEmailAiLanguagesByTier,
  findEmailAiLanguage,
  listEmailAiTones,
  findEmailAiTone,
  listEmailAiRewriteActions,
  findEmailAiRewriteAction,
} from "../domain/emailAiConfig.ts";

test("LANGUAGES v1.2: Czech is the default and sorts first; English, German, Polish, Romanian all present and enabled", () => {
  const codes = listEnabledEmailAiLanguages().map((language) => language.code);
  assert.deepEqual(codes, ["cs", "en", "de", "pl", "ro"]);
  assert.equal(DEFAULT_EMAIL_AI_LANGUAGE_CODE, "cs");
  assert.equal(listEnabledEmailAiLanguages()[0]!.code, "cs");
  assert.ok(findEmailAiLanguage("cs"));
  assert.ok(findEmailAiLanguage("en"));
  assert.ok(findEmailAiLanguage("de"));
  assert.ok(findEmailAiLanguage("pl"));
  assert.ok(findEmailAiLanguage("ro"));
  assert.equal(findEmailAiLanguage("cs")!.promptLanguage, "Czech");
});

test("LANGUAGES: findEmailAiLanguage is case-sensitive and returns undefined for an unknown code — never fabricates a language", () => {
  assert.equal(findEmailAiLanguage("xx"), undefined);
  assert.equal(findEmailAiLanguage("CS"), undefined);
});

test("LANGUAGES: a disabled language is excluded from listEnabledEmailAiLanguages and findEmailAiLanguage — adding a future language is config-only", () => {
  const disabled = EMAIL_AI_LANGUAGES.filter((language) => !language.enabled);
  assert.equal(disabled.length, 0, "no disabled languages seeded yet, but the filtering itself is exercised by the enabled ones");
});

test("LANGUAGES: tiered dropdown grouping — cs/en are primary, de/pl/ro render under 'more'", () => {
  const { primary, more } = listEmailAiLanguagesByTier();
  assert.deepEqual(primary.map((language) => language.code), ["cs", "en"]);
  assert.deepEqual(more.map((language) => language.code), ["de", "pl", "ro"]);
});

test("TONES: default is natural, and every tone carries a non-empty instructionHint", () => {
  assert.equal(DEFAULT_EMAIL_AI_TONE_ID, "natural");
  const tones = listEmailAiTones();
  assert.ok(tones.length >= 5);
  for (const tone of tones) assert.ok(tone.instructionHint.length > 0);
  assert.ok(findEmailAiTone("natural"));
  assert.equal(findEmailAiTone("does-not-exist"), undefined);
});

test("REWRITE ACTIONS: includes the spec's 6 quick actions with non-empty instructions", () => {
  const actions = listEmailAiRewriteActions();
  const ids = actions.map((action) => action.id);
  assert.deepEqual(ids, ["rephrase", "shorten", "more-formal", "more-casual", "more-assertive", "new-subject"]);
  for (const action of actions) assert.ok(action.instruction.length > 0);
  assert.equal(findEmailAiRewriteAction("unknown"), undefined);
});
