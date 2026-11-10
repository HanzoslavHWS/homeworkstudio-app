-- V1-SUPPORT-02 — e-mail notifications of in-app support (outbox).
--
-- One row = one message to one account about one event. The unique (event_key, recipient_id) makes a
-- repeated request (double click, retry after a lost answer) never queue a second message. The
-- recipient's e-mail address is NOT stored: it is read from app_users at sending time (the current
-- address of the account), after the recipient's access was checked again. Only the server
-- (service_role) touches this table.

create table support_notifications (
  id uuid primary key default gen_random_uuid(),
  app_key text not null references hws_apps (key) on update cascade on delete restrict,
  ticket_id uuid not null references support_tickets (id) on delete cascade,
  recipient_id uuid not null references app_users (id) on delete cascade,
  -- why the message exists: created:<ticket> · message:<message> · event:<ticket event>
  event_key text not null check (char_length(event_key) between 3 and 120),
  kind text not null check (kind in ('new_ticket', 'staff_reply', 'waiting', 'resolved', 'author_reply')),
  -- the recipient's role towards the report at queueing time (manager link vs. author link)
  audience text not null check (audience in ('author', 'manager')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz default now(),
  locked_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_key, recipient_id)
);
create index support_notifications_due_idx on support_notifications (next_attempt_at) where status in ('pending', 'failed', 'sending');
create index support_notifications_ticket_idx on support_notifications (ticket_id, created_at);
create trigger support_notifications_set_updated_at before update on support_notifications for each row execute function set_updated_at();
alter table support_notifications enable row level security;
revoke all on support_notifications from anon, authenticated;

-- Takes up to p_limit due messages (optionally only of the given tickets) for ONE sender: concurrent
-- senders skip each other's rows (no message is sent twice). A row stuck in "sending" (crashed
-- sender) becomes due again when its lock expires.
create function support_claim_notifications(p_limit integer, p_ticket_ids uuid[] default null)
returns setof support_notifications
language plpgsql as $$
begin
  return query
  update support_notifications n
     set status = 'sending', attempts = n.attempts + 1, locked_until = now() + interval '3 minutes'
   where n.id in (
     select c.id from support_notifications c
      where ((c.status in ('pending', 'failed') and c.next_attempt_at is not null and c.next_attempt_at <= now())
             or (c.status = 'sending' and c.locked_until < now()))
        and (p_ticket_ids is null or c.ticket_id = any (p_ticket_ids))
      order by c.next_attempt_at nulls last, c.created_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked)
  returning n.*;
end;
$$;

revoke all on function support_claim_notifications(integer, uuid[]) from public, anon, authenticated;
grant execute on function support_claim_notifications(integer, uuid[]) to service_role;
