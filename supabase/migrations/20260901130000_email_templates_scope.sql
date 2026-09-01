-- E-maily v1.2 — system vs. user template scope. "system" templates are seeded here and are
-- never editable/deletable through this app's API (lib/db/emailTemplateRepository.supabase.ts
-- enforces this at the repository layer, regardless of who's asking — see domain/emailTemplate.ts's
-- EmailTemplateProtectedError). user_id is reserved for a future per-user ownership feature: this
-- app has no per-user accounts yet (one shared login — lib/auth/session.ts), so it stays NULL for
-- every row today; adding it now avoids a breaking migration once real accounts exist.

alter table email_templates add column scope text not null default 'user' check (scope in ('system', 'user'));
alter table email_templates add column user_id uuid;

comment on column email_templates.scope is 'system = company-wide, seeded by migration, read-only via the API. user = freely created/edited/deleted.';
comment on column email_templates.user_id is 'Reserved for future per-user ownership. Always NULL today — no users table exists yet.';

insert into email_templates (name, scope, document) values
  ('Zaslání kalkulace', 'system', jsonb_build_object('aiInstruction', 'This email accompanies a sent price calculation/quote. Ask the recipient to check it and confirm whether everything is correct.', 'toneId', 'natural')),
  ('Potvrzení vizualizace', 'system', jsonb_build_object('aiInstruction', 'This email accompanies a sent visualization/design render. Ask the recipient to review it and confirm approval, or specify what should change.', 'toneId', 'natural')),
  ('Žádost o grafická data', 'system', jsonb_build_object('aiInstruction', 'This email requests graphic/artwork source files needed for production from the recipient.', 'toneId', 'friendly')),
  ('Žádost o technické podklady', 'system', jsonb_build_object('aiInstruction', 'This email requests missing technical information/specifications needed to proceed with the project from the recipient.', 'toneId', 'natural')),
  ('Urgence', 'system', jsonb_build_object('aiInstruction', 'This is a follow-up/reminder email about something still awaiting a reply or missing materials. Be clear and firm about the urgency without being rude.', 'toneId', 'firm')),
  ('Potvrzení objednávky', 'system', jsonb_build_object('aiInstruction', 'This email confirms that an order has been received/accepted.', 'toneId', 'formal')),
  ('Technické informace', 'system', jsonb_build_object('aiInstruction', 'This email communicates technical information or instructions to the recipient.', 'toneId', 'natural'));
