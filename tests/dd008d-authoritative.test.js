import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_HEALTH_STATES,
  BACKEND_MODES,
  OPERATIONAL_STATES,
  REALTIME_HEALTH_STATES,
  createAuthoritativeBackendApi
} from "../src/shared/backend/index.js";

const config = {
  mode: BACKEND_MODES.SUPABASE,
  supabaseUrl: "https://deedou-test.supabase.co",
  supabasePublishableKey: "sb_publishable_test_key"
};

function createHarness() {
  const calls = [];
  const channels = [];
  const storage = {
    getItem(key) {
      return key === "deedou_device_credential" ? "device-credential" : null;
    }
  };
  const client = {
    async rpc(name, params) {
      calls.push(["rpc", name, params]);
      if (name === "dd008c_get_location_snapshot") {
        return { data: [{ ok: true, category: "OK", entity_type: "location", entity_id: "deedou-demo", payload: { locationId: "deedou-demo", orders: [] } }], error: null };
      }
      if (name === "dd008c_issue_realtime_ticket") {
        return { data: [{ ok: true, category: "OK", payload: { topic: `location:deedou-demo:${params.p_audience}:ticket-id` } }], error: null };
      }
      if (name === "record_order_payment") {
        return { data: [{ ok: true, category: "OK", entity_type: "payment", entity_id: "PAY-1", payload: { order: { id: "ORD-1" } } }], error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    channel(topic, options) {
      calls.push(["channel", topic, options]);
      const channel = {
        handler: null,
        statusCallback: null,
        on(type, filter, handler) {
          calls.push(["on", topic, type, filter.event]);
          this.handler = handler;
          return this;
        },
        subscribe(callback) {
          this.statusCallback = callback;
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
  const authListeners = new Set();
  const authApi = {
    async getClient() {
      return client;
    },
    async getSessionInfo() {
      calls.push(["session"]);
      return { ok: true, session: { userId: "staff-1", userEmail: "staff@example.test" } };
    },
    onAuthStateChange(callback) {
      authListeners.add(callback);
      return { unsubscribe: () => authListeners.delete(callback) };
    }
  };
  const authState = {
    locationId: "deedou-demo",
    workstationMode: "CASHIER",
    authorization: { ok: true, workstationMode: "CASHIER" },
    staffContext: [{ locationId: "deedou-demo", permissions: ["orders.read", "payments.read", "payments.record"] }]
  };
  return { calls, channels, storage, client, authApi, authState, authListeners };
}

test("DD-008D resilient adapter blocks staff mutations until authority is reachable", async () => {
  const harness = createHarness();
  const api = createAuthoritativeBackendApi({
    config,
    authApi: harness.authApi,
    deviceStorage: harness.storage,
    authStateRef: () => harness.authState
  });

  const blocked = await api.recordOrderPayment({ orderId: "ORD-1", method: "CASH", amountVnd: 1000, idempotencyKey: "pay-1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.category, "BACKEND_UNAVAILABLE");
  assert.equal(blocked.reason, "OFFLINE_WRITE_BLOCKED");
  assert.equal(harness.calls.some(([kind, name]) => kind === "rpc" && name === "record_order_payment"), false);

  const snapshot = await api.fetchStaffSnapshot({ locationId: "deedou-demo" });
  assert.equal(snapshot.ok, true);
  assert.equal(api.operational.getState().backendHealthy, true);
  assert.equal(api.operational.getState().authState, AUTH_HEALTH_STATES.AUTHENTICATED);
  assert.equal(api.operational.getState().state, OPERATIONAL_STATES.DEGRADED);

  const payment = await api.recordOrderPayment({ orderId: "ORD-1", method: "CASH", amountVnd: 1000, idempotencyKey: "pay-2" });
  assert.equal(payment.ok, true);
  assert.equal(harness.calls.filter(([kind, name]) => kind === "rpc" && name === "record_order_payment").length, 1);
});

test("DD-008D resilient realtime declares ONLINE only after subscription and authoritative refetch", async () => {
  const harness = createHarness();
  let api;
  let syntheticRefreshes = 0;
  api = createAuthoritativeBackendApi({
    config,
    authApi: harness.authApi,
    deviceStorage: harness.storage,
    authStateRef: () => harness.authState
  });

  const subscription = api.subscribeLocationRefresh({
    locationId: "deedou-demo",
    async onRefresh(event) {
      if (event?.reconnect) syntheticRefreshes += 1;
      await api.fetchStaffSnapshot({ locationId: "deedou-demo" });
    },
    onError(error) {
      throw error;
    }
  });

  await waitFor(() => api.operational.getState().state === OPERATIONAL_STATES.ONLINE);
  assert.equal(syntheticRefreshes, 1);
  assert.equal(api.operational.getState().realtimeState, REALTIME_HEALTH_STATES.SUBSCRIBED);
  assert.equal(harness.calls.filter(([kind, name]) => kind === "rpc" && name === "dd008c_issue_realtime_ticket").length, 2);
  assert.equal(harness.calls.filter(([kind, name]) => kind === "rpc" && name === "dd008c_get_location_snapshot").length, 1);

  const firstChannel = harness.channels[0];
  firstChannel.handler?.({ payload: { locationId: "deedou-demo", audience: "ops", entityType: "order", entityId: "ORD-2" } });
  await waitFor(() => harness.calls.filter(([kind, name]) => kind === "rpc" && name === "dd008c_get_location_snapshot").length >= 2);

  subscription.unsubscribe();
  assert.equal(api.operational.getState().realtimeState, REALTIME_HEALTH_STATES.DISCONNECTED);
});

test("DD-008D channel terminal state schedules a ticketed reconnect instead of trusting navigator state", async () => {
  const harness = createHarness();
  let api;
  api = createAuthoritativeBackendApi({
    config,
    authApi: harness.authApi,
    deviceStorage: harness.storage,
    authStateRef: () => harness.authState
  });
  const subscription = api.subscribeLocationRefresh({
    locationId: "deedou-demo",
    onRefresh: async (event) => {
      if (event?.reconnect) await api.fetchStaffSnapshot({ locationId: "deedou-demo" });
    },
    onError() {}
  });

  await waitFor(() => api.operational.getState().state === OPERATIONAL_STATES.ONLINE);
  const ticketCountBefore = harness.calls.filter(([kind, name]) => kind === "rpc" && name === "dd008c_issue_realtime_ticket").length;
  harness.channels[0].statusCallback?.("CHANNEL_ERROR");
  await waitFor(() => harness.calls.filter(([kind, name]) => kind === "rpc" && name === "dd008c_issue_realtime_ticket").length > ticketCountBefore, 2500);
  assert.ok([OPERATIONAL_STATES.RECONNECTING, OPERATIONAL_STATES.DEGRADED, OPERATIONAL_STATES.ONLINE].includes(api.operational.getState().state));

  subscription.unsubscribe();
});

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}
