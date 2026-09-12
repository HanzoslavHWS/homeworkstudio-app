import type { Fair } from "../domain/models.ts";

// CORRECTIVE BATCH — event-ID consistency audit. `id` mirrors data/organizations.ts's own
// `exhibitions` (the real canonical Supabase `events.id` per exhibition brand) — see
// domain/eventIdentity.ts's own doc. `name`/`priceList`/`logo` stay purely descriptive.
export const fairs: readonly Fair[] = [
  {
    id: "beauty",
    name: "FOR BEAUTY podzim 2026",
    priceList: "FOR BEAUTY podzim 2026",
    defaultCurrency: "CZK",
    logo: "/events/for-beauty-podzim-2026/logo.png",
  },
  {
    id: "decor",
    name: "FOR DECOR 2026",
    priceList: "FOR DECOR 2026",
    defaultCurrency: "CZK",
    logo: "/events/for-decor-2026/logo.png",
  },
  {
    // No confirmed production counterpart — see data/organizations.ts's own matching entry.
    id: "international-2026",
    name: "Zahraniční veletrh 2026",
    priceList: "INTERNATIONAL 2026",
    defaultCurrency: "EUR",
    logo: "/events/international-2026/logo.png",
  },
];
