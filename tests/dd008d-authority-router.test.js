import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKEND_MODES,
  OPERATIONAL_STATES,
  createAuthoritativeBackendApi
} from "../src/shared/backend/index.js";

const config = {
  mode: BACKEND_MODES.SUPABASE,
  supabaseUrl: "https://deedou-test.supabase.co",
  supabasePublishableKey: "sb_publishable_test_key"
};

test("DD-008D ADMIN authority uses menu-only snapshot and admin realtime audience without orders.read", async () => {
  const calls = [];
  const channels = [];
  const client = {
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === "dd008d_get_admin_menu_snapshot") {
        return {
          data: [{
            ok: true,
            category: "OK",
            entity_type: "admin_menu",
            entity_id: "deedou-demo",
            payload: {
              locationId: "deedou-demo",
              products: [{
                id: "fried-rice",
                kind: "FOOD",
                category: "rice",
                nameVi: "Cơm chiên hải sản",
                nameEn: "Seafood Fried Rice",
                priceVnd: 99000,
                available: true,
                periods: []
              }]
            }
          }],
          error: null
        };
      }
      if (name === "dd008c_issue_realtime_ticket") {
        assert.equal(params.p_audience, "admin");
        return {
          data: [{
            ok: true,
            category: "OK",
            entity_type: "realtime_subscription",
            entity_id: "admin-ticket",
            payload: { topic: "location:deedou-demo:admin:admin-ticket" }
          }],
          error: null
        };
      }
      if (name === "dd008c_get_location_snapshot") {
        throw new Error("ADMIN must not request order/location snapshot");
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    channel(topic, options) {
      calls.push({ name: "channel", topic, options });
      const channel = {
        handler: null,
        on(_type, _filter, handler) {
          this.handler = handler;
          return this;
        },
        subscribe(callback) {
          queueMicrotask(() => callback("SUBSCRIBED"));
          return this;
        },
        unsubscribe() {}
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
      return { ok: true, session: { userId: "admin-1", userEmail: "admin@example.test" } };
    },
    onAuthStateChange(callback) {
      authListeners.add(callback);
      return { unsubscribe: () => authListeners.delete(callback) };
    }
  };
  const authState = {
    locationId: "deedou-demo",
    workstationMode: "ADMIN",
    authorization: { ok: true, workstationMode: "ADMIN" },
    staffContext: [{ locationId: "deedou-demo", roles: ["ADMIN_MENU"], permissions: ["menu.read", "menu.manage"] }]
  };
  const api = createAuthoritativeBackendApi({
    config,
    authApi,
    deviceStorage: { getItem: (key) => key === "deedou_device_credential" ? "admin-device" : null },
    authStateRef: () => authState
  });

  const first = await api.fetchStaffSnapshot({ locationId: "deedou-demo" });
  assert.equal(first.ok, true);
  assert.deepEqual(first.payload.orders, []);
  assert.deepEqual(first.payload.tableSessions, []);
  assert.deepEqual(first.payload.events, []);
  assert.equal(first.payload.products[0].id, "fried-rice");
  assert.deepEqual(first.payload.products[0].periods, []);
  assert.equal(calls.some((call) => call.name === "dd008c_get_location_snapshot"), false);

  let refreshCount = 0;
  const subscription = api.subscribeLocationRefresh({
    locationId: "deedou-demo",
    async onRefresh() {
      refreshCount += 1;
      await api.fetchStaffSnapshot({ locationId: "deedou-demo" });
    },
    onError(error) {
      throw error;
    }
  });

  await waitFor(() => api.operational.getState().state === OPERATIONAL_STATES.ONLINE);
  assert.equal(refreshCount, 1);
  const ticketCalls = calls.filter((call) => call.name === "dd008c_issue_realtime_ticket");
  assert.equal(ticketCalls.length, 1);
  assert.equal(ticketCalls[0].params.p_audience, "admin");
  assert.equal(calls.some((call) => call.name === "dd008c_get_location_snapshot"), false);
  assert.deepEqual(calls.find((call) => call.name === "channel")?.options, { config: { private: true } });

  channels[0].handler?.({ payload: { entityType: "product", entityId: "fried-rice", available: false } });
  await waitFor(() => refreshCount === 2);
  assert.equal(api.operational.getState().state, OPERATIONAL_STATES.ONLINE);

  subscription.unsubscribe();
});

async function waitFor(predicate, timeoutMs = 1200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}
