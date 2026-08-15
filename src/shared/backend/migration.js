import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createCorrelationId } from "./resilience.js";

export const LEGACY_EXPORT_SCHEMA_VERSION = 1;
export const LEGACY_EXPORT_SOURCE = "DEEDOU_LOCAL_DEMO";

export function buildLegacyExport({ state = {}, products = [], locationId = "deedou-demo", exportedAt = new Date().toISOString() } = {}) {
  const orders = Array.isArray(state.orders) ? state.orders.map(normalizeLegacyOrder) : [];
  return {
    schemaVersion: LEGACY_EXPORT_SCHEMA_VERSION,
    source: LEGACY_EXPORT_SOURCE,
    locationId: normalizeText(locationId) || "deedou-demo",
    exportedAt: normalizeIso(exportedAt) || new Date().toISOString(),
    tableSessions: Array.isArray(state.tableSessions) ? state.tableSessions.map(normalizeLegacyTableSession) : [],
    orders,
    serviceRequests: Array.isArray(state.events) ? state.events.map(normalizeLegacyServiceRequest) : [],
    audit: Array.isArray(state.audit) ? state.audit.map(normalizeLegacyAuditEvent) : [],
    products: Array.isArray(products) ? products.map(normalizeLegacyProduct).filter((item) => item.id) : []
  };
}

export function previewLegacyExport(bundle = {}) {
  const warnings = [];
  if (bundle.schemaVersion !== LEGACY_EXPORT_SCHEMA_VERSION) warnings.push("UNSUPPORTED_SCHEMA_VERSION");
  if (bundle.source !== LEGACY_EXPORT_SOURCE) warnings.push("UNKNOWN_EXPORT_SOURCE");
  if (!normalizeText(bundle.locationId)) warnings.push("LOCATION_REQUIRED");

  const collections = {
    tableSessions: Array.isArray(bundle.tableSessions) ? bundle.tableSessions : [],
    orders: Array.isArray(bundle.orders) ? bundle.orders : [],
    serviceRequests: Array.isArray(bundle.serviceRequests) ? bundle.serviceRequests : [],
    audit: Array.isArray(bundle.audit) ? bundle.audit : [],
    products: Array.isArray(bundle.products) ? bundle.products : []
  };

  const malformed = [];
  collections.tableSessions.forEach((item, index) => {
    if (!normalizeText(item?.id) || !normalizeText(item?.tableCode)) malformed.push({ entity: "tableSession", index, reason: "ID_OR_TABLE_REQUIRED" });
  });
  collections.orders.forEach((item, index) => {
    if (!normalizeText(item?.id) || !normalizeText(item?.orderNo) || !Array.isArray(item?.items)) malformed.push({ entity: "order", index, reason: "ID_ORDERNO_ITEMS_REQUIRED" });
  });
  collections.serviceRequests.forEach((item, index) => {
    if (!normalizeText(item?.id) || !normalizeText(item?.type)) malformed.push({ entity: "serviceRequest", index, reason: "ID_TYPE_REQUIRED" });
  });

  return {
    ok: warnings.length === 0,
    warnings,
    malformed,
    counts: {
      tableSessions: collections.tableSessions.length,
      orders: collections.orders.length,
      orderLines: collections.orders.reduce((sum, order) => sum + (Array.isArray(order.items) ? order.items.length : 0), 0),
      payments: collections.orders.reduce((sum, order) => sum + (Array.isArray(order.payments) ? order.payments.length : 0), 0),
      serviceRequests: collections.serviceRequests.length,
      audit: collections.audit.length,
      products: collections.products.length
    }
  };
}

export function serializeLegacyExport(bundle) {
  return JSON.stringify(bundle, null, 2);
}

export function createLegacyMigrationApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi;
  const deviceStorage = options.deviceStorage || globalThis.localStorage;
  const authStateRef = typeof options.authStateRef === "function" ? options.authStateRef : () => ({});

  async function call(functionName, params) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REQUIRED");
    const client = await authApi?.getClient?.();
    if (!client?.rpc) return failure("BACKEND_UNAVAILABLE", "SUPABASE_CLIENT_MISSING");
    const authState = authStateRef() || {};
    const locationId = normalizeText(authState.locationId || params.p_location_id);
    const workstationMode = normalizeText(authState.authorization?.workstationMode || authState.workstationMode || "ADMIN");
    const credential = readDeviceCredential(deviceStorage);
    if (!locationId || !credential) return failure("FORBIDDEN", "MIGRATION_CONTEXT_INCOMPLETE");
    const correlationId = createCorrelationId("legacy");
    try {
      const { data, error } = await client.rpc(functionName, {
        ...params,
        p_location_id: locationId,
        p_workstation_mode: workstationMode,
        p_device_credential: credential,
        p_correlation_id: correlationId
      });
      if (error) return failure("BACKEND_UNAVAILABLE", sanitizeTransportError(error), correlationId);
      return normalizeRpcResult(data, correlationId);
    } catch (error) {
      return failure("BACKEND_UNAVAILABLE", sanitizeTransportError(error), correlationId);
    }
  }

  return {
    preview({ bundle, importKey }) {
      return call("dd008d_preview_legacy_import", {
        p_payload: bundle,
        p_import_key: normalizeText(importKey)
      });
    },
    importData({ bundle, importKey }) {
      return call("dd008d_import_legacy_data", {
        p_payload: bundle,
        p_import_key: normalizeText(importKey)
      });
    },
    readiness() {
      return call("dd008d_production_readiness", {});
    }
  };
}

function normalizeLegacyTableSession(item = {}) {
  return compact({
    id: normalizeText(item.id),
    tableCode: normalizeText(item.tableCode || item.table),
    zone: normalizeText(item.zone),
    status: normalizeText(item.status || "OPEN").toUpperCase(),
    source: normalizeText(item.source || item.openedSource || "LOCAL_DEMO"),
    openedAt: normalizeIso(item.openedAt || item.createdAt),
    closedAt: normalizeIso(item.closedAt)
  });
}

function normalizeLegacyOrder(order = {}) {
  return compact({
    id: normalizeText(order.id),
    orderNo: normalizeText(order.orderNo || order.id),
    tableSessionId: normalizeText(order.tableSessionId),
    table: normalizeText(order.table),
    zone: normalizeText(order.zone),
    serviceMode: normalizeText(order.serviceMode),
    fulfillmentType: normalizeText(order.fulfillmentType),
    orderSource: normalizeText(order.orderSource),
    status: normalizeText(order.status).toUpperCase(),
    note: normalizeText(order.note),
    total: nonNegativeInteger(order.total),
    paidVnd: nonNegativeInteger(order.paidVnd),
    paymentStatus: normalizeText(order.paymentStatus),
    createdAt: normalizeIso(order.createdAt),
    submittedAt: normalizeIso(order.submittedAt),
    acceptedAt: normalizeIso(order.acceptedAt),
    prepStartedAt: normalizeIso(order.prepStartedAt),
    readyAt: normalizeIso(order.readyAt),
    servedAt: normalizeIso(order.servedAt),
    paidAt: normalizeIso(order.paidAt),
    items: Array.isArray(order.items) ? order.items.map(normalizeLegacyOrderLine) : [],
    payments: Array.isArray(order.payments) ? order.payments.map(normalizeLegacyPayment) : []
  });
}

function normalizeLegacyOrderLine(line = {}) {
  return compact({
    id: normalizeText(line.id),
    lineId: normalizeText(line.lineId),
    station: normalizeText(line.station),
    nameVi: normalizeText(line.nameVi),
    nameEn: normalizeText(line.nameEn),
    qty: positiveInteger(line.qty, 1),
    billQty: nonNegativeInteger(line.billQty),
    servedQty: nonNegativeInteger(line.servedQty),
    prepStatus: normalizeText(line.prepStatus || line.status || "QUEUED").toUpperCase(),
    status: normalizeText(line.status || "QUEUED").toUpperCase(),
    basePrice: nonNegativeInteger(line.basePrice),
    price: nonNegativeInteger(line.price),
    isBillable: line.isBillable !== false,
    isComponent: line.isComponent === true,
    parentComboId: normalizeText(line.parentComboId),
    parentLineId: normalizeText(line.parentLineId),
    parentComboNameVi: normalizeText(line.parentComboNameVi),
    parentComboNameEn: normalizeText(line.parentComboNameEn),
    parentComboOptionSummaryVi: Array.isArray(line.parentComboOptionSummaryVi) ? line.parentComboOptionSummaryVi : [],
    parentComboOptionSummaryEn: Array.isArray(line.parentComboOptionSummaryEn) ? line.parentComboOptionSummaryEn : [],
    configuredKey: normalizeText(line.configuredKey),
    configuredOptions: line.configuredOptions ?? null,
    optionSnapshot: line.optionSnapshot ?? null,
    course: normalizeText(line.course),
    holdState: normalizeText(line.holdState || "FIRED").toUpperCase(),
    heldAt: normalizeIso(line.heldAt),
    firedAt: normalizeIso(line.firedAt),
    queuedAt: normalizeIso(line.queuedAt),
    acknowledgedAt: normalizeIso(line.acknowledgedAt),
    prepStartedAt: normalizeIso(line.prepStartedAt),
    readyAt: normalizeIso(line.readyAt),
    servedAt: normalizeIso(line.servedAt)
  });
}

function normalizeLegacyPayment(payment = {}) {
  return compact({
    id: normalizeText(payment.id),
    type: normalizeText(payment.type || "PAYMENT").toUpperCase(),
    method: normalizeText(payment.method || "CASH").toUpperCase(),
    provider: normalizeText(payment.provider || "MANUAL"),
    amountVnd: positiveInteger(payment.amountVnd ?? payment.amount, 0),
    relatedPaymentId: normalizeText(payment.relatedPaymentId),
    tenderGroupId: normalizeText(payment.tenderGroupId),
    createdAt: normalizeIso(payment.createdAt),
    note: normalizeText(payment.note)
  });
}

function normalizeLegacyServiceRequest(item = {}) {
  return compact({
    id: normalizeText(item.id),
    tableSessionId: normalizeText(item.tableSessionId),
    table: normalizeText(item.table),
    zone: normalizeText(item.zone),
    type: normalizeText(item.type || "CALL_STAFF").toUpperCase(),
    status: item.done ? "COMPLETED" : normalizeText(item.status || "OPEN").toUpperCase(),
    createdAt: normalizeIso(item.createdAt),
    completedAt: normalizeIso(item.completedAt)
  });
}

function normalizeLegacyAuditEvent(item = {}) {
  return compact({
    id: normalizeText(item.id),
    command: normalizeText(item.command || item.action || "legacy_event"),
    targetType: normalizeText(item.targetType),
    targetId: normalizeText(item.targetId),
    outcome: normalizeText(item.outcome || "LEGACY"),
    correlationId: normalizeText(item.correlationId),
    createdAt: normalizeIso(item.createdAt || item.at),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {}
  });
}

function normalizeLegacyProduct(item = {}) {
  return compact({
    id: normalizeText(item.id),
    available: item.available !== false,
    updatedAt: normalizeIso(item.updatedAt)
  });
}

function normalizeRpcResult(data, correlationId) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return failure("BACKEND_UNAVAILABLE", "EMPTY_RPC_RESULT", correlationId);
  return {
    ok: row.ok === true,
    category: normalizeText(row.category || (row.ok ? "OK" : "VALIDATION_ERROR")),
    reason: normalizeText(row.reason),
    entityType: normalizeText(row.entity_type || row.entityType),
    entityId: normalizeText(row.entity_id || row.entityId),
    version: row.version ?? null,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    correlationId
  };
}

function failure(category, reason, correlationId = "") {
  return { ok: false, category, reason, entityType: "", entityId: "", version: null, payload: {}, correlationId };
}

function readDeviceCredential(storage) {
  try {
    return normalizeText(storage?.getItem?.("deedou_device_credential"));
  } catch {
    return "";
  }
}

function sanitizeTransportError(error) {
  const code = normalizeText(error?.code || error?.name || "BACKEND_REQUEST_FAILED");
  return code.replace(/[^A-Za-z0-9:_-]+/g, "_").slice(0, 120) || "BACKEND_REQUEST_FAILED";
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function normalizeIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}
