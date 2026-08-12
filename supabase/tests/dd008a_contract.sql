\set ON_ERROR_STOP on

begin;

insert into public.locations (id, name, timezone, currency)
values
  ('review-location-a', 'Review Location A', 'Asia/Saigon', 'VND'),
  ('review-location-b', 'Review Location B', 'Asia/Saigon', 'VND');

insert into public.physical_tables (id, location_id, code, zone, qr_token)
values
  ('review-table-a01', 'review-location-a', 'A01', 'Beach', 'review-token-a01-47VLmz'),
  ('review-table-b01', 'review-location-b', 'B01', 'Indoor', 'review-token-b01-Js82Va');

insert into public.products (id, location_id, kind, category, name_vi, name_en, desc_vi, desc_en, price_vnd, station_code, available)
values
  ('review-product-a', 'review-location-a', 'DRINK', 'drink-tea', 'Tra test A', 'Tea Test A', '', '', 50000, 'BAR_TEA', true),
  ('review-product-b', 'review-location-b', 'DRINK', 'drink-tea', 'Tra test B', 'Tea Test B', '', '', 50000, 'BAR_TEA', true);

insert into public.modifier_groups (id, location_id, group_key, name_vi, name_en, required, multiple, min_select, max_select)
values
  ('review-group-a', 'review-location-a', 'sugar', 'Duong A', 'Sugar A', true, false, 1, 1),
  ('review-group-b', 'review-location-b', 'sugar', 'Duong B', 'Sugar B', true, false, 1, 1);

insert into public.product_modifier_groups (product_id, modifier_group_id)
values
  ('review-product-a', 'review-group-a'),
  ('review-product-b', 'review-group-b');

insert into public.modifier_options (id, modifier_group_id, option_key, name_vi, name_en, price_delta_vnd)
values
  ('review-option-a', 'review-group-a', 'less', 'It duong A', 'Less A', 0),
  ('review-option-b', 'review-group-b', 'less', 'It duong B', 'Less B', 0);

insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status)
values ('review-open-a', 'review-location-a', 'review-table-a01', 'A01', 'Beach', 'OPEN');

do $$
begin
  begin
    insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status)
    values ('review-open-duplicate', 'review-location-b', 'review-table-a01', 'A01', 'Beach', 'OPEN');
    raise exception 'expected duplicate open or mismatched location insert to fail';
  exception
    when unique_violation or foreign_key_violation then null;
  end;
end $$;

do $$
begin
  begin
    insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status, closed_at)
    values ('review-mismatched-location', 'review-location-b', 'review-table-a01', 'A01', 'Beach', 'CLOSED', now());
    raise exception 'expected mismatched physical table location insert to fail';
  exception
    when foreign_key_violation then null;
  end;
end $$;

insert into public.orders (id, location_id, order_no, physical_table_id, service_mode, fulfillment_type, order_source, zone, table_code, status, total_vnd)
values ('review-order-retain', 'review-location-a', 'REVIEW-0001', 'review-table-a01', 'TABLE_SERVICE', 'DINE_IN', 'CUSTOMER_QR', 'Beach', 'A01', 'SERVED', 50000);

insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, status)
values ('review-pay-retain', 'review-location-a', 'review-order-retain', 'PAYMENT', 'CASH', 'MANUAL', 50000, 'SUCCEEDED');

do $$
begin
  begin
    delete from public.orders where id = 'review-order-retain';
    raise exception 'expected order delete with payment ledger to fail';
  exception
    when foreign_key_violation then null;
  end;
end $$;

set local role anon;

do $$
declare
  resolved_count integer;
  unknown_count integer;
  product_count integer;
  cross_location_product_count integer;
  group_count integer;
  option_count integer;
begin
  select count(*) into resolved_count
  from public.resolve_table_token('review-token-a01-47VLmz')
  where location_id = 'review-location-a'
    and code = 'A01'
    and zone = 'Beach';
  if resolved_count <> 1 then
    raise exception 'expected exact token resolver to return one table, got %', resolved_count;
  end if;

  select count(*) into unknown_count
  from public.resolve_table_token('review-token-a02-unknown');
  if unknown_count <> 0 then
    raise exception 'expected resolver to hide unknown token, got %', unknown_count;
  end if;

  select count(*) into product_count
  from public.list_public_menu_products('review-location-a')
  where location_id = 'review-location-a'
    and id = 'review-product-a';
  if product_count <> 1 then
    raise exception 'expected location-scoped menu product result, got %', product_count;
  end if;

  select count(*) into cross_location_product_count
  from public.list_public_menu_products('review-location-b')
  where location_id = 'review-location-a'
    or id = 'review-product-a';
  if cross_location_product_count <> 0 then
    raise exception 'expected location B menu to exclude location A products, got %', cross_location_product_count;
  end if;

  select count(*) into group_count
  from public.list_public_menu_modifier_groups('review-location-a')
  where location_id = 'review-location-a'
    and modifier_group_id = 'review-group-a'
    and group_key = 'sugar';
  if group_count <> 1 then
    raise exception 'expected location-scoped modifier group result, got %', group_count;
  end if;

  select count(*) into option_count
  from public.list_public_menu_modifier_options('review-location-b')
  where location_id = 'review-location-b'
    and modifier_group_id = 'review-group-b'
    and option_key = 'less';
  if option_count <> 1 then
    raise exception 'expected location-scoped modifier option result, got %', option_count;
  end if;
end $$;

do $$
begin
  begin
    perform 1 from public.public_table_qr limit 1;
    raise exception 'expected public_table_qr enumeration surface to be absent';
  exception
    when undefined_table or insufficient_privilege then null;
  end;

  begin
    perform qr_token from public.physical_tables limit 1;
    raise exception 'expected anon raw qr_token enumeration to fail';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.physical_tables limit 1;
    raise exception 'expected anon raw physical_tables read to fail';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.products limit 1;
    raise exception 'expected anon raw products read to fail';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.payment_transactions limit 1;
    raise exception 'expected anon raw payment_transactions read to fail';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.audit_events limit 1;
    raise exception 'expected anon raw audit_events read to fail';
  exception
    when insufficient_privilege then null;
  end;
end $$;

rollback;
