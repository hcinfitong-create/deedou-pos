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

export function renderCustomerOrderStatusStrip({ orders, tableCode, lang, copy }) {
  const html = orders
    .filter((order) => order.table === tableCode)
    .slice(-4)
    .reverse()
    .map((order) => renderCustomerOrderStatusPill(order, { lang, copy }))
    .join("");
  return `<div class="status-strip">${html}</div>`;
}

