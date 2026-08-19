import test from "node:test";
import assert from "node:assert/strict";

import { BACKEND_MODES, createAdminBackendApi } from "../src/shared/backend/index.js";

const config = {
  mode: BACKEND_MODES.SUPABASE,
  supabaseUrl: "https://deedou-test.supabase.co",
  supabasePublishableKey: "sb_publishable_test_key"
};

function harness() {
  const calls = [];
  const channels = [];
  const client = {
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === "dd008d_get_admin_menu_snapshot") {
        return { data: [{ ok: true, category: "OK", payload: { products: [{ id: "fried-rice", available: true }] } }], error: null };
      }
      if (name === "dd008d_set_product_availability") {
        return { data: [{ ok: true, category: "OK", entity_type: "product", entity_id: params.p_product_id, payload: { product: { id: params.p_product_id, available: params.p_available } } }], error: null };
      }
      if (name === "dd008c_issue_realtime_ticket") {
        return {
          data: [{
            ok: true,
            category: "OK",
            entity_type: "realtime_subscription",
            entity_id: "ticket-admin-1",
            payload: { topic: "location:deedou-demo:admin:ticket-admin-1", audience: "admin" }
          }],
          error: null
        };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    channel(topic, options) {
      calls.push({ name: "channel", topic, options });
      const channel = {
        handler: null,
        unsubscribed: false,
        on(type, filter, handler) {
          calls.push({ name: "on", type, filter, topic });
          this.handler = handler;
          return this;
        },
        subscribe(callback) {
          calls.push({ name: "subscribe", topic });
          queueMicrotask(() => callback("SUBSCRIBED"));
          return this;
        },
        unsubscribe() {
          this.unsubscribed = true;
          calls.push({ name: "unsubscribe", topic });
        }
      };
      channels.push(channel);
      return channel;
    }
  };
  const api = createAdminBackendApi({
    config,
    authApi: {
      async getClient() {
        return client;
      }
    },
    deviceStorage: {
      getItem(key) {
        return key === "deedou_device_credential" ? "admin-device" : null;
      }
    },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls, channels };
}

test("DD-008D admin adapter carries authoritative device/location context", async () => {
  const { api, calls } = harness();
  const result = await api.fetchMenu();
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "dd008d_get_admin_menu_snapshot");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "admin-device");
});

test("DD-008D availability adapter sends optimistic token and idempotency key", async () => {
  const { api, calls } = harness();
  const result = await api.setProductAvailability({
    productId: "fried-rice",
    available: false,
    expectedUpdatedAt: "2026-08-16T00:00:00.000Z",
    idempotencyKey: "availability-1"
  });
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.name, "dd008d_set_product_availability");
  assert.equal(call.params.p_product_id, "fried-rice");
  assert.equal(call.params.p_available, false);
  assert.equal(call.params.p_expected_updated_at, "2026-08-16T00:00:00.000Z");
  assert.equal(call.params.p_idempotency_key, "availability-1");
});

test("DD-008D admin realtime adapter requests ticketed private admin audience", async () => {
  const { api, calls, channels } = harness();
  let refreshPayload = null;
  const subscription = await api.subscribeMenuRefresh({
    onRefresh(payload) {
      refreshPayload = payload;
    }
  });

  assert.equal(subscription.ok, true);
  const ticketCall = calls.find((call) => call.name === "dd008c_issue_realtime_ticket");
  assert.ok(ticketCall);
  assert.equal(ticketCall.params.p_location_id, "deedou-demo");
  assert.equal(ticketCall.params.p_audience, "admin");
  assert.equal(ticketCall.params.p_workstation_mode, "ADMIN");
  assert.equal(ticketCall.params.p_device_credential, "admin-device");

  const channelCall = calls.find((call) => call.name === "channel");
  assert.equal(channelCall.topic, "location:deedou-demo:admin:ticket-admin-1");
  assert.deepEqual(channelCall.options, { config: { private: true } });
  assert.equal(channels.length, 1);

  channels[0].handler({ payload: { entityType: "product", entityId: "fried-rice", available: false } });
  assert.deepEqual(refreshPayload, { entityType: "product", entityId: "fried-rice", available: false });

  subscription.unsubscribe();
  assert.equal(channels[0].unsubscribed, true);
});

test("DD-008D admin adapter fails closed without device credential", async () => {
  let rpcCalled = false;
  const api = createAdminBackendApi({
    config,
    authApi: { getClient: async () => ({ rpc: async () => { rpcCalled = true; return { data: [], error: null }; } }) },
    deviceStorage: { getItem: () => null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  const result = await api.fetchMenu();
  assert.equal(result.ok, false);
  assert.equal(result.category, "FORBIDDEN");
  assert.equal(result.reason, "ADMIN_CONTEXT_INCOMPLETE");
  assert.equal(rpcCalled, false);
});
