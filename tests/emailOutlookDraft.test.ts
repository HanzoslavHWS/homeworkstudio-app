import assert from "node:assert/strict";
import test from "node:test";
import { assertValidEmailOutlookDraftInput, EmailOutlookDraftRequestError } from "../domain/emailOutlookDraft.ts";
import { resolveOutlookDraftProvider } from "../lib/mail/outlookDraftProvider.server.ts";

// =========================================================================================
// Real-usage follow-up (spec sections 11/12): a clean, testable Outlook-draft boundary — always
// unavailable today (no Microsoft Graph/OAuth integration exists in this codebase), never a fake
// connection.
// =========================================================================================

test("RESOLUTION: resolveOutlookDraftProvider always returns undefined today — never throws, never fabricates a connection", () => {
  assert.equal(resolveOutlookDraftProvider({}), undefined);
  assert.equal(resolveOutlookDraftProvider({ SOME_UNRELATED_VAR: "1" }), undefined);
});

test("VALIDATION: a valid minimal input (subject + body) passes", () => {
  assert.doesNotThrow(() => assertValidEmailOutlookDraftInput({ subject: "Hello", body: "Text" }));
});

test("VALIDATION: missing/empty body is rejected", () => {
  assert.throws(() => assertValidEmailOutlookDraftInput({ subject: "Hello", body: "" }), EmailOutlookDraftRequestError);
  assert.throws(() => assertValidEmailOutlookDraftInput({ subject: "Hello" }), EmailOutlookDraftRequestError);
});

test("VALIDATION: a well-formed attachment (fileName/contentType/storageKey) passes", () => {
  assert.doesNotThrow(() => assertValidEmailOutlookDraftInput({
    subject: "Hello", body: "Text",
    attachments: [{ fileName: "Tiskove_plochy_X.pdf", contentType: "application/pdf", storageKey: "print-surfaces/p1/export/uuid.pdf" }],
  }));
});

test("VALIDATION: an attachment missing storageKey/fileName/contentType is rejected", () => {
  assert.throws(() => assertValidEmailOutlookDraftInput({ subject: "Hello", body: "Text", attachments: [{ fileName: "x.pdf" }] }), EmailOutlookDraftRequestError);
});

test("VALIDATION: not a JSON object at all is rejected", () => {
  assert.throws(() => assertValidEmailOutlookDraftInput("not an object"), EmailOutlookDraftRequestError);
  assert.throws(() => assertValidEmailOutlookDraftInput(null), EmailOutlookDraftRequestError);
});
