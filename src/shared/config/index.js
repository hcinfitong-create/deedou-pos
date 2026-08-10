export const PRODUCT_KEY = "deedou_products_full";
export const STATE_KEY = "deedou_state";
export const COUNTER_DRAFT_KEY = "deedou_counter_draft";
export const COUNTER_SEARCH_KEY = "deedou_counter_search";

export const tables = [
  { code: "A01", zone: "Beach", token: "beach-a01-47VLmz" },
  { code: "A02", zone: "Beach", token: "beach-a02-P9qK31" },
  { code: "B01", zone: "Indoor", token: "indoor-b01-Js82Va" },
  { code: "C01", zone: "Camping", token: "camp-c01-R8mN42" }
];

export const stations = [
  { code: "BAR_COFFEE", group: "BAR", vi: "Bar cà phê", en: "Coffee Bar" },
  { code: "BAR_TEA", group: "BAR", vi: "Bar trà", en: "Tea Bar" },
  { code: "BAR", group: "BAR", vi: "Bar tổng", en: "Main Bar" },
  { code: "KITCHEN_HOT", group: "KITCHEN", vi: "Bếp nóng", en: "Hot Kitchen" },
  { code: "KITCHEN_BBQ", group: "KITCHEN", vi: "Bếp BBQ", en: "BBQ Kitchen" },
  { code: "KITCHEN_COLD", group: "KITCHEN", vi: "Bếp lạnh", en: "Cold Kitchen" },
  { code: "DESSERT", group: "DESSERT", vi: "Tráng miệng", en: "Dessert" },
  { code: "COUNTER", group: "DESSERT", vi: "Quầy", en: "Counter" }
];

export const stationAliases = {
  KITCHEN: "KITCHEN_HOT",
  BAR_DRINK: "BAR",
  DESSERT_COUNTER: "DESSERT"
};

