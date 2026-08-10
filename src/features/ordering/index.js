export function clampBillQty(value, maxQty) {
  const max = Math.max(0, Number(maxQty) || 0);
  const rawValue = value === undefined || value === null || value === "" ? max : Number(value);
  const safeValue = Number.isFinite(rawValue) ? rawValue : max;
  return Math.min(max, Math.max(0, Math.round(safeValue)));
}

export function chargedQty(line) {
  return clampBillQty(line.billQty, line.qty);
}

export function lineSubtotal(line) {
  return line.isBillable ? chargedQty(line) * (Number(line.price) || 0) : 0;
}

export function billableTotal(items) {
  return (items || []).reduce((sum, line) => sum + lineSubtotal(line), 0);
}

export function recalcOrderTotal(order) {
  order.total = billableTotal(order.items);
  return order.total;
}

export function expandOrderLines(cartLines, productById) {
  return (cartLines || []).flatMap((line) => {
    const item = productById(line.id);
    if (!item) return [];

    const qty = Math.max(1, Number(line.qty) || 1);
    const parent = {
      id: item.id,
      qty,
      station: item.components?.length ? "COMBO" : item.station,
      nameVi: item.vi,
      nameEn: item.en,
      price: Number(item.price) || 0,
      billQty: qty,
      status: "QUEUED",
      isBillable: true,
      isComponent: false,
      parentComboId: ""
    };

    const components = (item.components || []).map((part, index) => ({
      id: `${item.id}-component-${index}`,
      qty: qty * (Number(part.qty) || 1),
      station: part.station,
      nameVi: part.vi,
      nameEn: part.en,
      price: 0,
      billQty: 0,
      status: "QUEUED",
      isBillable: false,
      isComponent: true,
      parentComboId: item.id
    }));

    return [parent, ...components];
  });
}

export function stationStatusFor(items, status) {
  const initial = "QUEUED";
  return Object.fromEntries([...new Set((items || []).filter((item) => item.station !== "COMBO").map((item) => item.station))].map((station) => [station, initial]));
}

export function countPrepItems(orders) {
  return orders.flatMap((order) => order.items).filter((item) => item.station !== "COMBO").reduce((sum, item) => sum + item.qty, 0);
}

export function countServedItems(orders) {
  return orders.flatMap((order) => order.items).filter((item) => item.station !== "COMBO" && item.status === "SERVED").reduce((sum, item) => sum + item.qty, 0);
}

export function countStatusItems(orders, status) {
  return orders.flatMap((order) => order.items).filter((item) => item.station !== "COMBO" && item.status === status).reduce((sum, item) => sum + item.qty, 0);
}

export function normalizeOrderStatus(status) {
  const aliases = {
    PENDING: "PENDING_ACCEPTANCE",
    PREPARING: "IN_PREPARATION",
    CANCELLED: "VOIDED"
  };
  return aliases[status] || status;
}

export function normalizeItemStatus(status) {
  const aliases = {
    PENDING: "QUEUED",
    ACCEPTED: "QUEUED",
    IN_PROGRESS: "PREPARING",
    COMPLETED: "READY"
  };
  return aliases[status] || status || "QUEUED";
}
