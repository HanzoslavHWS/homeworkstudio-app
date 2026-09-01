-- E-maily — saved AI email templates ("Uložit jako vzor"). Globally shared (no per-user auth
-- exists anywhere in this app — see events/catalog_items, same model). document carries both the
-- optional sample free-text seed and the optional standing AI instruction, never just plain text.

create table email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column email_templates.document is 'EmailTemplate fields (freeText/aiInstruction/languageCode/toneId) — see domain/emailTemplate.ts.';

create trigger email_templates_set_updated_at before update on email_templates for each row execute function set_updated_at();
