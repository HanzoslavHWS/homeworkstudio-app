-- Print Surfaces — PDF FINAL DESIGN + AI EMAIL WORKFLOW (this phase) — a "system" email template
-- for handing a print-surfaces PDF export off to the customer, seeded the SAME way every other
-- system template already is (see 20260901130000_email_templates_scope.sql) — never a second
-- template/config mechanism, and never literal email prose hardcoded into a React component.
-- aiInstruction steers the EXISTING AI generator (/api/emails/ai-generate); the actual CZ/EN
-- wording is produced at generate time, not stored verbatim here. The print-surfaces editor's
-- "Připravit e-mail" action preselects this template by name
-- (domain/printSurfaceEmailContext.ts's PRINT_SURFACE_EMAIL_TEMPLATE_NAME) and seeds the free-text
-- input with the concrete project/event/surface facts (buildPrintSurfaceEmailFreeText) — this row
-- only carries the STANDING instruction + tone.
--
-- Updated in this phase: the attached PDF no longer carries a general "graphics preparation
-- instructions" block (that was dropped from the document), so the instruction below no longer
-- references it — it only asks the recipient to prepare artwork to the listed production
-- dimensions themselves. A short subject-line nudge was also added (spec section 17) so the AI's
-- required JSON {"subject", "body"} output reliably names the event and company, e.g. "FOR BEAUTY
-- – tiskové podklady – Beauty Brand", without ever hardcoding a literal example event/company.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually only
-- after explicit review, same convention as every other migration in this repo.

insert into email_templates (name, scope, document) values
  (
    'Podklady k tiskovým plochám',
    'system',
    jsonb_build_object(
      'aiInstruction',
      'This email accompanies a PDF export of print surfaces (tiskove plochy) for an exhibition booth — a labeled overview of each surface (panel/fascia/counter/showcase) with its production (vyrobni) dimensions. Ask the recipient to prepare their artwork/graphics according to the listed production dimensions. Explicitly mention that the PDF overview is attached, since the sender attaches it manually before sending (this app cannot attach files automatically). Do not claim the files were already reviewed/approved, or that the email itself was already sent. Suggest a concise subject line naming the event and the company/project from the given facts, e.g. in the pattern "[Event] - tiskove podklady - [Company]" — never invent an event or company name that was not given.',
      'toneId', 'natural'
    )
  );
