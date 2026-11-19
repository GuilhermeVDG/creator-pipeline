-- creator-pipeline: initial schema (docs/spec.md sections 2, 3.1 and 4).
-- Apply once. The Supabase SQL editor and CLI both run a migration as a single
-- transaction, so a failure leaves nothing half-created.

-- ---------------------------------------------------------------------------
-- Tables

create table public.creators (
  id                    uuid        primary key,
  name                  text        not null,
  email                 text        not null,
  handle                text,
  status                text        not null check (status in ('signed_up', 'app_installed', 'live')),
  -- Earliest occurred_at among recorded events for the current status.
  last_step_at          timestamptz not null,
  -- Reset to null only when status changes.
  stuck_alert_sent_at   timestamptz,
  -- Earliest occurred_at among recorded signup events.
  onboarding_started_at timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Case-insensitive uniqueness for the 409 rule. Postgres lower() under the
-- database collation is the source of truth. The function below matches
-- violations of this index by name.
create unique index creators_email_lower_key on public.creators (lower(email));

-- Matches the cron's where clause.
create index creators_stuck_idx on public.creators (last_step_at)
  where status <> 'live' and stuck_alert_sent_at is null;

create table public.webhook_events (
  event_id    text        primary key,  -- idempotency key
  -- No foreign key: events can arrive before the creator exists (pending).
  creator_id  uuid        not null,
  step        text        not null check (step in ('signup', 'app_installed', 'payment_done')),
  occurred_at timestamptz not null,
  payload     jsonb       not null,
  received_at timestamptz not null default now()
);

-- Used to reconcile pending events when signup creates the creator.
create index webhook_events_creator_id_idx on public.webhook_events (creator_id);

-- Only the service role (which bypasses RLS) may touch these tables. RLS with
-- no policies denies anon and authenticated, and we revoke their grants too.
alter table public.creators enable row level security;
alter table public.webhook_events enable row level security;
revoke all on table public.creators, public.webhook_events from public, anon, authenticated;
-- Explicit least privilege for the service role, instead of relying on the
-- project's default privileges: no delete or truncate.
revoke all on table public.creators, public.webhook_events from service_role;
grant select, insert, update on table public.creators to service_role;
grant select, insert on table public.webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- Status helpers, in a schema PostgREST doesn't expose (not callable over
-- the API). The service role needs usage on it because the functions below
-- run as the caller.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- Mirror STEP_STATUS and STATUS_RANK in
-- src/lib/creators/transitions.ts; the shared transition table keeps them in sync.

create function private.onboarding_step_status(p_step text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_step
    when 'signup'        then 'signed_up'
    when 'app_installed' then 'app_installed'
    when 'payment_done'  then 'live'
  end
$$;

create function private.onboarding_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'signed_up'     then 1
    when 'app_installed' then 2
    when 'live'          then 3
  end
$$;

-- ---------------------------------------------------------------------------
-- process_onboarding_event (spec 3.1)
--
-- Returns jsonb (not a table type) so output names can't clash with column
-- names inside plpgsql:
--   { "result": "duplicate" | "pending" | "email_conflict" }
--   { "result": "processed", "became_live": false }
--   { "result": "processed", "became_live": true, "name", "handle",
--     "onboarding_started_at", "live_at" }

create function public.process_onboarding_event(
  p_event_id    text,
  p_creator_id  uuid,
  p_step        text,
  p_occurred_at timestamptz,
  p_payload     jsonb,
  p_name        text default null,
  p_email       text default null,
  p_handle      text default null
)
returns jsonb
language plpgsql
volatile
set search_path = ''
-- jsonb timestamps always come out as +00:00, whatever the database timezone.
set timezone = 'UTC'
-- A stuck transaction holding this creator's lock fails fast (500, sender
-- retries) instead of hanging until the function times out.
set lock_timeout = '5s'
as $$
declare
  v_new_status text := private.onboarding_step_status(p_step);
  v_inserted   integer;
  v_best_step  text;
  v_best_at    timestamptz;
  v_row        public.creators%rowtype;
  v_constraint text;
begin
  if v_new_status is null then
    raise exception 'invalid step' using errcode = '22023';
  end if;
  if p_step = 'signup' and (p_name is null or p_email is null) then
    raise exception 'signup requires name and email' using errcode = '22023';
  end if;

  -- 0. Per-creator lock, held until commit or rollback. Taken outside the
  --    block below so it stays held even when the block rolls back.
  perform pg_advisory_xact_lock(hashtext(p_creator_id::text));

  -- Everything below runs in one subtransaction (deliberately the whole body),
  -- so an email conflict rolls back the event insert as well: the event is not
  -- recorded. Narrowing the block would need a compensating delete instead.
  -- The cost is one subtransaction per call, fine at our volume.
  begin
    -- 1. Idempotency: the event_id primary key.
    insert into public.webhook_events (event_id, creator_id, step, occurred_at, payload)
    values (p_event_id, p_creator_id, p_step, p_occurred_at, p_payload)
    on conflict (event_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      return jsonb_build_object('result', 'duplicate');
    end if;

    -- Existence only; under the lock no other event for this creator can
    -- change it. No column value from here is reused below.
    if not exists (select 1 from public.creators c where c.id = p_creator_id) then
      -- 3. Non-signup before signup: stored, pending.
      if p_step <> 'signup' then
        return jsonb_build_object('result', 'pending');
      end if;

      -- 2. Signup creates the creator, reconciled from every stored event
      --    for it (including this one): rank desc, occurred_at asc.
      select e.step, e.occurred_at
        into v_best_step, v_best_at
        from public.webhook_events e
       where e.creator_id = p_creator_id
       order by private.onboarding_status_rank(private.onboarding_step_status(e.step)) desc,
                e.occurred_at asc
       limit 1;

      insert into public.creators
        (id, name, email, handle, status, last_step_at, stuck_alert_sent_at, onboarding_started_at)
      values
        (p_creator_id, p_name, p_email, p_handle,
         private.onboarding_step_status(v_best_step), v_best_at, null, p_occurred_at)
      returning * into v_row;

      if v_row.status = 'live' then
        return jsonb_build_object(
          'result', 'processed',
          'became_live', true,
          'name', v_row.name,
          'handle', v_row.handle,
          'onboarding_started_at', v_row.onboarding_started_at,
          'live_at', v_row.last_step_at  -- the earliest stored payment_done
        );
      end if;
      return jsonb_build_object('result', 'processed', 'became_live', false);
    end if;

    -- 4a. Status change: higher rank only.
    update public.creators c
       set status = v_new_status,
           last_step_at = p_occurred_at,
           stuck_alert_sent_at = null,
           updated_at = now()
     where c.id = p_creator_id
       and private.onboarding_status_rank(c.status) < private.onboarding_status_rank(v_new_status)
    returning * into v_row;

    if not found then
      -- 4b. Time correction: equal rank (never <=) and earlier. Never touches
      --     status or stuck_alert_sent_at.
      update public.creators c
         set last_step_at = p_occurred_at,
             updated_at = now()
       where c.id = p_creator_id
         and private.onboarding_status_rank(c.status) = private.onboarding_status_rank(v_new_status)
         and p_occurred_at < c.last_step_at;
    end if;

    -- 4c. Signup only: onboarding start correction (earliest wins, any status).
    --     signup has rank 1, so 4a can never fire for it: v_row is null whenever
    --     4c runs, and the onboarding_started_at returned from 4a is current.
    if p_step = 'signup' then
      update public.creators c
         set onboarding_started_at = p_occurred_at,
             updated_at = now()
       where c.id = p_creator_id
         and p_occurred_at < c.onboarding_started_at;
    end if;

    -- v_row is set only when 4a changed the status.
    if v_row.id is not null and v_row.status = 'live' then
      return jsonb_build_object(
        'result', 'processed',
        'became_live', true,
        'name', v_row.name,
        'handle', v_row.handle,
        'onboarding_started_at', v_row.onboarding_started_at,
        'live_at', p_occurred_at
      );
    end if;
    return jsonb_build_object('result', 'processed', 'became_live', false);

  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      -- Only the email index is a conflict. Anything else (e.g. a primary
      -- key) is a bug and must surface as an error, never as a 409.
      if v_constraint = 'creators_email_lower_key' then
        return jsonb_build_object('result', 'email_conflict');
      end if;
      raise;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_stuck_creators (spec section 4)
--
-- One atomic statement: overlapping runs can't double-alert, and each where is
-- re-checked against the latest row version, so a creator who moves forward
-- at the same moment isn't marked for the new step.

create function public.claim_stuck_creators(p_min_hours integer default 48)
returns jsonb
language sql
volatile
set search_path = ''
set timezone = 'UTC'
as $$
  with claimed as (
    update public.creators c
       set stuck_alert_sent_at = now()
     where c.status <> 'live'
       and c.stuck_alert_sent_at is null
       and c.last_step_at < now() - make_interval(hours => p_min_hours)
    returning c.id, c.name, c.handle, c.status, c.last_step_at
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', claimed.id,
        'name', claimed.name,
        'handle', claimed.handle,
        'status', claimed.status,
        'last_step_at', claimed.last_step_at
      )
      order by claimed.last_step_at
    ),
    '[]'::jsonb
  )
  from claimed
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: callable only by the service role.

revoke all on function private.onboarding_step_status(text) from public, anon, authenticated;
revoke all on function private.onboarding_status_rank(text) from public, anon, authenticated;
revoke all on function public.process_onboarding_event(text, uuid, text, timestamptz, jsonb, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_stuck_creators(integer) from public, anon, authenticated;

grant execute on function private.onboarding_step_status(text) to service_role;
grant execute on function private.onboarding_status_rank(text) to service_role;
grant execute on function public.process_onboarding_event(text, uuid, text, timestamptz, jsonb, text, text, text)
  to service_role;
grant execute on function public.claim_stuck_creators(integer) to service_role;
