import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFakeEmailAiProvider } from "../lib/ai/deterministicFakeEmailAiProvider.ts";
import { resolveEmailAiProvider } from "../lib/ai/emailAiProvider.server.ts";
import { DEFAULT_OPENAI_TEXT_MODEL, OpenAiEmailAiProvider } from "../lib/ai/openaiEmailAiProvider.server.ts";
import { findEmailAiTone, findEmailAiRewriteAction } from "../domain/emailAiConfig.ts";

const NATURAL_TONE = findEmailAiTone("natural")!;

test("RESOLUTION: resolveEmailAiProvider returns undefined by default — never throws, never fabricates a key", () => {
  const provider = resolveEmailAiProvider({});
  assert.equal(provider, undefined);
});

test("RESOLUTION: the fake provider is enabled only via the explicit non-secret dev opt-in flag", () => {
  const provider = resolveEmailAiProvider({ AI_EMAIL_USE_FAKE_PROVIDER: "1" });
  assert.ok(provider);
  assert.equal(provider?.id, "deterministic-fake");
});

test("RESOLUTION: OPENAI_API_KEY present -> the real OpenAI provider with the default text model", () => {
  const provider = resolveEmailAiProvider({ OPENAI_API_KEY: "sk-test-key" });
  assert.ok(provider);
  assert.equal(provider?.id, "openai");
  assert.ok(provider instanceof OpenAiEmailAiProvider);
  assert.equal((provider as OpenAiEmailAiProvider).model, DEFAULT_OPENAI_TEXT_MODEL);
});

test("RESOLUTION: OPENAI_TEXT_MODEL overrides the default when OPENAI_API_KEY is present", () => {
  const provider = resolveEmailAiProvider({ OPENAI_API_KEY: "sk-test-key", OPENAI_TEXT_MODEL: "gpt-custom" });
  assert.equal((provider as OpenAiEmailAiProvider).model, "gpt-custom");
});

test("RESOLUTION: OPENAI_API_KEY takes priority over the fake-provider opt-in flag when both are set", () => {
  const provider = resolveEmailAiProvider({ OPENAI_API_KEY: "sk-test-key", AI_EMAIL_USE_FAKE_PROVIDER: "1" });
  assert.equal(provider?.id, "openai");
});

test("DETERMINISM: identical input produces identical output across repeated calls", async () => {
  const provider = new DeterministicFakeEmailAiProvider();
  const input = { freeText: "posilam kalkulaci", promptLanguage: "English", tone: NATURAL_TONE };
  const a = await provider.generateEmail(input);
  const b = await provider.generateEmail(input);
  assert.deepEqual(a, b);
});

test("OUTPUT: generateEmail returns a non-empty subject/body and echoes the free text (fake provider never fabricates facts either)", async () => {
  const provider = new DeterministicFakeEmailAiProvider();
  const result = await provider.generateEmail({ freeText: "posilam kalkulaci oproti vizualu", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.ok(result.subject.length > 0);
  assert.match(result.body, /posilam kalkulaci oproti vizualu/u);
});

test("REWRITE: rewriteEmail keeps the given subject/body and applies the requested action", async () => {
  const provider = new DeterministicFakeEmailAiProvider();
  const action = findEmailAiRewriteAction("shorten")!;
  const result = await provider.rewriteEmail({ currentSubject: "Kalkulace", currentBody: "Puvodni text.", actionInstruction: action.instruction, promptLanguage: "English" });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.subject, "Kalkulace");
  assert.match(result.body, /Puvodni text\./u);
});
