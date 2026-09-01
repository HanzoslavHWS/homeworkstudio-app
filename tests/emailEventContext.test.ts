import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailEventContext } from "../domain/emailEventContext.ts";
import { normalizeExhibition } from "../domain/organizations.ts";

test("EVENT CONTEXT: carries id/name and omits dateFrom/dateTo/venue entirely when not set", () => {
  const event = normalizeExhibition({ id: "evt-1", name: "FOR BEAUTY podzim 2026", year: 2026 });
  const context = buildEmailEventContext(event);
  assert.equal(context.id, "evt-1");
  assert.equal(context.name, "FOR BEAUTY podzim 2026");
  assert.equal(context.dateFrom, undefined);
  assert.equal(context.dateTo, undefined);
  assert.equal(context.venue, undefined);
});

test("EVENT CONTEXT: carries dateFrom/dateTo/venue when present", () => {
  const event = normalizeExhibition({ id: "evt-2", name: "FOR ARCH", year: 2026, eventFrom: "2026-10-01", eventTo: "2026-10-03", venue: "PVA EXPO" });
  const context = buildEmailEventContext(event);
  assert.equal(context.dateFrom, "2026-10-01");
  assert.equal(context.dateTo, "2026-10-03");
  assert.equal(context.venue, "PVA EXPO");
});

test("EVENT CONTEXT: never widens beyond the hand-enumerated fields — no pricing/contact/internal fields leak through", () => {
  const event = normalizeExhibition({ id: "evt-3", name: "FOR DECOR", year: 2026, priceListIds: ["price-list-1"], defaultCurrency: "CZK", importantInfo: "internal note never sent to AI" });
  const context = buildEmailEventContext(event);
  // Only id/name/dateFrom/dateTo/venue may ever be non-undefined on this type — verified both
  // structurally (the known key set) and by explicitly checking a few fields that must never leak.
  assert.deepEqual(Object.keys(context).sort(), ["dateFrom", "dateTo", "id", "name", "venue"]);
  assert.equal((context as unknown as Record<string, unknown>).priceListIds, undefined);
  assert.equal((context as unknown as Record<string, unknown>).importantInfo, undefined);
  assert.equal((context as unknown as Record<string, unknown>).defaultCurrency, undefined);
});

test("EVENT CONTEXT: JSON.stringify (the actual wire format) drops absent fields entirely, not just as undefined", () => {
  const event = normalizeExhibition({ id: "evt-4", name: "FOR BEAUTY", year: 2026 });
  const context = buildEmailEventContext(event);
  const wire = JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire).sort(), ["id", "name"]);
});
