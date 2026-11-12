-- RefundsOut schema. Idempotent: safe to run on every deploy.
-- Money is always whole cents (bigint) plus an ISO currency code.

create extension if not exists pgcrypto;

-- ---------- Event data ----------
create table if not exists events (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  cancelled_day       text,
  currency            char(3) not null default 'USD',
  refund_budget_cents bigint not null default 0 check (refund_budget_cents >= 0),
  approval_threshold_cents bigint not null default 5000000, -- second approver above $50,000
  status              text not null default 'draft'
                      check (status in ('draft','reviewing','running','done')),
  created_at          timestamptz not null default now()
);

create table if not exists uploads (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references events(id) on delete cascade,
  kind           text not null check (kind in ('sales','scans','terms','notice')),
  file_name      text not null,
  file_hash      text not null,
  content        text,             -- terms / notice text, kept for quote checks
  column_mapping jsonb,            -- confirmed by the organizer
  row_count      int not null default 0,
  created_at     timestamptz not null default now(),
  unique (event_id, kind, file_hash)   -- same file twice = no-op
);

create table if not exists tickets (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references events(id) on delete cascade,
  external_ticket_id   text not null,
  tier                 text not null,
  price_cents          bigint not null check (price_cents >= 0),
  currency             char(3) not null,
  buyer_email          text not null,
  buyer_name           text,
  paypal_capture_id    text,
  transferred_to_email text,
  purchased_at         timestamptz,
  is_comp              boolean not null default false,
  unique (event_id, external_ticket_id)
);
create index if not exists tickets_capture_idx on tickets (event_id, paypal_capture_id);

create table if not exists scans (
  id                 bigserial primary key,
  event_id           uuid not null references events(id) on delete cascade,
  external_ticket_id text not null,
  scanned_at         timestamptz not null,
  gate               text,
  matched            boolean not null default true
);
create index if not exists scans_ticket_idx on scans (event_id, external_ticket_id);

create table if not exists quarantined_rows (
  id          bigserial primary key,
  upload_id   uuid not null references uploads(id) on delete cascade,
  row_number  int not null,
  raw_row     jsonb not null,
  reason      text not null,
  resolution  text check (resolution in ('fixed','excluded')),
  resolution_note text,
  resolved_at timestamptz
);

-- ---------- Policy ----------
create table if not exists policies (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  version     int not null,
  source_hash text not null,
  rules_json  jsonb not null,
  tests_json  jsonb not null,
  status      text not null default 'draft'
              check (status in ('draft','approved','superseded')),
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (event_id, version)
);

create table if not exists policy_questions (
  id           uuid primary key default gen_random_uuid(),
  policy_id    uuid not null references policies(id) on delete cascade,
  clause_quote text not null,
  question     text not null,
  options      jsonb not null,
  answer       text,
  answered_by  text,
  answered_at  timestamptz
);

-- ---------- PayPal state ----------
create table if not exists payment_snapshots (
  capture_id     text primary key,
  event_id       uuid references events(id) on delete cascade,
  captured_cents bigint not null,
  refunded_cents bigint not null default 0,
  currency       char(3) not null,
  status         text not null,   -- COMPLETED, PARTIALLY_REFUNDED, REFUNDED, REVERSED, ...
  dispute_id     text,
  dispute_stage  text,
  dispute_status text,
  captured_at    timestamptz,
  fetched_at     timestamptz not null default now(),
  raw            jsonb
);

-- ---------- Plan ----------
create table if not exists refund_plans (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  policy_id   uuid not null references policies(id),
  inputs_hash text not null,
  plan_hash   text not null,
  total_cents bigint not null,
  status      text not null default 'draft'
              check (status in ('draft','approved','running','paused','done','stopped')),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create table if not exists plan_items (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references refund_plans(id) on delete cascade,
  capture_id      text not null,
  buyer_email     text not null,
  buyer_name      text,
  currency        char(3) not null,
  paid_cents      bigint not null,
  already_refunded_cents bigint not null default 0,
  amount_cents    bigint not null check (amount_cents >= 0),
  lines           jsonb not null,          -- per-ticket breakdown with rule + reason
  rule_ids        text[] not null default '{}',
  reason          text not null,
  route           text not null check (route in ('refund','dispute_offer','skip','exception')),
  exception_type  text,
  override_cents  bigint check (override_cents >= 0),
  override_reason text,
  state           text not null default 'planned'
                  check (state in ('planned','approved','queued','rechecking','sending','pending',
                                   'refunded','offer_sent','skipped','needs_attention',
                                   'reconciled','cancelled')),
  request_id      text not null unique,    -- PayPal-Request-Id: built from plan + capture
  paypal_refund_id text,
  attempts        int not null default 0,
  last_error      text,
  updated_at      timestamptz not null default now(),
  unique (plan_id, capture_id)             -- one refund per payment per plan
);
create index if not exists plan_items_state_idx on plan_items (plan_id, state);

create table if not exists approvals (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references refund_plans(id) on delete cascade,
  plan_hash   text not null,               -- what was approved; any edit changes the hash
  user_name   text not null,
  role        text not null check (role in ('operator','approver')),
  approved_at timestamptz not null default now(),
  unique (plan_id, plan_hash, role)
);

create table if not exists refund_attempts (
  id               bigserial primary key,
  plan_item_id     uuid not null references plan_items(id) on delete cascade,
  request_id       text not null,
  attempt_no       int not null,
  http_status      int,
  result           text not null,          -- completed, pending, retry, failed, skipped
  paypal_refund_id text,
  paypal_debug_id  text,
  error_name       text,
  created_at       timestamptz not null default now()
);

create table if not exists webhook_events (
  paypal_event_id text primary key,        -- duplicates ignored
  event_type      text not null,
  resource_id     text,
  verified        boolean not null default false,
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);

-- ---------- Audit (insert-only) ----------
create table if not exists audit_log (
  id        bigserial primary key,
  actor     text not null,
  action    text not null,
  entity    text not null,
  entity_id text,
  before    jsonb,
  after     jsonb,
  at        timestamptz not null default now()
);

create or replace function audit_log_insert_only() returns trigger as $$
begin
  raise exception 'audit_log is insert-only';
end;
$$ language plpgsql;

drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change
  before update or delete on audit_log
  for each row execute function audit_log_insert_only();

-- ---------- Additions (idempotent) ----------
alter table uploads  add column if not exists confirmed_at timestamptz;
alter table policies add column if not exists checks_json jsonb;
alter table policies add column if not exists model text;
alter table plan_items add column if not exists flags text[] not null default '{}';
alter table plan_items add column if not exists dispute_id text;
alter table plan_items add column if not exists resolution text;
alter table plan_items add column if not exists letter text;
-- "Clear" on the home page hides a run instead of deleting it: refunds and the audit trail must survive.
alter table events add column if not exists hidden_at timestamptz;
-- Request ids are now keyed by event + payment (+ amount refunded before), so the same id may legitimately appear in
-- more than one plan for the same payment. Uniqueness is per plan.
alter table plan_items drop constraint if exists plan_items_request_id_key;
create unique index if not exists plan_items_plan_request_idx on plan_items (plan_id, request_id);
