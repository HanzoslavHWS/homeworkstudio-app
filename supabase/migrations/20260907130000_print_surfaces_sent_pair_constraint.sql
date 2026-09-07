-- Relaxes print_surface_projects' sent_at/sent_by pairing constraint.
--
-- The original constraint (20260906150000_print_surfaces.sql) required sent_at and sent_by to be
-- NULL/non-NULL together. That assumed a per-user identity would always be available to stamp
-- sent_by whenever a project is marked sent — but this app deliberately has no real per-user login
-- yet (one shared login — see lib/auth/session.ts), and the project's own convention is to leave
-- createdBy/sentBy nullable rather than invent a fake "shared-account" actor (see
-- domain/printSurfaceProject.ts's markPrintSurfaceProjectSent). In real usage sentBy is therefore
-- always NULL today, which the old constraint rejected on every "Potvrdit jako odesláno" — sent_at
-- alone must be a valid, common state.
--
-- The new invariant only forbids the nonsensical direction: a recorded sender without a recorded
-- send timestamp. sent_at with no sent_by (today's normal case) is valid; sent_by with no sent_at
-- never happens through this app's own code, but the constraint still guards against it — no
-- application-visible behavior otherwise depends on this file.
--
-- NOT applied to any live Supabase project by this migration file alone — apply manually
-- (e.g. `supabase db push` or the Supabase SQL editor) only after explicit review.

alter table print_surface_projects drop constraint print_surface_projects_sent_pair;

alter table print_surface_projects add constraint print_surface_projects_sent_pair
  check (sent_by is null or sent_at is not null);

comment on column print_surface_projects.sent_at is 'Only ever set by an explicit "mark as sent" action — never just because an Outlook draft or PDF preview was opened (spec section 14). May be set with sent_by left NULL — this app has no per-user login yet (one shared login), so that is the normal case today, not an error state.';
