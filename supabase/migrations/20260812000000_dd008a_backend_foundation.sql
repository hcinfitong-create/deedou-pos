-- DD-008A backend foundation only.
-- Existing DeeDou app behavior remains LOCAL_DEMO/localStorage until later DD-008 stages.

create extension if not exists pgcrypto;

create table if not exists public.locations (
  id text primary key,
  name text not null,
  timezone text not null default 'Asia/Saigon',
  currency text not null default 'VND',
  created_at timestamptz not null default now()
);

create table if not exists public.physical_tables (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  code text not null,
  zone text not null,
  qr_token text not null unique,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (location_id, code),
  constraint physical_tables_qr_token_entropy check (char_length(qr_token) >= 12)
);

create table if not exists public.products (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  kind text not null check (kind in ('FOOD', 'DRINK')),
  category text not null,
  name_vi text not null,
  name_en text not null,
  desc_vi text not null default '',
  desc_en text not null default '',
  price_vnd integer not null check (price_vnd >= 0),
  station_code text not null,
  available boolean not null default true,
  image_url text not null default '',
  color text not null default '',
  art text not null default '',
  periods text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_variants (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  variant_key text not null,
  name_vi text not null,
  name_en text not null,
  price_delta_vnd integer not null default 0,
  available boolean not null default true,
  display_order integer not null default 0,
  unique (product_id, variant_key)
);

create table if not exists public.modifier_groups (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  group_key text not null,
  name_vi text not null,
  name_en text not null,
  required boolean not null default false,
  multiple boolean not null default false,
  min_select integer not null default 0,
  max_select integer not null default 1,
  display_order integer not null default 0,
  unique (location_id, group_key),
  constraint modifier_groups_select_bounds check (
    min_select >= 0
    and max_select >= min_select
    and (required = false or min_select >= 1)
  )
);

create table if not exists public.modifier_options (
  id text primary key,
  modifier_group_id text not null references public.modifier_groups(id) on delete cascade,
  option_key text not null,
  name_vi text not null,
  name_en text not null,
  price_delta_vnd integer not null default 0,
  available boolean not null default true,
  display_order integer not null default 0,
  unique (modifier_group_id, option_key)
);

create table if not exists public.product_modifier_groups (
  product_id text not null references public.products(id) on delete cascade,
  modifier_group_id text not null references public.modifier_groups(id) on delete cascade,
  display_order integer not null default 0,
  primary key (product_id, modifier_group_id)
);

create table if not exists public.product_components (
  id text primary key,
  parent_product_id text not null references public.products(id) on delete cascade,
  component_key text not null,
  name_vi text not null,
  name_en text not null,
  qty integer not null check (qty > 0),
  station_code text not null,
  display_order integer not null default 0,
  unique (parent_product_id, component_key)
);

create table if not exists public.table_sessions (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  physical_table_id text not null references public.physical_tables(id),
  table_code text not null,
  zone text not null,
  status text not null check (status in ('OPEN', 'CLOSED', 'VOIDED')),
  source text not null default 'LOCAL_DEMO',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint table_sessions_closed_at_required check (
    (status = 'OPEN' and closed_at is null)
    or (status <> 'OPEN' and closed_at is not null)
  )
);

create unique index if not exists table_sessions_one_open_per_physical_table
on public.table_sessions(location_id, physical_table_id)
where status = 'OPEN';

create table if not exists public.orders (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  order_no text not null,
  table_session_id text references public.table_sessions(id),
  physical_table_id text references public.physical_tables(id),
  service_mode text not null check (service_mode in ('COUNTER_SERVICE', 'TABLE_SERVICE')),
  fulfillment_type text not null check (fulfillment_type in ('DINE_IN', 'TAKEAWAY')),
  order_source text not null check (order_source in ('CUSTOMER_QR', 'STAFF', 'COUNTER')),
  zone text not null default '',
  table_code text not null default '',
  status text not null check (status in (
    'PENDING_ACCEPTANCE',
    'ACCEPTED',
    'REJECTED',
    'IN_PREPARATION',
    'READY',
    'SERVED',
    'PAID',
    'VOIDED',
    'REFUNDED',
    'PARTIALLY_REFUNDED'
  )),
  station_status jsonb not null default '{}'::jsonb,
  total_vnd integer not null default 0 check (total_vnd >= 0),
  paid_vnd integer not null default 0 check (paid_vnd >= 0),
  payment_status text not null default 'UNPAID' check (payment_status in ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  note text not null default '',
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  accepted_at timestamptz,
  prep_started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  paid_at timestamptz,
  unique (location_id, order_no)
);

create index if not exists orders_table_session_idx on public.orders(table_session_id);
create index if not exists orders_status_idx on public.orders(status);

create table if not exists public.order_lines (
  id text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  line_id text not null,
  product_id text,
  station_code text not null,
  name_vi text not null,
  name_en text not null,
  qty integer not null check (qty > 0),
  bill_qty integer not null check (bill_qty >= 0 and bill_qty <= qty),
  served_qty integer not null default 0 check (served_qty >= 0 and served_qty <= qty),
  prep_status text not null default 'QUEUED' check (prep_status in ('QUEUED', 'ACKNOWLEDGED', 'PREPARING', 'READY')),
  item_status text not null default 'QUEUED',
  base_price_vnd integer not null default 0 check (base_price_vnd >= 0),
  price_vnd integer not null default 0 check (price_vnd >= 0),
  is_billable boolean not null default true,
  is_component boolean not null default false,
  is_meta boolean not null default false,
  parent_combo_id text not null default '',
  parent_line_id text not null default '',
  parent_combo_name_vi text not null default '',
  parent_combo_name_en text not null default '',
  parent_combo_option_summary_vi jsonb not null default '[]'::jsonb,
  parent_combo_option_summary_en jsonb not null default '[]'::jsonb,
  configured_key text not null default '',
  configured_options jsonb,
  option_snapshot jsonb,
  course text,
  hold_state text not null default 'FIRED' check (hold_state in ('HELD', 'FIRED')),
  held_at timestamptz,
  fired_at timestamptz,
  queued_at timestamptz,
  acknowledged_at timestamptz,
  prep_started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  seat text not null default '',
  target_prep_station text not null default '',
  target_prep_minutes integer check (target_prep_minutes is null or target_prep_minutes > 0),
  ticket_age_alert_minutes integer check (ticket_age_alert_minutes is null or ticket_age_alert_minutes > 0),
  unique (order_id, line_id),
  constraint order_lines_course_positive check (course is null or course ~ '^[1-9][0-9]*$')
);

create index if not exists order_lines_order_idx on public.order_lines(order_id);
create index if not exists order_lines_station_prep_idx on public.order_lines(station_code, prep_status);

create table if not exists public.service_requests (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  table_session_id text references public.table_sessions(id),
  physical_table_id text references public.physical_tables(id),
  table_code text not null default '',
  zone text not null default '',
  type text not null check (type in ('CALL_STAFF', 'BILL_REQUEST')),
  status text not null default 'OPEN' check (status in ('OPEN', 'COMPLETED', 'VOIDED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists service_requests_open_idx on public.service_requests(location_id, status);

create table if not exists public.payment_transactions (
  id text primary key,
  location_id text not null references public.locations(id) on delete cascade,
  order_id text not null references public.orders(id) on delete cascade,
  type text not null check (type in ('PAYMENT', 'PAYMENT_VOID', 'REFUND')),
  method text not null,
  provider text not null default 'MANUAL',
  amount_vnd integer not null check (amount_vnd > 0),
  status text not null default 'SUCCEEDED' check (status in ('SUCCEEDED')),
  related_payment_id text references public.payment_transactions(id),
  tender_group_id text not null default '',
  created_at timestamptz not null default now(),
  note text not null default ''
);

create index if not exists payment_transactions_order_idx on public.payment_transactions(order_id);
create index if not exists payment_transactions_related_idx on public.payment_transactions(related_payment_id);

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  location_id text references public.locations(id) on delete cascade,
  idempotency_key text not null,
  command text not null,
  actor_type text not null default '',
  actor_id text not null default '',
  request_hash text not null,
  result_type text not null default '',
  result_id text not null default '',
  created_at timestamptz not null default now(),
  unique (location_id, idempotency_key, command)
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  location_id text references public.locations(id) on delete set null,
  actor_type text not null default '',
  actor_id text not null default '',
  staff_id text not null default '',
  device_id text not null default '',
  command text not null,
  target_type text not null default '',
  target_id text not null default '',
  outcome text not null,
  correlation_id text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.command_deduplication (
  id uuid primary key default gen_random_uuid(),
  location_id text references public.locations(id) on delete cascade,
  command_key text not null,
  command text not null,
  actor_type text not null default '',
  actor_id text not null default '',
  request_hash text not null,
  result_reference text not null default '',
  created_at timestamptz not null default now(),
  unique (location_id, command_key, command)
);

alter table public.locations enable row level security;
alter table public.physical_tables enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
alter table public.product_modifier_groups enable row level security;
alter table public.product_components enable row level security;
alter table public.table_sessions enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.service_requests enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.audit_events enable row level security;
alter table public.command_deduplication enable row level security;

create policy locations_public_read
on public.locations
for select
to anon, authenticated
using (true);

create policy physical_tables_public_qr_read
on public.physical_tables
for select
to anon, authenticated
using (is_active = true);

create policy products_public_menu_read
on public.products
for select
to anon, authenticated
using (available = true);

create policy product_variants_public_menu_read
on public.product_variants
for select
to anon, authenticated
using (available = true);

create policy modifier_groups_public_menu_read
on public.modifier_groups
for select
to anon, authenticated
using (true);

create policy modifier_options_public_menu_read
on public.modifier_options
for select
to anon, authenticated
using (available = true);

create policy product_modifier_groups_public_menu_read
on public.product_modifier_groups
for select
to anon, authenticated
using (true);

create policy product_components_public_menu_read
on public.product_components
for select
to anon, authenticated
using (true);

create or replace view public.public_backend_health
with (security_invoker = true)
as select true as ok;

create or replace view public.public_table_qr
with (security_invoker = true)
as
select
  code,
  zone,
  qr_token
from public.physical_tables
where is_active = true;

create or replace view public.public_menu_products
with (security_invoker = true)
as
select
  id,
  kind,
  category,
  name_vi,
  name_en,
  desc_vi,
  desc_en,
  price_vnd,
  station_code,
  image_url,
  color,
  art,
  periods
from public.products
where available = true;

create or replace view public.public_menu_product_variants
with (security_invoker = true)
as
select
  product_id,
  variant_key,
  name_vi,
  name_en,
  price_delta_vnd,
  display_order
from public.product_variants
where available = true;

create or replace view public.public_menu_modifier_groups
with (security_invoker = true)
as
select
  pmg.product_id,
  mg.group_key,
  mg.name_vi,
  mg.name_en,
  mg.required,
  mg.multiple,
  mg.min_select,
  mg.max_select,
  pmg.display_order
from public.product_modifier_groups pmg
join public.modifier_groups mg on mg.id = pmg.modifier_group_id;

create or replace view public.public_menu_modifier_options
with (security_invoker = true)
as
select
  mg.group_key,
  mo.option_key,
  mo.name_vi,
  mo.name_en,
  mo.price_delta_vnd,
  mo.display_order
from public.modifier_options mo
join public.modifier_groups mg on mg.id = mo.modifier_group_id
where mo.available = true;

grant usage on schema public to anon, authenticated;
grant select on public.locations to anon, authenticated;
grant select on public.physical_tables to anon, authenticated;
grant select on public.products to anon, authenticated;
grant select on public.product_variants to anon, authenticated;
grant select on public.modifier_groups to anon, authenticated;
grant select on public.modifier_options to anon, authenticated;
grant select on public.product_modifier_groups to anon, authenticated;
grant select on public.product_components to anon, authenticated;
grant select on public.public_backend_health to anon, authenticated;
grant select on public.public_table_qr to anon, authenticated;
grant select on public.public_menu_products to anon, authenticated;
grant select on public.public_menu_product_variants to anon, authenticated;
grant select on public.public_menu_modifier_groups to anon, authenticated;
grant select on public.public_menu_modifier_options to anon, authenticated;
