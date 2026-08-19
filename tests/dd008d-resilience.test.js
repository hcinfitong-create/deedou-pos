import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_HEALTH_STATES,
  BACKEND_MODES,
  CUTOVER_STAGES,
  OPERATIONAL_STATES,
  REALTIME_HEALTH_STATES,
  buildLegacyExport,
  createLegacyMigrationApi,
  createOperationalStateController,
  createReconnectCoordinator,
  cutoverPolicy,
  getCutoverStage,
  previewLegacyExport,
  sanitizeOperationalDiagnostic
} from "../src/shared/backend/index.js";

const publicConfig = {
  mode: "SUPABASE",
  supabaseUrl: "https://deedou-demo.supabase.co",
  supabasePublishableKey: "sb_publishable_demo_key"
};

test("DD-008D cutover policy is explicit and never enables dual write", () => {
  assert.equal(getCutoverStage({}), CUTOVER_STAGES.LOCAL_DEMO);
  assert.equal(getCutoverStage({ ...publicConfig, mode: "SUPABASE_TEST" }), CUTOVER_STAGES.SUPABASE_TEST);
  assert.equal(getCutoverStage({ ...publicConfig, mode: "SUPABASE_AUTHORITATIVE" }), CUTOVER_STAGES.SUPABASE_AUTHORITATIVE);
  assert.equal(getCutoverStage(publicConfig), CUTOVER_STAGES.SUPABASE_AUTHORITATIVE);

  const authoritative = cutoverPolicy(publicConfig);
  assert.equal(authoritative.serverAuthority, true);
  assert.equal(authoritative.allowLocalBusinessWrites, false);
  assert.equal(authoritative.allowLegacyAutoImport, false);
  assert.equal(authoritative.allowDualWrite, false);
});

test("DD-008D operational state requires backend, auth, realtime, and a fresh authoritative refetch", () => {
  let now = Date.parse("2026-08-16T01:00:00+07:00");
  const controller = createOperationalStateController({
    mode: BACKEND_MODES.SUPABASE,
    staleAfterMs: 10_000,
    clock: () => now
  });

  assert.equal(controller.getState().state, OPERATIONAL_STATES.OFFLINE);
  controller.beginReconnect();
  assert.equal(controller.getState().state, OPERATIONAL_STATES.RECONNECTING);
  controller.markBackendProbe({ ok: true });
  controller.markAuth(AUTH_HEALTH_STATES.AUTHENTICATED);
  controller.markRealtime(REALTIME_HEALTH_STATES.SUBSCRIBED);
  assert.equal(controller.getState().state, OPERATIONAL_STATES.RECONNECTING);
  controller.markAuthoritativeRefresh({ correlationId: "refresh:1" });
  assert.equal(controller.getState().state, OPERATIONAL_STATES.ONLINE);

  now += 11_000;
  assert.equal(controller.getState().state, OPERATIONAL_STATES.STALE);
  const degradedWrite = controller.mutationGuard("record_order_payment");
  assert.equal(degradedWrite.ok, true);
  assert.equal(degradedWrite.reason, "AUTHORITATIVE_WRITE_ALLOWED_WITH_REFETCH_REQUIRED");

  controller.markBackendProbe({ ok: false, reason: "network failed" });
  assert.equal(controller.getState().state, OPERATIONAL_STATES.OFFLINE);
  assert.deepEqual(controller.mutationGuard("record_order_payment"), {
    ok: false,
    category: "BACKEND_UNAVAILABLE",
    reason: "OFFLINE_WRITE_BLOCKED",
    commandName: "record_order_payment"
  });
});

test("DD-008D terminal auth/realtime recovery failures do not remain stuck RECONNECTING", () => {
  const controller = createOperationalStateController({ mode: BACKEND_MODES.SUPABASE });
  controller.beginReconnect();
  controller.markBackendProbe({ ok: true });
  controller.markAuth(AUTH_HEALTH_STATES.UNAUTHENTICATED, "SIGN_IN_REQUIRED");
  assert.equal(controller.getState().state, OPERATIONAL_STATES.DEGRADED);

  controller.beginReconnect();
  controller.markAuth(AUTH_HEALTH_STATES.AUTHENTICATED);
  controller.markRealtime(REALTIME_HEALTH_STATES.ERROR, "CHANNEL_ERROR");
  assert.equal(controller.getState().state, OPERATIONAL_STATES.DEGRADED);
});

test("DD-008D reconnect coordinator waits for private realtime then authoritative refetch before ONLINE", async () => {
  let now = Date.parse("2026-08-16T01:00:00+07:00");
  const controller = createOperationalStateController({ mode: BACKEND_MODES.SUPABASE, clock: () => now });
  const calls = [];
  const channels = [];
  const fakeClient = {
    channel(topic, options) {
      calls.push(["channel", topic, options]);
      const channel = {
        handler: null,
        on(type, filter, handler) {
          calls.push(["on", type, filter.event]);
          this.handler = handler;
          return this;
        },
        subscribe(callback) {
          calls.push(["subscribe", topic]);
          queueMicrotask(() => callback("SUBSCRIBED"));
          return this;
        },
        unsubscribe() {
          calls.push(["unsubscribe", topic]);
        }
      };
      channels.push(channel);
      return channel;
    }
  };
  let snapshotCount = 0;
  const coordinator = createReconnectCoordinator({
    mode: BACKEND_MODES.SUPABASE,
    authApi: {
      getSessionInfo: async () => ({ ok: true, session: { userId: "staff-1" } }),
      getClient: async () => fakeClient
    },
    backendApi: {
      issueRealtimeTicket: async ({ audience }) => {
        calls.push(["ticket", audience]);
        return { ok: true, payload: { topic: `location:deedou-demo:${audience}:ticket` } };
      },
      fetchStaffSnapshot: async () => {
        calls.push(["snapshot"]);
        return { ok: true, payload: { orders: [{ id: "O1", version: 4 }] } };
      }
    },
    operationalController: controller,
    onSnapshot(snapshot) {
      snapshotCount += 1;
      assert.equal(snapshot.orders[0].version, 4);
    },
    subscribeTimeoutMs: 200
  });

  const result = await coordinator.recover({ locationId: "deedou-demo", audiences: ["ops", "cashier"] });
  assert.equal(result.ok, true);
  assert.equal(snapshotCount, 1);
  assert.equal(coordinator.subscriptionCount, 2);
  assert.equal(controller.getState().state, OPERATIONAL_STATES.ONLINE);
  assert.equal(calls.filter(([type]) => type === "subscribe").length, 2);
  assert.equal(calls.filter(([type]) => type === "snapshot").length, 1);
  assert.ok(calls.findIndex(([type]) => type === "subscribe") < calls.findIndex(([type]) => type === "snapshot"));

  now += 1000;
  channels[0].handler?.({ payload: { entityType: "order", entityId: "O1", correlationId: "dbtx:123" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter(([type]) => type === "snapshot").length, 2);
  assert.equal(controller.getState().lastCorrelationId, "dbtx:123");

  coordinator.disconnect();
  assert.equal(coordinator.subscriptionCount, 0);
  assert.equal(controller.getState().realtimeState, REALTIME_HEALTH_STATES.DISCONNECTED);
});

test("DD-008D reconnect refuses to declare ONLINE when auth is missing", async () => {
  const controller = createOperationalStateController({ mode: BACKEND_MODES.SUPABASE });
  const coordinator = createReconnectCoordinator({
    mode: BACKEND_MODES.SUPABASE,
    authApi: { getSessionInfo: async () => ({ ok: true, session: null }) },
    backendApi: {},
    operationalController: controller
  });

  const result = await coordinator.recover({ locationId: "deedou-demo" });
  assert.equal(result.ok, false);
  assert.equal(result.category, "UNAUTHENTICATED");
  assert.equal(controller.getState().state, OPERATIONAL_STATES.DEGRADED);
});

test("DD-008D diagnostics strip secret-like fields", () => {
  assert.deepEqual(sanitizeOperationalDiagnostic({
    state: "OFFLINE",
    accessToken: "must-not-leak",
    nested: { password: "must-not-leak", reason: "NETWORK" },
    lastCommandFailureCode: "BACKEND_UNAVAILABLE"
  }), {
    state: "OFFLINE",
    nested: { reason: "NETWORK" },
    lastCommandFailureCode: "BACKEND_UNAVAILABLE"
  });
});

test("DD-008D legacy export is explicit, previewable, and preserves operational identifiers", () => {
  const bundle = buildLegacyExport({
    locationId: "deedou-demo",
    exportedAt: "2026-08-15T18:00:00.000Z",
    products: [{ id: "fried-rice", available: true }],
    state: {
      tableSessions: [{ id: "TS-1", tableCode: "A01", status: "CLOSED", openedAt: "2026-08-15T10:00:00Z", closedAt: "2026-08-15T11:00:00Z" }],
      orders: [{
        id: "ORD-1",
        orderNo: "D0001",
        tableSessionId: "TS-1",
        table: "A01",
        status: "PAID",
        total: 99000,
        items: [{
          id: "fried-rice",
          lineId: "fried-rice:1:item",
          configuredKey: "fried-rice|v:regular",
          optionSnapshot: { variant: { id: "regular" } },
          course: "1",
          holdState: "FIRED",
          firedAt: "2026-08-15T10:05:00Z",
          qty: 1,
          billQty: 1,
          servedQty: 1,
          price: 99000,
          station: "KITCHEN_HOT"
        }],
        payments: [{ id: "PAY-1", type: "PAYMENT", method: "CASH", amountVnd: 99000, createdAt: "2026-08-15T11:00:00Z" }]
      }],
      events: [{ id: "SR-1", tableSessionId: "TS-1", table: "A01", type: "CALL_STAFF", done: true, createdAt: "2026-08-15T10:30:00Z" }],
      audit: []
    }
  });

  assert.equal(bundle.orders[0].id, "ORD-1");
  assert.equal(bundle.orders[0].items[0].lineId, "fried-rice:1:item");
  assert.equal(bundle.orders[0].items[0].configuredKey, "fried-rice|v:regular");
  assert.equal(bundle.orders[0].payments[0].id, "PAY-1");
  assert.equal(bundle.serviceRequests[0].id, "SR-1");

  const preview = previewLegacyExport(bundle);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.counts, {
    tableSessions: 1,
    orders: 1,
    orderLines: 1,
    payments: 1,
    serviceRequests: 1,
    audit: 0,
    products: 1
  });
});

test("DD-008D migration adapter requires authenticated device context and sends no automatic import", async () => {
  const calls = [];
  const api = createLegacyMigrationApi({
    config: publicConfig,
    authApi: {
      getClient: () => ({
        rpc: async (name, params) => {
          calls.push({ name, params });
          return { data: [{ ok: true, category: "OK", payload: { preview: true } }], error: null };
        }
      })
    },
    deviceStorage: {
      getItem(key) {
        return key === "deedou_device_credential" ? "device-credential" : null;
      }
    },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });

  const result = await api.preview({ bundle: { schemaVersion: 1 }, importKey: "preview-1" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "dd008d_preview_legacy_import");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "device-credential");
  assert.match(calls[0].params.p_correlation_id, /^legacy:/);
});
