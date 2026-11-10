-- V1-SUPPORT-01: in-app support per HomeworkStudio application — guides / FAQ with version history
-- and comments, reports (bug / idea / question) with public replies, internal notes and history,
-- and private attachments.
--
-- Everything belongs to ONE application (hws_apps.key) and refers to shared accounts (app_users).
-- Who may read or write is decided by the API from the account's membership role in that
-- application (app_memberships) on every request; these tables are never exposed to the browser:
-- RLS on, no policies, no grants for anon/authenticated (like the rest of this schema).
-- Files live in the existing private R2 bucket under support/<app>/<attachment id>/…; the
-- database only references them. Rollback: supabase/rollback/20261111120000_app_support.down.sql

-- ---------------------------------------------------------------------------------------------
-- Articles (guides and FAQ) + versions + comments
-- ---------------------------------------------------------------------------------------------
create table support_articles (
  id uuid primary key default gen_random_uuid(),
  app_key text not null references hws_apps (key) on update cascade on delete restrict,
  kind text not null check (kind in ('guide', 'faq')),
  category text not null default '' check (length(category) <= 80),
  title text not null check (length(trim(title)) between 1 and 200),
  summary text not null default '' check (length(summary) <= 600),
  body text not null default '' check (length(body) <= 60000),
  area_keys text[] not null default '{}',
  -- an article for external users must be marked explicitly (default: internal only)
  for_external boolean not null default false,
  status text not null check (status in ('draft', 'published', 'archived')),
  sort_order integer not null default 0,
  version integer not null default 1 check (version >= 1),
  created_by uuid references app_users (id) on delete set null,
  updated_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index support_articles_app_idx on support_articles (app_key, status, sort_order);
comment on table support_articles is 'Guide / FAQ of one application. Members read published ones, externals only published ones marked for_external; managers (app admins) edit. version = current version number (optimistic concurrency).';

create table support_article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references support_articles (id) on delete cascade,
  version integer not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (article_id, version)
);
comment on table support_article_versions is 'Every saved version of an article (title, kind, category, summary, body, areas, audience, status, order). Restoring an old version creates a NEW version.';

create table support_article_comments (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references support_articles (id) on delete cascade,
  author_id uuid references app_users (id) on delete set null,
  kind text not null check (kind in ('comment', 'suggestion')),
  body text not null check (length(trim(body)) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  hidden boolean not null default false,
  moderated_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_article_comments_article_idx on support_article_comments (article_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Reports + messages (public replies / internal notes) + history
-- ---------------------------------------------------------------------------------------------
create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  app_key text not null references hws_apps (key) on update cascade on delete restrict,
  kind text not null check (kind in ('bug', 'idea', 'question')),
  subject text not null check (length(trim(subject)) between 1 and 160),
  description text not null check (length(trim(description)) between 1 and 8000),
  steps text check (steps is null or length(steps) <= 8000),
  expected text check (expected is null or length(expected) <= 8000),
  actual text check (actual is null or length(actual) <= 8000),
  status text not null default 'new' check (status in ('new', 'in_progress', 'waiting', 'resolved', 'closed')),
  author_id uuid references app_users (id) on delete set null,
  assignee_id uuid references app_users (id) on delete set null,
  -- optional; the API checked the author's access to the project when linking it
  project_id text references projects (id) on delete set null,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- double click / retried request of the same form = the same report
  unique (author_id, client_request_id)
);
create index support_tickets_app_status_idx on support_tickets (app_key, status, updated_at desc);
create index support_tickets_author_idx on support_tickets (author_id, updated_at desc);
comment on table support_tickets is 'Report of one application. Visible to its author and to the app managers. context = app, area, safe internal path, build, browser, window size (never tokens, form contents or URL parameters).';

create table support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets (id) on delete cascade,
  author_id uuid references app_users (id) on delete set null,
  -- internal notes are for app managers only (the API never returns them to anyone else)
  visibility text not null check (visibility in ('public', 'internal')),
  body text not null check (length(trim(body)) between 1 and 8000),
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  unique (author_id, client_request_id)
);
create index support_ticket_messages_ticket_idx on support_ticket_messages (ticket_id, created_at);

create table support_ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets (id) on delete cascade,
  actor_id uuid references app_users (id) on delete set null,
  type text not null check (type in ('created', 'status', 'reopened', 'assignee')),
  from_value text,
  to_value text,
  created_at timestamptz not null default now()
);
create index support_ticket_events_ticket_idx on support_ticket_events (ticket_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Attachments (files in the private R2 bucket)
-- ---------------------------------------------------------------------------------------------
create table support_attachments (
  id uuid primary key default gen_random_uuid(),
  app_key text not null references hws_apps (key) on update cascade on delete restrict,
  storage_key text not null unique check (storage_key like 'support/%'),
  file_name text not null check (length(file_name) between 1 and 200),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  size_bytes bigint not null check (size_bytes > 0),
  -- pending = upload slot issued; verified = object exists, real type and size checked; attached = part of saved content
  status text not null default 'pending' check (status in ('pending', 'verified', 'attached')),
  article_id uuid references support_articles (id) on delete cascade,
  ticket_id uuid references support_tickets (id) on delete cascade,
  message_id uuid references support_ticket_messages (id) on delete cascade,
  uploaded_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  constraint support_attachments_owner check (
    (status = 'attached') = (num_nonnulls(article_id, ticket_id) = 1)
    and (message_id is null or ticket_id is not null)
  )
);
create index support_attachments_pending_idx on support_attachments (status, created_at) where status <> 'attached';
create index support_attachments_article_idx on support_attachments (article_id) where article_id is not null;
create index support_attachments_ticket_idx on support_attachments (ticket_id) where ticket_id is not null;
comment on table support_attachments is 'Private file of an article or a report (message). Only attached files are served; cleanup removes pending / verified ones older than a day and never touches attached ones.';

create trigger support_articles_set_updated_at before update on support_articles for each row execute function set_updated_at();
create trigger support_article_comments_set_updated_at before update on support_article_comments for each row execute function set_updated_at();
create trigger support_tickets_set_updated_at before update on support_tickets for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Atomic writes (one transaction each: a rejected step leaves nothing behind)
-- ---------------------------------------------------------------------------------------------
-- Attaches verified uploads of p_uploader in p_app to the given owner; every id must qualify.
create function support_attach(p_app text, p_uploader uuid, p_ids uuid[], p_article uuid, p_ticket uuid, p_message uuid) returns void
language plpgsql as $$
declare
  ready integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  select count(*) into ready from support_attachments
  where id = any (p_ids) and app_key = p_app and uploaded_by = p_uploader and status = 'verified';
  if ready <> cardinality(array(select distinct unnest(p_ids))) then
    raise exception 'ATTACHMENT_NOT_READY: některá příloha není nahraná a ověřená.' using errcode = 'P0001';
  end if;
  update support_attachments
  set status = 'attached', article_id = p_article, ticket_id = p_ticket, message_id = p_message, attached_at = now()
  where id = any (p_ids);
end;
$$;

create function support_create_ticket(
  p_app text, p_author uuid, p_client_request_id uuid, p_kind text, p_subject text, p_description text,
  p_steps text, p_expected text, p_actual text, p_project_id text, p_context jsonb, p_attachment_ids uuid[]
) returns uuid
language plpgsql as $$
declare
  existing uuid;
  created uuid;
begin
  -- the same submission sent twice at once waits here and then finds the first one (no unique violation)
  perform pg_advisory_xact_lock(hashtextextended('support_ticket:' || p_author::text || ':' || p_client_request_id::text, 0));
  select id into existing from support_tickets where author_id = p_author and client_request_id = p_client_request_id;
  if existing is not null then
    return existing;
  end if;
  insert into support_tickets (app_key, kind, subject, description, steps, expected, actual, author_id, project_id, context, client_request_id)
  values (p_app, p_kind, trim(p_subject), p_description, nullif(p_steps, ''), nullif(p_expected, ''), nullif(p_actual, ''), p_author, p_project_id, coalesce(p_context, '{}'::jsonb), p_client_request_id)
  returning id into created;
  perform support_attach(p_app, p_author, p_attachment_ids, null, created, null);
  insert into support_ticket_events (ticket_id, actor_id, type, to_value) values (created, p_author, 'created', 'new');
  return created;
end;
$$;

-- A reply of the author to "Čeká na doplnění" moves the report back to "Řeší se".
create function support_add_message(
  p_ticket uuid, p_author uuid, p_client_request_id uuid, p_visibility text, p_body text, p_attachment_ids uuid[], p_author_is_reporter boolean
) returns uuid
language plpgsql as $$
declare
  existing uuid;
  created uuid;
  ticket_app text;
  ticket_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('support_message:' || p_author::text || ':' || p_client_request_id::text, 0));
  select id into existing from support_ticket_messages where author_id = p_author and client_request_id = p_client_request_id;
  if existing is not null then
    return existing;
  end if;
  select app_key, status into ticket_app, ticket_status from support_tickets where id = p_ticket for update;
  if ticket_app is null then
    raise exception 'TICKET_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into support_ticket_messages (ticket_id, author_id, visibility, body, client_request_id)
  values (p_ticket, p_author, p_visibility, p_body, p_client_request_id)
  returning id into created;
  perform support_attach(ticket_app, p_author, p_attachment_ids, null, p_ticket, created);
  if p_author_is_reporter and p_visibility = 'public' and ticket_status = 'waiting' then
    update support_tickets set status = 'in_progress' where id = p_ticket;
    insert into support_ticket_events (ticket_id, actor_id, type, from_value, to_value) values (p_ticket, p_author, 'status', 'waiting', 'in_progress');
  else
    update support_tickets set updated_at = now() where id = p_ticket;
  end if;
  return created;
end;
$$;

-- Status / assignee by a manager, guarded by updated_at; the assignee must be an ACTIVE admin of the app.
create function support_update_ticket(
  p_ticket uuid, p_actor uuid, p_expected_updated_at timestamptz, p_set_status boolean, p_status text, p_set_assignee boolean, p_assignee uuid
) returns boolean
language plpgsql as $$
declare
  current_row support_tickets%rowtype;
begin
  select * into current_row from support_tickets where id = p_ticket for update;
  if current_row.id is null or current_row.updated_at <> p_expected_updated_at then
    return false;
  end if;
  if p_set_assignee and p_assignee is not null and not exists (
    select 1 from app_memberships m join app_users u on u.id = m.user_id
    where m.user_id = p_assignee and m.app_key = current_row.app_key and m.role = 'admin' and u.is_active
  ) then
    raise exception 'INVALID_ASSIGNEE: řešitelem může být jen aktivní správce aplikace.' using errcode = 'P0001';
  end if;
  if p_set_status and p_status is distinct from current_row.status then
    update support_tickets set status = p_status where id = p_ticket;
    insert into support_ticket_events (ticket_id, actor_id, type, from_value, to_value)
    values (p_ticket, p_actor, case when current_row.status in ('resolved', 'closed') and p_status = 'in_progress' then 'reopened' else 'status' end, current_row.status, p_status);
  end if;
  if p_set_assignee and p_assignee is distinct from current_row.assignee_id then
    update support_tickets set assignee_id = p_assignee where id = p_ticket;
    insert into support_ticket_events (ticket_id, actor_id, type, from_value, to_value) values (p_ticket, p_actor, 'assignee', current_row.assignee_id::text, p_assignee::text);
  end if;
  return true;
end;
$$;

-- Creates (p_article null) or updates an article and stores the new version. p_expected_version
-- must match (no silent overwrite of a concurrent edit). Returns the article id, or null when stale.
create function support_save_article(
  p_article uuid, p_app text, p_actor uuid, p_expected_version integer, p_kind text, p_category text, p_title text,
  p_summary text, p_body text, p_area_keys text[], p_for_external boolean, p_status text, p_sort_order integer, p_attachment_ids uuid[]
) returns uuid
language plpgsql as $$
declare
  target uuid := p_article;
  next_version integer;
  previous_status text;
begin
  if target is null then
    insert into support_articles (app_key, kind, category, title, summary, body, area_keys, for_external, status, sort_order, created_by, updated_by, published_at)
    values (p_app, p_kind, p_category, trim(p_title), p_summary, p_body, p_area_keys, p_for_external, p_status, p_sort_order, p_actor, p_actor, case when p_status = 'published' then now() end)
    returning id, version into target, next_version;
  else
    select version, status into next_version, previous_status from support_articles where id = target and app_key = p_app for update;
    if next_version is null or next_version <> p_expected_version then
      return null;
    end if;
    next_version := next_version + 1;
    update support_articles set
      kind = p_kind, category = p_category, title = trim(p_title), summary = p_summary, body = p_body, area_keys = p_area_keys,
      for_external = p_for_external, status = p_status, sort_order = p_sort_order, version = next_version, updated_by = p_actor,
      published_at = case when p_status = 'published' and previous_status <> 'published' then now() else published_at end
    where id = target;
  end if;
  perform support_attach(p_app, p_actor, p_attachment_ids, target, null, null);
  insert into support_article_versions (article_id, version, snapshot, created_by)
  values (target, next_version, jsonb_build_object('kind', p_kind, 'category', p_category, 'title', trim(p_title), 'summary', p_summary, 'body', p_body,
    'areaKeys', to_jsonb(p_area_keys), 'forExternal', p_for_external, 'status', p_status, 'sortOrder', p_sort_order), p_actor);
  return target;
end;
$$;

revoke all on support_articles, support_article_versions, support_article_comments, support_tickets, support_ticket_messages, support_ticket_events, support_attachments from anon, authenticated;
alter table support_articles enable row level security;
alter table support_article_versions enable row level security;
alter table support_article_comments enable row level security;
alter table support_tickets enable row level security;
alter table support_ticket_messages enable row level security;
alter table support_ticket_events enable row level security;
alter table support_attachments enable row level security;
revoke all on function support_attach(text, uuid, uuid[], uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function support_create_ticket(text, uuid, uuid, text, text, text, text, text, text, text, jsonb, uuid[]) from public, anon, authenticated;
revoke all on function support_add_message(uuid, uuid, uuid, text, text, uuid[], boolean) from public, anon, authenticated;
revoke all on function support_update_ticket(uuid, uuid, timestamptz, boolean, text, boolean, uuid) from public, anon, authenticated;
revoke all on function support_save_article(uuid, text, uuid, integer, text, text, text, text, text, text[], boolean, text, integer, uuid[]) from public, anon, authenticated;
grant execute on function support_create_ticket(text, uuid, uuid, text, text, text, text, text, text, text, jsonb, uuid[]) to service_role;
grant execute on function support_add_message(uuid, uuid, uuid, text, text, uuid[], boolean) to service_role;
grant execute on function support_update_ticket(uuid, uuid, timestamptz, boolean, text, boolean, uuid) to service_role;
grant execute on function support_save_article(uuid, text, uuid, integer, text, text, text, text, text, text[], boolean, text, integer, uuid[]) to service_role;
