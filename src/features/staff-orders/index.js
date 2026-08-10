import { getAllowedOrderStatusTransitions } from "../ordering/index.js";
import { escapeHtml, formatMoney } from "../../shared/utils/index.js";

export const STAFF_ORDER_COLUMNS = ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"];

const STAFF_ACTION_COPY = {
  ACCEPTED: { label: "Accept", tone: "primary" },
  REJECTED: { label: "Reject", tone: "danger" },
  IN_PREPARATION: { label: "Send to prep", tone: "primary" },
  READY: { label: "Ready", tone: "primary" },
  SERVED: { label: "Served", tone: "primary" },
  PAID: { label: "Paid and close", tone: "primary" }
};

export function staffOrderMetrics({ orders = [], events = [] } = {}) {
  return {
    newOrders: orders.filter((order) => order.status === "PENDING_ACCEPTANCE").length,
    openTables: new Set(orders.filter((order) => !["PAID", "REJECTED"].includes(order.status)).map((order) => order.table)).size,
    serviceRequests: events.filter((event) => !event.done).length,
    todayTotal: orders.filter((order) => order.status !== "REJECTED").reduce((sum, order) => sum + order.total, 0)
  };
}

export function ordersByStaffColumn(orders = []) {
  return Object.fromEntries(STAFF_ORDER_COLUMNS.map((status) => [
    status,
    orders.filter((order) => order.status === status)
  ]));
}

export function staffOrderActions(order) {
  return getAllowedOrderStatusTransitions(order?.status).map((status) => ({
    status,
    ...(STAFF_ACTION_COPY[status] || { label: status, tone: "primary" })
  }));
}

export function renderStaffPage({ orders = [], events = [] } = {}) {
  const metrics = staffOrderMetrics({ orders, events });
  const columns = ordersByStaffColumn(orders);
  return `
    <section class="page">
      <div class="summary-row">
        <div class="metric"><span class="muted">New orders</span><strong>${metrics.newOrders}</strong></div>
        <div class="metric"><span class="muted">Open tables</span><strong>${metrics.openTables}</strong></div>
        <div class="metric"><span class="muted">Service requests</span><strong>${metrics.serviceRequests}</strong></div>
        <div class="metric"><span class="muted">Today total</span><strong>${formatMoney(metrics.todayTotal)}</strong></div>
      </div>
      <div class="board staff-board">
        ${STAFF_ORDER_COLUMNS.map((status) => `
          <section class="column">
            <h2>${status}</h2>
            ${columns[status].map(renderStaffOrderCard).join("") || `<div class="empty">No orders</div>`}
          </section>
        `).join("")}
      </div>
      <section class="panel section-pad">
        <h2>Waiter and payment requests</h2>
        <div class="cart-list">
          ${events.slice().reverse().map(renderStaffEventCard).join("") || `<div class="empty">No requests</div>`}
        </div>
      </section>
    </section>
  `;
}

export function renderStaffOrderCard(order) {
  return `
    <article class="order-card">
      <div class="order-head"><strong>${order.orderNo} - Table ${order.table}</strong><span class="muted">${order.time}</span></div>
      <ul class="item-list">
        ${order.items.map((line) => `<li class="${line.isComponent ? "component-line" : ""}">${line.isComponent ? "-> " : ""}${line.qty} x ${escapeHtml(line.nameEn)} <span class="station">${line.station}</span> <span class="station">${line.status}</span></li>`).join("")}
      </ul>
      ${order.note ? `<p class="muted">Note: ${escapeHtml(order.note)}</p>` : ""}
      <div class="station-grid">${Object.entries(order.stationStatus || {}).map(([station, status]) => `<span class="status-pill"><span>${station}</span><strong>${status}</strong></span>`).join("")}</div>
      <strong>${formatMoney(order.total)}</strong>
      <div class="split-actions">
        ${staffOrderActions(order).map((action) => `<button class="${action.tone}" data-order="${order.id}" data-status="${action.status}">${action.label}</button>`).join("")}
      </div>
    </article>
  `;
}

export function renderStaffEventCard(event) {
  return `
    <div class="status-pill ${event.done ? "done" : ""}">
      <span>${event.type.replace("_", " ")} - Table ${event.table}</span>
      <div class="split-actions">
        <strong>${event.time}</strong>
        ${event.done ? "" : `<button class="ghost compact" data-event="${event.id}">Done</button>`}
      </div>
    </div>
  `;
}
