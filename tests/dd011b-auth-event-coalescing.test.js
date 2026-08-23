import test from "node:test";
import assert from "node:assert/strict";

import { createSupabasePasswordAuthApi } from "../src/shared/auth/index.js";

const config = {
  mode: "SUPABASE",
  supabaseUrl: "https://deedou-demo.supabase.co",
  supabasePublishableKey: "sb_publishable_demo_key"
};

test("DD011B coalesces repeated stable auth events without hiding security-significant changes", async () => {
  let authStateCallback = null;
  let unsubscribed = false;
  const delivered = [];

  const api = createSupabasePasswordAuthApi({
    config,
    client: {
      auth: {
        onAuthStateChange(callback) {
          authStateCallback = callback;
          return {
            data: {
              subscription: {
                unsubscribe() {
                  unsubscribed = true;
                }
              }
            }
          };
        }
      }
    }
  });

  const subscription = api.onAuthStateChange((event) => delivered.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof authStateCallback, "function");

  const userA = { user: { id: "user-a", email: "a@example.invalid" } };
  const userB = { user: { id: "user-b", email: "b@example.invalid" } };

  authStateCallback("SIGNED_IN", userA);
  authStateCallback("SIGNED_IN", userA);
  authStateCallback("TOKEN_REFRESHED", userA);
  authStateCallback("MFA_CHALLENGE_VERIFIED", userA);
  authStateCallback("SIGNED_OUT", null);
  authStateCallback("SIGNED_IN", userA);
  authStateCallback("SIGNED_IN", userB);

  assert.deepEqual(delivered.map(({ event, session }) => [event, session?.userId || ""]), [
    ["SIGNED_IN", "user-a"],
    ["MFA_CHALLENGE_VERIFIED", "user-a"],
    ["SIGNED_OUT", ""],
    ["SIGNED_IN", "user-a"],
    ["SIGNED_IN", "user-b"]
  ]);

  subscription.unsubscribe();
  assert.equal(unsubscribed, true);
});

test("DD011B password sign-in event does not invalidate the caller's in-flight authorization", async () => {
  let authStateCallback = null;
  const delivered = [];
  const user = { user: { id: "admin-user", email: "admin@example.invalid" } };

  const client = {
    auth: {
      onAuthStateChange(callback) {
        authStateCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithPassword() {
        authStateCallback?.("SIGNED_IN", user);
        return { data: { session: user }, error: null };
      }
    }
  };

  const api = createSupabasePasswordAuthApi({ config, client });
  api.onAuthStateChange((event) => delivered.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof authStateCallback, "function");

  const signedIn = await api.signInWithPassword({ email: "admin@example.invalid", password: "test-password" });
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.session.userId, "admin-user");
  assert.deepEqual(delivered, [], "SIGNED_IN emitted by the same password sign-in must not reset route authorization state");

  authStateCallback("SIGNED_IN", user);
  authStateCallback("TOKEN_REFRESHED", user);
  assert.deepEqual(delivered, [], "stable events for the same authenticated identity remain coalesced");

  authStateCallback("MFA_CHALLENGE_VERIFIED", user);
  assert.deepEqual(delivered.map(({ event }) => event), ["MFA_CHALLENGE_VERIFIED"]);
});

test("DD011B late empty initial session cannot clobber a completed password sign-in", async () => {
  let authStateCallback = null;
  const delivered = [];
  const user = { user: { id: "admin-user", email: "admin@example.invalid" } };

  const client = {
    auth: {
      onAuthStateChange(callback) {
        authStateCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithPassword() {
        return { data: { session: user }, error: null };
      }
    }
  };

  const api = createSupabasePasswordAuthApi({ config, client });
  api.onAuthStateChange((event) => delivered.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof authStateCallback, "function");

  const signedIn = await api.signInWithPassword({ email: "admin@example.invalid", password: "test-password" });
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.session.userId, "admin-user");

  authStateCallback("INITIAL_SESSION", null);
  authStateCallback("SIGNED_IN", user);
  assert.deepEqual(delivered, [], "a stale empty INITIAL_SESSION after interactive sign-in must not reset authorization state");

  authStateCallback("SIGNED_OUT", null);
  assert.deepEqual(delivered.map(({ event }) => event), ["SIGNED_OUT"], "real sign-out must still invalidate the session");
});
