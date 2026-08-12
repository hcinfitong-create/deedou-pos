import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BACKEND_MODES,
  CONNECTION_STATES,
  createBackendClient,
  getBackendConfig,
  getBackendMode,
  getConnectionState,
  probeBackendConnection,
  subscribeConnectionState,
  validatePublicBackendConfig
} from "../src/shared/backend/index.js";

const migrationSql = readFileSync(new URL("../supabase/migrations/20260812000000_dd008a_backend_foundation.sql", import.meta.url), "utf8");
const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

const exposedTables = Object.freeze([
  "locations",
  "physical_tables",
  "products",
  "product_variants",
  "modifier_groups",
  "modifier_options",
  "product_modifier_groups",
  "product_components",
  "table_sessions",
  "orders",
  "order_lines",
  "service_requests",
  "payment_transactions",
  "idempotency_keys",
  "audit_events",
  "command_deduplication"
]);

test("backend mode defaults to LOCAL_DEMO", () => {
  assert.equal(getBackendMode({}), BACKEND_MODES.LOCAL_DEMO);
  assert.deepEqual(getBackendConfig({}), {
    mode: BACKEND_MODES.LOCAL_DEMO,
    reason: "LOCAL_DEMO_DEFAULT",
    isConfigured: false,
    supabaseUrl: "",
    supabasePublishableKey: ""
  });
});

test("SUPABASE mode requires complete public configuration", () => {
  const config = getBackendConfig({
    mode: "SUPABASE",
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: "sb_publishable_demo_key"
  });

  assert.equal(config.mode, BACKEND_MODES.SUPABASE);
  assert.equal(config.isConfigured, true);
  assert.equal(config.supabaseUrl, "https://deedou-demo.supabase.co");
  assert.equal(config.supabasePublishableKey, "sb_publishable_demo_key");
});

test("partial SUPABASE configuration fails safely to LOCAL_DEMO", () => {
  const missingKey = getBackendConfig({ mode: "SUPABASE", supabaseUrl: "https://deedou-demo.supabase.co" });
  const missingUrl = getBackendConfig({ mode: "SUPABASE", supabasePublishableKey: "sb_publishable_demo_key" });

  assert.equal(missingKey.mode, BACKEND_MODES.LOCAL_DEMO);
  assert.equal(missingKey.reason, "SUPABASE_CONFIG_INCOMPLETE");
  assert.equal(missingUrl.mode, BACKEND_MODES.LOCAL_DEMO);
  assert.equal(missingUrl.reason, "SUPABASE_CONFIG_INCOMPLETE");
});

test("browser backend config rejects obvious service and secret keys", () => {
  [
    { serviceRoleKey: "service_role_key_must_not_be_public" },
    { supabasePublishableKey: "sb_secret_obvious_server_secret" },
    { supabaseUrl: "postgresql://user:pass@example.com:5432/postgres" },
    { privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }
  ].forEach((config) => {
    assert.equal(validatePublicBackendConfig(config).ok, false);
    assert.equal(getBackendConfig({ mode: "SUPABASE", ...config }).mode, BACKEND_MODES.LOCAL_DEMO);
  });
});

test("backend client setup uses injected Supabase factory and actual probe for ONLINE", async () => {
  const observedStates = [];
  const unsubscribe = subscribeConnectionState((state) => observedStates.push(state.state));
  const fakeClient = {
    from(tableName) {
      assert.equal(tableName, "public_backend_health");
      return {
        select(columns) {
          assert.equal(columns, "ok");
          return {
            limit(count) {
              assert.equal(count, 1);
              return Promise.resolve({ data: [{ ok: true }], error: null });
            }
          };
        }
      };
    }
  };

  const created = createBackendClient({
    config: {
      mode: "SUPABASE",
      supabaseUrl: "https://deedou-demo.supabase.co",
      supabasePublishableKey: "sb_publishable_demo_key"
    },
    supabaseFactory(url, key, options) {
      assert.equal(url, "https://deedou-demo.supabase.co");
      assert.equal(key, "sb_publishable_demo_key");
      assert.equal(options.auth.persistSession, false);
      return fakeClient;
    }
  });

  assert.equal(created.ok, true);
  assert.equal(getConnectionState().state, CONNECTION_STATES.CONNECTING);

  const probed = await probeBackendConnection(created.client);
  assert.equal(probed.state, CONNECTION_STATES.ONLINE);
  assert.ok(observedStates.includes(CONNECTION_STATES.CONNECTING));
  assert.ok(observedStates.includes(CONNECTION_STATES.ONLINE));
  unsubscribe();
});

test("backend client setup never reports ONLINE without a Supabase factory and probe", () => {
  const created = createBackendClient({
    config: {
      mode: "SUPABASE",
      supabaseUrl: "https://deedou-demo.supabase.co",
      supabasePublishableKey: "sb_publishable_demo_key"
    },
    globalObject: {}
  });

  assert.equal(created.ok, false);
  assert.equal(created.reason, "SUPABASE_CLIENT_FACTORY_MISSING");
  assert.equal(getConnectionState().state, CONNECTION_STATES.ERROR);
});

test("all exposed backend tables enable RLS", () => {
  exposedTables.forEach((tableName) => {
    assert.match(migrationSql, new RegExp(`alter table public\\.${tableName} enable row level security;`, "i"));
  });
});

test("ANON has no operational or payment write policy", () => {
  const policyStatements = migrationSql.match(/create policy[\s\S]*?;/gi) || [];
  const unsafeAnonWrites = policyStatements.filter((statement) => {
    return /to\s+anon/i.test(statement) && /for\s+(insert|update|delete|all)/i.test(statement);
  });

  assert.deepEqual(unsafeAnonWrites, []);
  assert.doesNotMatch(migrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+anon/i);
  assert.doesNotMatch(migrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+authenticated/i);
});

test("public menu and table projections avoid operational and financial internals", () => {
  const publicSql = [
    viewSql("public_table_qr"),
    viewSql("public_menu_products"),
    viewSql("public_menu_product_variants"),
    viewSql("public_menu_modifier_groups"),
    viewSql("public_menu_modifier_options")
  ].join("\n");

  ["payment_transactions", "audit_events", "idempotency_keys", "command_deduplication", "staff", "permission", "authorization"].forEach((forbidden) => {
    assert.equal(publicSql.includes(forbidden), false, forbidden);
  });
});

test("schema enforces one OPEN table session per physical table", () => {
  assert.match(
    migrationSql,
    /create unique index if not exists table_sessions_one_open_per_physical_table[\s\S]*on public\.table_sessions\(location_id, physical_table_id\)[\s\S]*where status = 'OPEN';/i
  );
});

test("schema enforces payment amount and type structural constraints", () => {
  assert.match(migrationSql, /type text not null check \(type in \('PAYMENT', 'PAYMENT_VOID', 'REFUND'\)\)/i);
  assert.match(migrationSql, /amount_vnd integer not null check \(amount_vnd > 0\)/i);
  assert.match(migrationSql, /related_payment_id text references public\.payment_transactions\(id\)/i);
  assert.match(migrationSql, /tender_group_id text not null default ''/i);
});

test("schema enforces billQty and servedQty bounds", () => {
  assert.match(migrationSql, /qty integer not null check \(qty > 0\)/i);
  assert.match(migrationSql, /bill_qty integer not null check \(bill_qty >= 0 and bill_qty <= qty\)/i);
  assert.match(migrationSql, /served_qty integer not null default 0 check \(served_qty >= 0 and served_qty <= qty\)/i);
});

test("schema preserves canonical prep and hold states", () => {
  assert.match(migrationSql, /prep_status text not null default 'QUEUED' check \(prep_status in \('QUEUED', 'ACKNOWLEDGED', 'PREPARING', 'READY'\)\)/i);
  assert.match(migrationSql, /hold_state text not null default 'FIRED' check \(hold_state in \('HELD', 'FIRED'\)\)/i);
  assert.match(migrationSql, /constraint order_lines_course_positive check \(course is null or course ~ '\^\[1-9\]\[0-9\]\*\$'\)/i);
});

test("seed preserves deterministic DeeDou physical table IDs and QR tokens", () => {
  [
    ["tbl-a01", "A01", "beach-a01-47VLmz"],
    ["tbl-a02", "A02", "beach-a02-P9qK31"],
    ["tbl-b01", "B01", "indoor-b01-Js82Va"],
    ["tbl-c01", "C01", "camp-c01-R8mN42"]
  ].forEach(([id, code, token]) => {
    assert.match(seedSql, new RegExp(`'${id}'[\\s\\S]*'${code}'[\\s\\S]*'${token}'`, "i"));
  });
});

test("schema preserves DD-005 option snapshot fields on order lines", () => {
  ["configured_key text", "configured_options jsonb", "option_snapshot jsonb", "parent_combo_option_summary_vi jsonb", "parent_combo_option_summary_en jsonb"].forEach((column) => {
    assert.match(migrationSql, new RegExp(column, "i"));
  });
});

test("schema preserves DD-006 course scheduling fields on order lines", () => {
  ["course text", "hold_state text", "held_at timestamptz", "fired_at timestamptz", "queued_at timestamptz"].forEach((column) => {
    assert.match(migrationSql, new RegExp(column, "i"));
  });
});

test("schema preserves DD-007 append-only payment ledger fields", () => {
  ["type text", "method text", "provider text", "amount_vnd integer", "status text", "related_payment_id text", "tender_group_id text", "created_at timestamptz"].forEach((column) => {
    assert.match(migrationSql, new RegExp(column, "i"));
  });
});

test("gitignore excludes local Supabase and environment secrets", () => {
  [".env", ".env.local", ".env.*.local", "supabase/.env", "supabase/.temp/"].forEach((entry) => {
    assert.match(gitignore, new RegExp(escapeRegExp(entry)));
  });
});

function viewSql(viewName) {
  const match = migrationSql.match(new RegExp(`create or replace view public\\.${viewName}[\\s\\S]*?;`, "i"));
  assert.ok(match, `Missing view ${viewName}`);
  return match[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
