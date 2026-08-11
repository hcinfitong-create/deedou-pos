import { formatMoney } from "../../shared/utils/index.js";

export function renderCustomerOrderStatusPill(order, { lang, copy }) {
  const labels = {
    PENDING_ACCEPTANCE: copy[lang].reviewing,
    ACCEPTED: copy[lang].accepted,
    IN_PREPARATION: "Preparing",
    READY: "Ready",
    SERVED: "Served",
    PAID: "Paid",
    REJECTED: "Rejected",
    VOIDED: "Voided"
  };
  return `<div class="status-pill"><span>${order.orderNo} ${labels[order.status] || order.status}</span><strong>${formatMoney(order.total)}</strong></div>`;
}

export function selectCustomerSessionOrders({ orders = [], tableSessionId = "" } = {}) {
  const sessionId = String(tableSessionId || "").trim();
  if (!sessionId) return [];
  return (orders || []).filter((order) => order.tableSessionId === sessionId);
}

export function renderCustomerOrderStatusStrip({ orders, tableSessionId, lang, copy }) {
  const html = selectCustomerSessionOrders({ orders, tableSessionId })
    .slice(-4)
    .reverse()
    .map((order) => renderCustomerOrderStatusPill(order, { lang, copy }))
    .join("");
  return `<div class="status-strip">${html}</div>`;
}
