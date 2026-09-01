import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OPENAI_TEXT_MODEL, OpenAiEmailAiProvider } from "../lib/ai/openaiEmailAiProvider.server.ts";
import { findEmailAiTone, findEmailAiRewriteAction } from "../domain/emailAiConfig.ts";

// =========================================================================================
// E-maily — the real OpenAI Chat Completions provider. No real network call ever happens in
// tests — `fetchImpl` is always a stub, matching this codebase's existing DI pattern (e.g.
// tests/openaiVisualizationAiProvider.test.ts).
// =========================================================================================

const NATURAL_TONE = findEmailAiTone("natural")!;

function openAiChatSuccessResponse(subject: string, body: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject, body }) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("DEFAULTS: model gpt-4o-mini", () => {
  assert.equal(DEFAULT_OPENAI_TEXT_MODEL, "gpt-4o-mini");
  const provider = new OpenAiEmailAiProvider("sk-test");
  assert.equal(provider.model, "gpt-4o-mini");
});

test("REQUEST SHAPE: sends model/response_format/messages as JSON, Authorization Bearer header, NEVER the key in the URL or body", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    capturedUrl = url;
    capturedInit = init;
    return openAiChatSuccessResponse("Re: Kalkulace", "Hello,\n\nplease find the calculation attached.\n\nBest regards");
  };
  const provider = new OpenAiEmailAiProvider("sk-super-secret-value", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "posilam kalkulaci", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, true);

  assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-super-secret-value");
  assert.doesNotMatch(capturedUrl, /sk-super-secret-value/u);

  const body = JSON.parse(capturedInit?.body as string) as { model: string; response_format: { type: string }; messages: readonly { role: string; content: string }[] };
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.messages[0]!.role, "system");
  assert.equal(body.messages[1]!.role, "user");
  assert.equal(body.messages[1]!.content, "posilam kalkulaci");
});

test("OUTPUT: parses the model's JSON content into {subject, body, model}", async () => {
  const fetchStub = async (): Promise<Response> => openAiChatSuccessResponse("Re: Kalkulace", "Dobry den,\n\nposilam kalkulaci.\n\nS pozdravem");
  const provider = new OpenAiEmailAiProvider("sk-test", { model: "gpt-custom", fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "Czech", tone: NATURAL_TONE });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.subject, "Re: Kalkulace");
  assert.match(result.body, /posilam kalkulaci/u);
  assert.equal(result.model, "gpt-custom");
});

test("REWRITE: sends the current subject/body as the user message and the action instruction in the system prompt", async () => {
  let capturedBody = "";
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedBody = init!.body as string;
    return openAiChatSuccessResponse("Kalkulace", "Shorter body.");
  };
  const provider = new OpenAiEmailAiProvider("sk-test", { fetchImpl: fetchStub });
  const action = findEmailAiRewriteAction("shorten")!;
  const result = await provider.rewriteEmail({ currentSubject: "Kalkulace", currentBody: "Original long body.", actionInstruction: action.instruction, promptLanguage: "English" });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(capturedBody) as { messages: readonly { role: string; content: string }[] };
  assert.match(parsed.messages[1]!.content, /Original long body\./u);
  assert.match(parsed.messages[0]!.content, /shorter/iu);
});

test("ERROR: network failure (fetch throws) -> provider-error, never throws out of generateEmail", async () => {
  const fetchStub = async (): Promise<Response> => { throw new Error("network down"); };
  const provider = new OpenAiEmailAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "provider-error");
});

test("ERROR: non-OK HTTP status -> provider-error", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 });
  const provider = new OpenAiEmailAiProvider("sk-bad-key", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "provider-error");
});

test("ERROR: missing message content -> invalid-response", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ choices: [{}] }), { status: 200 });
  const provider = new OpenAiEmailAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("ERROR: content is not the expected {subject, body} JSON shape -> invalid-response", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ foo: "bar" }) } }] }), { status: 200 });
  const provider = new OpenAiEmailAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("ERROR: content is not valid JSON at all -> invalid-response", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 });
  const provider = new OpenAiEmailAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("ERROR: malformed JSON response body -> invalid-response when HTTP was ok, provider-error when HTTP was not ok", async () => {
  const okButBadJson = async (): Promise<Response> => new Response("not json", { status: 200 });
  const providerA = new OpenAiEmailAiProvider("sk-test", { fetchImpl: okButBadJson });
  const resultA = await providerA.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(resultA.ok, false);
  assert.equal((resultA as { reason: string }).reason, "invalid-response");

  const errorAndBadJson = async (): Promise<Response> => new Response("not json", { status: 500 });
  const providerB = new OpenAiEmailAiProvider("sk-test", { fetchImpl: errorAndBadJson });
  const resultB = await providerB.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  assert.equal(resultB.ok, false);
  assert.equal((resultB as { reason: string }).reason, "provider-error");
});

test("NEVER LOGS THE API KEY: console.error calls made on error paths never include the raw key text", async () => {
  const originalError = console.error;
  const loggedArgs: unknown[] = [];
  console.error = (...args: unknown[]) => { loggedArgs.push(...args); };
  try {
    const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 });
    const provider = new OpenAiEmailAiProvider("sk-THIS-MUST-NEVER-BE-LOGGED", { fetchImpl: fetchStub });
    await provider.generateEmail({ freeText: "x", promptLanguage: "English", tone: NATURAL_TONE });
  } finally {
    console.error = originalError;
  }
  const serialized = loggedArgs.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
  assert.doesNotMatch(serialized, /sk-THIS-MUST-NEVER-BE-LOGGED/u);
});
