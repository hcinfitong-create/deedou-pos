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
    { privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
    { supabasePublishableKey: fakeJwt({ role: "service_role" }) },
    { supabasePublishableKey: "malformed.jwt." }
  ].forEach((config) => {
    assert.equal(validatePublicBackendConfig(config).ok, false);
    assert.equal(getBackendConfig({ mode: "SUPABASE", ...config }).mode, BACKEND_MODES.LOCAL_DEMO);
  });
});

test("browser backend config accepts legacy anon JWT but rejects service_role JWT", () => {
  const anonJwt = fakeJwt({ role: "anon" });
  const serviceRoleJwt = fakeJwt({ role: "service_role" });

  assert.equal(validatePublicBackendConfig({ supabasePublishableKey: anonJwt }).ok, true);
  assert.equal(getBackendConfig({
    mode: "SUPABASE",
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: anonJwt
  }).mode, BACKEND_MODES.SUPABASE);

  assert.equal(validatePublicBackendConfig({ supabasePublishableKey: serviceRoleJwt }).ok, false);
  assert.equal(getBackendConfig({
    mode: "SUPABASE",
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: serviceRoleJwt
  }).mode, BACKEND_MODES.LOCAL_DEMO);
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

test("public resolver prevents QR token enumeration", () => {
  const resolver = functionSql("resolve_table_token");
  const resolverReturnSignature = resolver.match(/returns table \([\s\S]*?\)/i)?.[0] || "";
  const resolverSelectList = resolver.match(/select\s+([\s\S]*?)\s+from public\.physical_tables pt/i)?.[1] || "";

  assert.doesNotMatch(migrationSql, /create or replace view public\.public_table_qr/i);
  assert.doesNotMatch(migrationSql, /grant select on public\.physical_tables to anon/i);
  assert.doesNotMatch(migrationSql, /grant select on public\.physical_tables to authenticated/i);
  assert.match(resolver, /where pt\.is_active = true\s+and pt\.qr_token = p_qr_token/i);
  assert.match(resolver, /returns table \(\s*location_id text,\s*code text,\s*zone text\s*\)/i);
  assert.doesNotMatch(resolverReturnSignature, /qr_token/i);
  assert.doesNotMatch(resolverSelectList, /pt\.qr_token/i);
});

test("public menu and table functions avoid operational and financial internals", () => {
  const publicSql = [
    functionSql("resolve_table_token"),
    functionSql("list_public_menu_products"),
    functionSql("list_public_menu_product_variants"),
    functionSql("list_public_menu_modifier_groups"),
    functionSql("list_public_menu_modifier_options")
  ].join("\n");

  ["payment_transactions", "audit_events", "idempotency_keys", "command_deduplication", "staff", "permission", "authorization"].forEach((forbidden) => {
    assert.equal(publicSql.includes(forbidden), false, forbidden);
  });
});

test("public access grants only narrow public functions and health view", () => {
  const rawPublicTables = [
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
  ];

  rawPublicTables.forEach((tableName) => {
    assert.doesNotMatch(migrationSql, new RegExp(`grant select on public\\.${tableName} to anon`, "i"));
    assert.doesNotMatch(migrationSql, new RegExp(`grant select on public\\.${tableName} to authenticated`, "i"));
  });
  ["resolve_table_token", "list_public_menu_products", "list_public_menu_product_variants", "list_public_menu_modifier_groups", "list_public_menu_modifier_options"].forEach((functionName) => {
    assert.match(migrationSql, new RegExp(`revoke all on function public\\.${functionName}\\(text\\) from public;`, "i"));
    assert.match(migrationSql, new RegExp(`grant execute on function public\\.${functionName}\\(text\\) to anon, authenticated;`, "i"));
  });
});

test("public menu contract is location scoped and hides internal routing", () => {
  const products = functionSql("list_public_menu_products");
  const groups = functionSql("list_public_menu_modifier_groups");
  const options = functionSql("list_public_menu_modifier_options");

  assert.match(products, /p\.location_id = p_location_id/i);
  assert.match(groups, /returns table \(\s*location_id text,\s*product_id text,\s*modifier_group_id text/i);
  assert.match(groups, /mg\.location_id = p\.location_id/i);
  assert.match(options, /returns table \(\s*location_id text,\s*modifier_group_id text/i);
  assert.doesNotMatch(products, /returns table[\s\S]*station_code/i);
  assert.doesNotMatch(products, /select[\s\S]*p\.station_code/i);
  assert.equal(migrationSql.includes("grant execute on function public.list_public_menu_product_components"), false);
});

test("schema enforces one OPEN table session per physical table", () => {
  assert.match(
    migrationSql,
    /create unique index if not exists table_sessions_one_open_per_physical_table[\s\S]*on public\.table_sessions\(physical_table_id\)[\s\S]*where status = 'OPEN';/i
  );
});

test("schema enforces table-session physical table location consistency", () => {
  assert.match(migrationSql, /unique \(id, location_id\)/i);
  assert.match(
    migrationSql,
    /constraint table_sessions_physical_table_location_fk[\s\S]*foreign key \(physical_table_id, location_id\)[\s\S]*references public\.physical_tables\(id, location_id\)/i
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

test("payment transaction ledger is protected from order hard-delete cascades", () => {
  const paymentTransactions = tableSql("payment_transactions");

  assert.match(paymentTransactions, /order_id text not null references public\.orders\(id\) on delete restrict/i);
  assert.doesNotMatch(paymentTransactions, /order_id text not null references public\.orders\(id\) on delete cascade/i);
});

test("gitignore excludes local Supabase and environment secrets", () => {
  [".env", ".env.local", ".env.*.local", "supabase/.env", "supabase/.temp/"].forEach((entry) => {
    assert.match(gitignore, new RegExp(escapeRegExp(entry)));
  });
});

function functionSql(functionName) {
  const match = migrationSql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `Missing function ${functionName}`);
  return match[0];
}

function tableSql(tableName) {
  const match = migrationSql.match(new RegExp(`create table if not exists public\\.${tableName} \\([\\s\\S]*?\\n\\);`, "i"));
  assert.ok(match, `Missing table ${tableName}`);
  return match[0];
}

function fakeJwt(payload) {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(payload),
    "signature"
  ].join(".");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
