-- Print Surfaces V5 (spec section 11) — a "system" email template for handing a print-surfaces
-- PDF export off to the customer, seeded the SAME way every other system template already is
-- (see 20260901130000_email_templates_scope.sql) — never a second template/config mechanism, and
-- never literal email prose hardcoded into a React component. aiInstruction steers the EXISTING
-- AI generator (/api/emails/ai-generate); the actual CZ/EN wording is produced at generate time,
-- not stored verbatim here. The print-surfaces editor's "Do e-mailu / Outlooku" action preselects
-- this template by name (domain/printSurfaceEmailContext.ts's PRINT_SURFACE_EMAIL_TEMPLATE_NAME)
-- and seeds the free-text input with the concrete project/event/item facts
-- (buildPrintSurfaceEmailFreeText) — this row only carries the STANDING instruction + tone.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually only
-- after explicit review, same convention as every other migration in this repo.

insert into email_templates (name, scope, document) values
  (
    'Podklady k tiskovým plochám',
    'system',
    jsonb_build_object(
      'aiInstruction',
      'This email accompanies a sent PDF overview of print surfaces (tiskové plochy) for an exhibition booth — production dimensions for panels/fascia/counter/showcase graphics, plus artwork preparation guidance. Ask the recipient to review the production dimensions and the graphics-preparation instructions. Explicitly mention that the PDF overview is attached, since the sender attaches it manually before sending (this app cannot attach files automatically). Do not claim the files were already reviewed/approved.',
      'toneId', 'natural'
    )
  );
