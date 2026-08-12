insert into public.locations (id, name, timezone, currency)
values ('deedou-demo', 'DeeDou Demo', 'Asia/Saigon', 'VND')
on conflict (id) do nothing;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values
  ('tbl-a01', 'deedou-demo', 'A01', 'Beach', 'beach-a01-47VLmz', 1),
  ('tbl-a02', 'deedou-demo', 'A02', 'Beach', 'beach-a02-P9qK31', 2),
  ('tbl-b01', 'deedou-demo', 'B01', 'Indoor', 'indoor-b01-Js82Va', 3),
  ('tbl-c01', 'deedou-demo', 'C01', 'Camping', 'camp-c01-R8mN42', 4)
on conflict (id) do nothing;

insert into public.products (id, location_id, kind, category, name_vi, name_en, desc_vi, desc_en, price_vnd, station_code, available, color, art, periods)
values
  ('coconut-coffee', 'deedou-demo', 'DRINK', 'drink-coffee', 'Ca phe dua', 'Coconut Coffee', 'Ca phe rang dam, kem dua min va da xay.', 'Bold coffee with creamy coconut foam.', 59000, 'BAR_COFFEE', true, '#dcefe5', 'cup', array['morning', 'afternoon', 'evening']),
  ('espresso', 'deedou-demo', 'DRINK', 'drink-coffee', 'Espresso', 'Espresso', 'Shot ca phe dam vi, phuc vu nong.', 'A short, bold espresso served hot.', 39000, 'BAR_COFFEE', true, '#f0e2d0', 'cup', array['morning', 'afternoon', 'evening']),
  ('mango-tea', 'deedou-demo', 'DRINK', 'drink-tea', 'Tra xoai', 'Mango Tea', 'Tra trai cay, xoai chin, hau vi thanh.', 'Fruit tea with ripe mango and a clean finish.', 55000, 'BAR_TEA', true, '#f7e5b5', 'glass', array['morning', 'afternoon', 'evening']),
  ('bbq-couple', 'deedou-demo', 'FOOD', 'food-combo', 'Set BBQ doi', 'BBQ Couple Set', 'Thit bo, hai san, rau nuong va sot DeeDou.', 'Beef, seafood, grilled greens and DeeDou sauce.', 329000, 'KITCHEN_BBQ', true, '#ead5c3', 'grill', array['evening']),
  ('seafood-hotpot', 'deedou-demo', 'FOOD', 'food-combo', 'Lau hai san', 'Seafood Hot Pot', 'Nuoc lau chua cay, tom, muc, ca va rau.', 'Tangy spicy broth with shrimp, squid and fish.', 369000, 'KITCHEN_HOT', true, '#d9e8ef', 'pot', array['evening']),
  ('fried-rice', 'deedou-demo', 'FOOD', 'food-single', 'Com chien hai san', 'Seafood Fried Rice', 'Com chien thom voi tom, muc va rau cu.', 'Fragrant fried rice with shrimp, squid and vegetables.', 99000, 'KITCHEN_HOT', true, '#ece2bf', 'plate', array['evening'])
on conflict (id) do nothing;

insert into public.product_variants (id, product_id, variant_key, name_vi, name_en, price_delta_vnd, display_order)
values
  ('mango-tea-regular', 'mango-tea', 'regular', 'Ly vua', 'Regular', 0, 1),
  ('mango-tea-large', 'mango-tea', 'large', 'Ly lon', 'Large', 10000, 2)
on conflict (id) do nothing;

insert into public.modifier_groups (id, location_id, group_key, name_vi, name_en, required, multiple, min_select, max_select, display_order)
values
  ('grp-sugar', 'deedou-demo', 'sugar', 'Duong', 'Sugar', true, false, 1, 1, 1),
  ('grp-topping', 'deedou-demo', 'topping', 'Topping', 'Topping', false, true, 0, 2, 2)
on conflict (id) do nothing;

insert into public.modifier_options (id, modifier_group_id, option_key, name_vi, name_en, price_delta_vnd, available, display_order)
values
  ('opt-sugar-100', 'grp-sugar', 'sugar-100', '100% duong', '100% sugar', 0, true, 1),
  ('opt-sugar-50', 'grp-sugar', 'sugar-50', '50% duong', '50% sugar', 0, true, 2),
  ('opt-sugar-0', 'grp-sugar', 'sugar-0', 'Khong duong', 'No sugar', 0, true, 3),
  ('opt-coconut-jelly', 'grp-topping', 'coconut-jelly', 'Thach dua', 'Coconut jelly', 8000, true, 1),
  ('opt-aloe-vera', 'grp-topping', 'aloe-vera', 'Nha dam', 'Aloe vera', 6000, true, 2)
on conflict (id) do nothing;

insert into public.product_modifier_groups (product_id, modifier_group_id, display_order)
values
  ('mango-tea', 'grp-sugar', 1),
  ('mango-tea', 'grp-topping', 2)
on conflict (product_id, modifier_group_id) do nothing;

insert into public.product_components (id, parent_product_id, component_key, name_vi, name_en, qty, station_code, display_order)
values
  ('bbq-couple-beef', 'bbq-couple', 'beef-belly', 'Ba chi bo', 'Beef belly', 2, 'KITCHEN_BBQ', 1),
  ('bbq-couple-shrimp', 'bbq-couple', 'grilled-shrimp', 'Tom nuong', 'Grilled shrimp', 2, 'KITCHEN_BBQ', 2),
  ('bbq-couple-salad', 'bbq-couple', 'mango-salad', 'Salad xoai', 'Mango salad', 1, 'KITCHEN_COLD', 3),
  ('bbq-couple-tea', 'bbq-couple', 'mango-tea', 'Tra xoai', 'Mango tea', 2, 'BAR_TEA', 4),
  ('hotpot-broth', 'seafood-hotpot', 'hotpot-broth', 'Noi nuoc lau', 'Hot pot broth', 1, 'KITCHEN_HOT', 1),
  ('hotpot-seafood', 'seafood-hotpot', 'seafood-tray', 'Khay hai san', 'Seafood tray', 1, 'KITCHEN_COLD', 2),
  ('hotpot-greens', 'seafood-hotpot', 'greens-noodles', 'Rau va bun', 'Greens and noodles', 1, 'KITCHEN_COLD', 3)
on conflict (id) do nothing;
