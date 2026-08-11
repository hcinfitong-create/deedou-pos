import {
  applyPrepStatusTransition,
  canTransitionPrepStatus,
  FULFILLMENT_TYPES,
  isRequiredStationLine,
  normalizeOrderServiceContext,
  normalizeOrderStatus,
  normalizePrepStatus,
  SERVICE_MODES
} from "../ordering/index.js";
import { escapeAttr, escapeHtml } from "../../shared/utils/index.js";

export { applyPrepStatusTransition, canTransitionPrepStatus };

const STATION_ACTIONS = Object.freeze({
  QUEUED: Object.freeze({ status: "ACKNOWLEDGED", label: "Acknowledge" }),
  ACKNOWLEDGED: Object.freeze({ status: "PREPARING", label: "Start" }),
  PREPARING: Object.freeze({ status: "READY", label: "Ready" })
});
const STATION_ELIGIBLE_ORDER_STATUSES = Object.freeze(["ACCEPTED", "IN_PREPARATION", "READY"]);

export function selectStationTickets(orders = [], stationGroup, stationDefinitions = [], options = {}) {
  const stationMap = new Map((stationDefinitions || [])
    .filter((station) => station.group === stationGroup)
    .map((station) => [station.code, station]));
  const stationCodes = new Set(stationMap.keys());
  const now = options.now || new Date();

  return (orders || []).filter(isStationWorkflowEligible).flatMap((order) => {
    return [...stationCodes].map((stationCode) => {
      const lines = (order.items || []).filter((line) => {
        return isRequiredStationLine(line)
          && line.station === stationCode
          && normalizePrepStatus(line.prepStatus || line.status) !== "READY";
      });
      if (!lines.length) return null;
      const station = stationMap.get(stationCode);
      const ticket = {
        order,
        orderId: order.id,
        orderNo: order.orderNo,
        stationGroup,
        stationCode,
        stationLabel: station?.en || stationCode,
        lines,
        status: deriveStationTicketState(lines),
        now
      };
      return {
        ...ticket,
        ageMinutes: getStationTicketAge(ticket, now),
        actions: getStationTicketActions(ticket)
      };
    }).filter(Boolean);
  });
}

function isStationWorkflowEligible(order = {}) {
  return STATION_ELIGIBLE_ORDER_STATUSES.includes(normalizeOrderStatus(order.status));
}

export function deriveStationTicketState(ticketOrLines = []) {
  const lines = Array.isArray(ticketOrLines) ? ticketOrLines : ticketOrLines.lines || [];
  if (!lines.length) return "READY";
  const statuses = lines.map((line) => normalizePrepStatus(line.prepStatus || line.status));
  if (statuses.every((status) => status === "READY")) return "READY";
  if (statuses.includes("PREPARING")) return "PREPARING";
  if (statuses.includes("ACKNOWLEDGED")) return "ACKNOWLEDGED";
  return "QUEUED";
}

export function getStationTicketAge(ticket = {}, now = new Date()) {
  const candidates = [
    ...(ticket.lines || []).flatMap((line) => [line.queuedAt, line.acknowledgedAt, line.prepStartedAt, line.readyAt]),
    ticket.order?.acceptedAt,
    ticket.order?.createdAt
  ].filter(Boolean);
  const timestamps = candidates.map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return null;
  return Math.max(0, Math.floor((new Date(now).getTime() - Math.min(...timestamps)) / 60000));
}

export function getStationTicketActions(ticket = {}) {
  const status = deriveStationTicketState(ticket);
  return STATION_ACTIONS[status] ? [STATION_ACTIONS[status]] : [];
}

export function renderStationPage({ orders = [], stationGroup, stations = [], now = new Date() } = {}) {
  const tickets = selectStationTickets(orders, stationGroup, stations, { now });
  return `
    <section class="page">
      <div class="ops-head">
        <div>
          <div class="kicker">${escapeHtml(stationGroup)} display</div>
          <h1>${escapeHtml(stationTitle(stationGroup))}</h1>
          <p class="muted">KDS controls preparation only. FOH serves ready items from the staff board.</p>
        </div>
        <button class="ghost" data-route="#/staff">Back to staff</button>
      </div>
      <div class="station-board">
        ${tickets.map(renderStationTicket).join("") || `<div class="empty">No active ${escapeHtml(String(stationGroup || "").toLowerCase())} tickets.</div>`}
      </div>
    </section>
  `;
}

export function renderStationTicket(ticket) {
  const actions = ticket.actions || getStationTicketActions(ticket);
  return `
    <article class="order-card ticket">
      <div class="order-head">
        <strong>${escapeHtml(ticket.orderNo)} - ${escapeHtml(orderLocationLabel(ticket.order))}</strong>
        <span class="station">${escapeHtml(ticket.stationLabel)}</span>
      </div>
      <div class="station-grid">
        <span class="status-pill"><span>Prep</span><strong>${escapeHtml(ticket.status)}</strong></span>
        <span class="status-pill"><span>Age</span><strong>${formatAge(ticket.ageMinutes)}</strong></span>
      </div>
      <ul class="item-list">
        ${ticket.lines.map((line) => `<li><strong>${line.qty} x ${escapeHtml(line.nameVi)}</strong> <span class="station">${escapeHtml(line.station)}</span><br><span class="muted">${escapeHtml(line.nameEn)} - ${escapeHtml(normalizePrepStatus(line.prepStatus || line.status))}</span></li>`).join("")}
      </ul>
      ${ticket.order?.note ? `<p class="muted">Note: ${escapeHtml(ticket.order.note)}</p>` : ""}
      <div class="split-actions">
        ${actions.map((action) => `<button class="primary" data-station-order="${escapeAttr(ticket.orderId)}" data-station-code="${escapeAttr(ticket.stationCode)}" data-station-status="${escapeAttr(action.status)}">${escapeHtml(action.label)}</button>`).join("")}
      </div>
    </article>
  `;
}

function stationTitle(stationGroup) {
  if (stationGroup === "BAR") return "Bar drinks queue";
  if (stationGroup === "DESSERT") return "Dessert queue";
  return "Kitchen queue";
}

function orderLocationLabel(order) {
  const context = normalizeOrderServiceContext(order);
  if (context.serviceMode === SERVICE_MODES.TABLE_SERVICE) return `Table ${context.table || "unassigned"}`;
  if (context.fulfillmentType === FULFILLMENT_TYPES.TAKEAWAY) return "Takeaway";
  return "Counter";
}

function formatAge(minutes) {
  if (minutes === null || minutes === undefined) return "-";
  if (minutes < 1) return "<1m";
  return `${minutes}m`;
}
