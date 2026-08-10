export const menuKinds = [
  { id: "all", vi: "Tất cả", en: "All" },
  { id: "FOOD", vi: "Đồ ăn", en: "Food" },
  { id: "DRINK", vi: "Đồ uống", en: "Drinks" }
];

export const categories = [
  { id: "food-combo", vi: "Combo", en: "Combos", kind: "FOOD", periods: ["evening"] },
  { id: "food-single", vi: "Món lẻ", en: "A la carte", kind: "FOOD", periods: ["morning", "afternoon", "evening"] },
  { id: "food-dessert", vi: "Tráng miệng", en: "Desserts", kind: "FOOD", periods: ["afternoon", "evening"] },
  { id: "drink-coffee", vi: "Cà phê", en: "Coffee", kind: "DRINK", periods: ["morning", "afternoon", "evening"] },
  { id: "drink-tea", vi: "Trà", en: "Tea", kind: "DRINK", periods: ["morning", "afternoon", "evening"] },
  { id: "drink-signature", vi: "Đặc trưng", en: "Signature", kind: "DRINK", periods: ["afternoon", "evening"] }
];

export const categoryAliases = {
  coffee: "drink-coffee",
  tea: "drink-tea",
  signature: "drink-signature",
  morning: "food-single",
  meal: "food-single",
  bbq: "food-combo",
  hotpot: "food-combo",
  sweet: "food-dessert"
};

export const defaultProducts = [
  product("coconut-coffee", "DRINK", "drink-coffee", "Cà phê dừa", "Coconut Coffee", "Cà phê rang đậm, kem dừa mịn và đá xay.", "Bold coffee with creamy coconut foam.", 59000, "BAR_COFFEE", true, "#dcefe5", "cup", ["morning", "afternoon", "evening"]),
  product("espresso", "DRINK", "drink-coffee", "Espresso", "Espresso", "Shot cà phê đậm vị, phục vụ nóng.", "A short, bold espresso served hot.", 39000, "BAR_COFFEE", true, "#f0e2d0", "cup", ["morning", "afternoon", "evening"]),
  product("mango-tea", "DRINK", "drink-tea", "Trà xoài", "Mango Tea", "Trà trái cây, xoài chín, hậu vị thanh.", "Fruit tea with ripe mango and a clean finish.", 55000, "BAR_TEA", true, "#f7e5b5", "glass", ["morning", "afternoon", "evening"]),
  product("sunset-soda", "DRINK", "drink-signature", "Soda hoàng hôn", "Sunset Soda", "Soda cam chanh, syrup lựu và lát trái cây.", "Citrus soda with pomegranate syrup.", 65000, "BAR", true, "#f6d4c8", "glass", ["afternoon", "evening"]),
  product("xoi-cha", "FOOD", "food-single", "Xôi chả quế", "Sticky Rice with Pork Roll", "Xôi nóng, chả quế, hành phi và đồ chua.", "Warm sticky rice with cinnamon pork roll.", 49000, "KITCHEN_HOT", true, "#efe7d7", "plate", ["morning"]),
  product("croissant", "FOOD", "food-dessert", "Croissant bơ", "Butter Croissant", "Bánh nướng giòn, thơm bơ, dùng cùng mứt.", "Flaky butter croissant with jam.", 45000, "DESSERT", false, "#f3dfb8", "dessert", ["afternoon", "evening"]),
  product("bbq-couple", "FOOD", "food-combo", "Set BBQ đôi", "BBQ Couple Set", "Thịt bò, hải sản, rau nướng và sốt DeeDou.", "Beef, seafood, grilled greens and DeeDou sauce.", 329000, "KITCHEN_BBQ", true, "#ead5c3", "grill", ["evening"], "", [
    component("Ba chỉ bò", "Beef belly", 2, "KITCHEN_BBQ"),
    component("Tôm nướng", "Grilled shrimp", 2, "KITCHEN_BBQ"),
    component("Salad xoài", "Mango salad", 1, "KITCHEN_COLD"),
    component("Trà xoài", "Mango tea", 2, "BAR_TEA")
  ]),
  product("seafood-hotpot", "FOOD", "food-combo", "Lẩu hải sản", "Seafood Hot Pot", "Nước lẩu chua cay, tôm, mực, cá và rau.", "Tangy spicy broth with shrimp, squid and fish.", 369000, "KITCHEN_HOT", true, "#d9e8ef", "pot", ["evening"], "", [
    component("Nồi nước lẩu", "Hot pot broth", 1, "KITCHEN_HOT"),
    component("Khay hải sản", "Seafood tray", 1, "KITCHEN_COLD"),
    component("Rau và bún", "Greens and noodles", 1, "KITCHEN_COLD")
  ]),
  product("fried-rice", "FOOD", "food-single", "Cơm chiên hải sản", "Seafood Fried Rice", "Cơm chiên thơm với tôm, mực và rau củ.", "Fragrant fried rice with shrimp, squid and vegetables.", 99000, "KITCHEN_HOT", true, "#ece2bf", "plate", ["evening"])
];

export function compareMenuItems(a, b) {
  const kindOrder = { FOOD: 0, DRINK: 1 };
  const categoryOrder = Object.fromEntries(categories.map((cat, index) => [cat.id, index]));
  return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99) || a.vi.localeCompare(b.vi, "vi");
}

export function isProductAvailableInPeriod(item, period) {
  return Array.isArray(item?.periods) && item.periods.includes(period);
}

export function filterMenuItems(items, { period, activeKind = "all", activeCategory = "all" } = {}) {
  return (items || []).filter((item) => {
    const kindMatch = activeKind === "all" || item.kind === activeKind;
    const categoryMatch = activeCategory === "all" || item.category === activeCategory;
    return kindMatch && categoryMatch && isProductAvailableInPeriod(item, period);
  });
}

function product(id, kind, category, vi, en, descVi, descEn, price, station, available, color, art, periods, image = "", components = []) {
  return { id, kind, category, vi, en, descVi, descEn, price, station, available, color, art, periods, image, components };
}

function component(vi, en, qty, station) {
  return { vi, en, qty, station };
}
