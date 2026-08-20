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
import {
  canAssignCourse,
  canFireServiceFamily,
  canHoldServiceFamily,
  courseLabel,
  getHeldCourseNumbers,
  getServiceFamilies,
  HOLD_STATES,
  normalizeCourse,
  normalizeHoldState
} from "../course-workflow/index.js";
import { optionSummaryLines } from "../product-options/index.js";
import { selectOpenTableSessions } from "../table-session/index.js";
import { escapeAttr, escapeHtml, formatMoney } from "../../shared/utils/index.js";

export const STAFF_ORDER_COLUMNS = ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"];

const STAFF_ACTION_COPY = {
  ACCEPTED: { label: "Accept", tone: "primary" },
  REJECTED: { label: "Reject", tone: "danger" },
  READY: { label: "Ready", tone: "primary" },
  SERVED: { label: "Served", tone: "primary" }
};

export function staffOrderMetrics({ orders = [], events = [], tableSessions = [] } = {}) {
  const openTablesByZone = selectOpenTablesByPhysicalZone(orders, tableSessions);
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

export function selectOpenTablesByPhysicalZone(orders = [], tableSessions = []) {
  const openSessions = selectOpenTableSessions(tableSessions);
  if (openSessions.length || tableSessions.length) {
    return openSessions.reduce((zones, session) => {
      const zone = session.zone || "Unassigned";
      zones[zone] = zones[zone] || [];
      if (!zones[zone].includes(session.tableCode)) zones[zone].push(session.tableCode);
      zones[zone].sort();
      return zones;
    }, {});
  }
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
  return getAllowedOrderStatusTransitions(order?.status).filter((status) => {
    return !["IN_PREPARATION", "SERVED", "PAID"].includes(status);
  }).map((status) => ({
    status,
    ...(STAFF_ACTION_COPY[status] || { label: status, tone: "primary" })
  }));
}

export function renderStaffPage({ orders = [], events = [], tableSessions = [] } = {}) {
  const metrics = staffOrderMetrics({ orders, events, tableSessions });
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
      ${renderCourseWorkflowControls(order, context)}
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
  const summaries = optionSummaryLines(line, "en");
  return `<li class="${line.isComponent ? "component-line" : ""}">${line.isComponent ? "-> " : ""}${line.qty} x ${escapeHtml(line.nameEn)} <span class="station">${escapeHtml(line.station)}</span> <span class="station">${escapeHtml(courseLabel(line.course))}</span> <span class="station">${escapeHtml(normalizeHoldState(line.holdState))}</span> <span class="station">${prepStatus}</span> <span class="station">served ${progress.servedQty}/${progress.serviceableQty || line.qty}</span>${summaries.map((summary) => `<br><span class="muted">${escapeHtml(summary)}</span>`).join("")}</li>`;
}

function renderCourseWorkflowControls(order, context) {
  if (context.serviceMode !== SERVICE_MODES.TABLE_SERVICE || context.fulfillmentType !== FULFILLMENT_TYPES.DINE_IN) return "";
  const families = getServiceFamilies(order);
  if (!families.length) return "";
  const heldCourses = getHeldCourseNumbers(order);
  return `
    <div class="course-controls">
      <strong>Course pacing</strong>
      <div class="course-family-list">
        ${families.map((family) => renderCourseFamilyControl(order, family)).join("")}
      </div>
      ${heldCourses.length ? `
        <div class="split-actions compact-actions">
          ${heldCourses.map((course) => `<button class="primary compact" data-course-fire="${escapeAttr(order.id)}" data-course="${escapeAttr(course)}">Fire ${escapeHtml(courseLabel(course))}</button>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderCourseFamilyControl(order, family) {
  const rootName = family.root?.nameEn || family.rootLineId;
  const canEditCourse = canAssignCourse(order, family.rootLineId, family.course).ok;
  const canHold = canHoldServiceFamily(order, family.rootLineId).ok;
  const canFire = canFireServiceFamily(order, family.rootLineId).ok;
  const holdState = normalizeHoldState(family.holdState);
  return `
    <div class="course-family">
      <span><strong>${escapeHtml(rootName)}</strong> <span class="station">${escapeHtml(courseLabel(family.course))}</span> <span class="station">${escapeHtml(holdState)}</span></span>
      ${canEditCourse ? `
        <label class="inline-control">
          <span>Course</span>
          <input data-course-value="${escapeAttr(order.id)}" data-course-family="${escapeAttr(family.rootLineId)}" value="${escapeAttr(normalizeCourse(family.course))}" inputmode="numeric" placeholder="Immediate" />
        </label>
        <button class="ghost compact" data-course-assign="${escapeAttr(order.id)}" data-course-family="${escapeAttr(family.rootLineId)}">Assign</button>
      ` : `<span class="muted">Course locked</span>`}
      ${holdState === HOLD_STATES.HELD
        ? `<button class="primary compact" data-line-fire="${escapeAttr(order.id)}" data-course-family="${escapeAttr(family.rootLineId)}" ${canFire ? "" : "disabled"}>Fire</button>`
        : `<button class="ghost compact" data-line-hold="${escapeAttr(order.id)}" data-course-family="${escapeAttr(family.rootLineId)}" ${canHold ? "" : "disabled"}>Hold</button>`}
    </div>
  `;
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
            ${optionSummaryLines(line, "en").map((summary) => `<span class="muted">${escapeHtml(summary)}</span>`).join("")}
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
