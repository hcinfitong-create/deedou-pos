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

export const DIRECT_ORDER_STATUS_TRANSITIONS = Object.freeze({
  PENDING_ACCEPTANCE: Object.freeze(["ACCEPTED", "REJECTED"]),
  ACCEPTED: Object.freeze(["IN_PREPARATION"]),
  READY: Object.freeze(["SERVED"]),
  SERVED: Object.freeze(["PAID"])
});

export function getAllowedOrderStatusTransitions(status) {
  return [...(DIRECT_ORDER_STATUS_TRANSITIONS[normalizeOrderStatus(status)] || [])];
}

export function canTransitionOrderStatus(currentStatus, nextStatus) {
  const next = normalizeOrderStatus(nextStatus);
  return getAllowedOrderStatusTransitions(currentStatus).includes(next);
}

export function applyOrderStatusTransition(order, nextStatus) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };

  const from = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  const to = normalizeOrderStatus(nextStatus);
  if (!canTransitionOrderStatus(from, to)) {
    return { ok: false, order, from, to, reason: "INVALID_STATUS_TRANSITION" };
  }

  order.status = to;
  if (to === "ACCEPTED") {
    order.stationStatus = stationStatusFor(order.items, "QUEUED");
    nonComboItems(order).forEach((item) => {
      item.status = "QUEUED";
    });
  }
  if (to === "IN_PREPARATION") {
    const stationStatus = order.stationStatus || stationStatusFor(order.items, "QUEUED");
    order.stationStatus = stationStatus;
    Object.keys(stationStatus).forEach((station) => {
      if (stationStatus[station] === "QUEUED") stationStatus[station] = "PREPARING";
    });
    nonComboItems(order).filter((item) => item.status === "QUEUED").forEach((item) => {
      item.status = "PREPARING";
    });
  }
  if (to === "REJECTED") order.stationStatus = {};
  if (to === "SERVED") {
    nonComboItems(order).forEach((item) => {
      item.status = "SERVED";
    });
  }

  return { ok: true, order, from, to };
}

function nonComboItems(order) {
  return (order.items || []).filter((item) => item.station !== "COMBO");
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
