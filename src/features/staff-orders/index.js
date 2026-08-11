import {
  canServeLine,
  FULFILLMENT_TYPES,
  getAllowedOrderStatusTransitions,
  getServiceProgress,
  isOpenOrderStatus,
  isOpenPhysicalTableOrder,
  normalizeServiceProgress,
  normalizeOrderServiceContext,
  normalizePrepStatus,
  ORDER_SOURCES,
  SERVICE_MODES
} from "../ordering/index.js";
import { escapeAttr, escapeHtml, formatMoney } from "../../shared/utils/index.js";

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
  const openTablesByZone = selectOpenTablesByPhysicalZone(orders);
  return {
    newOrders: selectNewOrders(orders).length,
    tableServiceOpenOrders: selectTableServiceOpenOrders(orders).length,
    counterServiceOpenOrders: selectCounterServiceOpenOrders(orders).length,
    readyToServeOrders: selectReadyToServeOrders(orders).length,
    openTables: Object.values(openTablesByZone).reduce((sum, zoneTables) => sum + zoneTables.length, 0),
    openTablesByZone,
    serviceRequests: selectUnresolvedServiceRequests(events).length,
    todayTotal: orders.filter((order) => order.status !== "REJECTED").reduce((sum, order) => sum + order.total, 0)
  };
}

export function selectNewOrders(orders = []) {
  return orders.filter((order) => order.status === "PENDING_ACCEPTANCE");
}

export function selectTableServiceOpenOrders(orders = []) {
  return orders.filter((order) => {
    const context = normalizeOrderServiceContext(order);
    return context.serviceMode === SERVICE_MODES.TABLE_SERVICE
      && context.fulfillmentType === FULFILLMENT_TYPES.DINE_IN
      && isOpenOrderStatus(order.status);
  });
}

export function selectCounterServiceOpenOrders(orders = []) {
  return orders.filter((order) => {
    const context = normalizeOrderServiceContext(order);
    return context.serviceMode === SERVICE_MODES.COUNTER_SERVICE && isOpenOrderStatus(order.status);
  });
}

export function selectReadyToServeOrders(orders = []) {
  return orders.filter((order) => {
    return isOpenOrderStatus(order.status)
      && (selectReadyToServeLines(order).length > 0 || order.status === "READY");
  });
}

export function selectReadyToServeLines(order = {}) {
  return (order.items || []).filter((line) => canServeLine(line)).map((line) => {
    const progress = normalizeServiceProgress(line);
    return {
      ...line,
      remainingQty: progress.remainingQty
    };
  });
}

export function selectUnresolvedServiceRequests(events = []) {
  return events.filter((event) => !event.done);
}

export function selectOpenTablesByPhysicalZone(orders = []) {
  return selectTableServiceOpenOrders(orders).filter(isOpenPhysicalTableOrder).reduce((zones, order) => {
    const context = normalizeOrderServiceContext(order);
    const zone = context.zone || "Unassigned";
    zones[zone] = zones[zone] || [];
    if (!zones[zone].includes(context.table)) zones[zone].push(context.table);
    zones[zone].sort();
    return zones;
  }, {});
}

export function ordersByStaffColumn(orders = []) {
  return Object.fromEntries(STAFF_ORDER_COLUMNS.map((status) => [
    status,
    orders.filter((order) => order.status === status)
  ]));
}

export function staffOrderActions(order) {
  return getAllowedOrderStatusTransitions(order?.status).filter((status) => status !== "SERVED").map((status) => ({
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
        <div class="metric"><span class="muted">Table service</span><strong>${metrics.tableServiceOpenOrders}</strong></div>
        <div class="metric"><span class="muted">Counter/cafe</span><strong>${metrics.counterServiceOpenOrders}</strong></div>
        <div class="metric"><span class="muted">Ready to serve</span><strong>${metrics.readyToServeOrders}</strong></div>
        <div class="metric"><span class="muted">Open tables</span><strong>${metrics.openTables}</strong></div>
        <div class="metric"><span class="muted">Requests</span><strong>${metrics.serviceRequests}</strong></div>
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
  const context = normalizeOrderServiceContext(order);
  const age = formatOrderAge(order);
  const serviceProgress = getServiceProgress(order);
  const readyLines = selectReadyToServeLines(order);
  return `
    <article class="order-card">
      <div class="order-head"><strong>${escapeHtml(order.orderNo)} - ${escapeHtml(orderContextLabel(context))}</strong><span class="muted">${escapeHtml(age || order.time || "")}</span></div>
      <div class="station-grid">
        <span class="status-pill"><span>Mode</span><strong>${escapeHtml(serviceModeLabel(context.serviceMode))}</strong></span>
        <span class="status-pill"><span>Fulfillment</span><strong>${escapeHtml(fulfillmentLabel(context.fulfillmentType))}</strong></span>
        <span class="status-pill"><span>Source</span><strong>${escapeHtml(sourceLabel(context.orderSource))}</strong></span>
        <span class="status-pill"><span>Service</span><strong>${serviceProgress.servedQty}/${serviceProgress.serviceableQty}</strong></span>
      </div>
      <ul class="item-list">
        ${order.items.map((line) => renderStaffLine(line)).join("")}
      </ul>
      ${readyLines.length ? renderReadyServiceActions(order, context, readyLines) : ""}
      ${order.note ? `<p class="muted">Note: ${escapeHtml(order.note)}</p>` : ""}
      <div class="station-grid">${Object.entries(order.stationStatus || {}).map(([station, status]) => `<span class="status-pill"><span>${station}</span><strong>${status}</strong></span>`).join("")}</div>
      <strong>${formatMoney(order.total)}</strong>
      <div class="split-actions">
        ${staffOrderActions(order).map((action) => `<button class="${action.tone}" data-order="${order.id}" data-status="${action.status}">${action.label}</button>`).join("")}
      </div>
    </article>
  `;
}

function renderStaffLine(line) {
  const progress = normalizeServiceProgress(line);
  const prepStatus = normalizePrepStatus(line.prepStatus || line.status);
  return `<li class="${line.isComponent ? "component-line" : ""}">${line.isComponent ? "-> " : ""}${line.qty} x ${escapeHtml(line.nameEn)} <span class="station">${escapeHtml(line.station)}</span> <span class="station">${prepStatus}</span> <span class="station">served ${progress.servedQty}/${progress.serviceableQty || line.qty}</span></li>`;
}

function renderReadyServiceActions(order, context, readyLines) {
  const counterFastPath = context.serviceMode === SERVICE_MODES.COUNTER_SERVICE;
  return `
    <div class="service-actions">
      <strong>Ready to serve</strong>
      <ul class="item-list compact-items">
        ${readyLines.map((line) => `
          <li>
            <span>${line.remainingQty} x ${escapeHtml(line.nameEn)} <span class="station">${escapeHtml(line.station)}</span></span>
            <span class="split-actions compact-actions">
              <button class="primary compact" data-serve-order="${escapeAttr(order.id)}" data-serve-line="${escapeAttr(line.lineId)}" data-serve-qty="1">Serve 1</button>
              ${line.remainingQty > 1 ? `<button class="ghost compact" data-serve-order="${escapeAttr(order.id)}" data-serve-line="${escapeAttr(line.lineId)}" data-serve-qty="${line.remainingQty}">Serve all line</button>` : ""}
            </span>
          </li>
        `).join("")}
      </ul>
      ${counterFastPath ? `<button class="primary compact" data-serve-all="${escapeAttr(order.id)}">Serve all ready</button>` : ""}
    </div>
  `;
}

export function renderStaffEventCard(event) {
  return `
    <div class="status-pill ${event.done ? "done" : ""}">
      <span>${event.type.replace("_", " ")} - Table ${event.table || "Counter"}</span>
      <div class="split-actions">
        <strong>${event.time}</strong>
        ${event.done ? "" : `<button class="ghost compact" data-event="${event.id}">Done</button>`}
      </div>
    </div>
  `;
}

export function orderElapsedMinutes(order, now = new Date()) {
  const createdAt = new Date(order?.createdAt || "");
  if (!Number.isFinite(createdAt.valueOf())) return null;
  return Math.max(0, Math.floor((new Date(now).getTime() - createdAt.getTime()) / 60000));
}

export function formatOrderAge(order, now = new Date()) {
  const minutes = orderElapsedMinutes(order, now);
  if (minutes === null) return "";
  if (minutes < 1) return "<1m waiting";
  return `${minutes}m waiting`;
}

function orderContextLabel(context) {
  if (context.serviceMode === SERVICE_MODES.TABLE_SERVICE) {
    const zone = context.zone ? `${context.zone} ` : "";
    return `${zone}Table ${context.table || "unassigned"}`.trim();
  }
  if (context.fulfillmentType === FULFILLMENT_TYPES.TAKEAWAY) return "Counter takeaway";
  return "Counter dine-in";
}

function serviceModeLabel(serviceMode) {
  return serviceMode === SERVICE_MODES.TABLE_SERVICE ? "Table service" : "Counter service";
}

function fulfillmentLabel(fulfillmentType) {
  return fulfillmentType === FULFILLMENT_TYPES.TAKEAWAY ? "Takeaway" : "Dine-in";
}

function sourceLabel(orderSource) {
  const labels = {
    [ORDER_SOURCES.CUSTOMER_QR]: "QR",
    [ORDER_SOURCES.STAFF]: "Staff",
    [ORDER_SOURCES.COUNTER]: "Counter"
  };
  return labels[orderSource] || orderSource;
}
