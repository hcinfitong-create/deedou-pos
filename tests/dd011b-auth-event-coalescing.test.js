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
