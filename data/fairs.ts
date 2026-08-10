import type { Fair } from "../domain/models.ts";

export const fairs: readonly Fair[] = [
  {
    id: "for-beauty-autumn-2026",
    name: "FOR BEAUTY podzim 2026",
    priceList: "FOR BEAUTY podzim 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-beauty.png",
  },
  {
    id: "for-decor-2026",
    name: "FOR DECOR 2026",
    priceList: "FOR DECOR 2026",
    defaultCurrency: "CZK",
    logo: "/fairs/for-decor.png",
  },
  {
    id: "international-2026",
    name: "Zahraniční veletrh 2026",
    priceList: "INTERNATIONAL 2026",
    defaultCurrency: "EUR",
    logo: "/fairs/international.png",
  },
];
