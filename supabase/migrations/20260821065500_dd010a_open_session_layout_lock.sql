-- DD-010A defense-in-depth: an OPEN table session freezes table identity/config.
-- Layout geometry/order may still move so Admin can rearrange the floor plan.

create or replace function public.dd010a_guard_open_session_table_config()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.table_sessions ts
    where ts.location_id = old.location_id
      and ts.physical_table_id = old.id
      and ts.status = 'OPEN'
  ) and (
    old.code is distinct from new.code
    or old.zone is distinct from new.zone
    or old.seat_count is distinct from new.seat_count
    or old.shape is distinct from new.shape
    or old.is_active is distinct from new.is_active
    or old.qr_token is distinct from new.qr_token
  ) then
    raise exception 'OPEN_SESSION_TABLE_CONFIG_LOCKED' using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists dd010a_guard_open_session_table_config on public.physical_tables;
create trigger dd010a_guard_open_session_table_config
before update on public.physical_tables
for each row execute function public.dd010a_guard_open_session_table_config();

revoke all on function public.dd010a_guard_open_session_table_config() from public, anon, authenticated;
