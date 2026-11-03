-- V1-CATALOG: recommended parameters per catalog category ("Parametry komponenty").
--
-- Non-destructive, follows 20261023120000_catalog_categories: adds ONE column with an empty
-- default. No existing row, card or project is rewritten. A recommended parameter only offers an
-- optional field on cards of the category; its VALUE is stored in the card's existing parameter
-- list (document.attributes.extra, for services document.serviceTechnical.parameters) — never in
-- this table. System parameters (dimensions, colour, material, power kW) keep their structured
-- fields and cannot be defined here (validated in domain/catalogParameters.ts).
--
-- Shape of each element: { "id": text, "name": text, "valueType": "text" | "number",
--   "unit"?: text, "sortOrder": int, "isActive": bool }

alter table catalog_categories
  add column recommended_parameters jsonb not null default '[]'::jsonb
  check (jsonb_typeof(recommended_parameters) = 'array');

comment on column catalog_categories.recommended_parameters is 'Optional parameters offered on cards of this category (always optional in V1.0). Values live in the card document, never here. Deactivate (isActive=false) instead of removing so historical card values stay recognisable.';
