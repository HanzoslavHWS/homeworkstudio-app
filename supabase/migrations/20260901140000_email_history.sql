-- E-maily v1.2 — history of actually-used emails (domain/emailHistory.ts). event_id is `text`,
-- not uuid, because events.id is `text primary key` (init_schema.sql). user_id is reserved for a
-- future per-user ownership feature — see email_templates_scope.sql's comment; always NULL today.

create table email_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  event_id text references events (id),
  event_name_snapshot text,
  recipient_name text,
  language text not null,
  tone text,
  subject text not null,
  body text not null,
  source_input text,
  template_id uuid references email_templates (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column email_history.user_id is 'Reserved for future per-user ownership. Always NULL today — no users table exists yet.';
comment on column email_history.event_name_snapshot is 'Stamped once at save time from the then-current event name — kept stable even if the event is later renamed.';

create trigger email_history_set_updated_at before update on email_history for each row execute function set_updated_at();
