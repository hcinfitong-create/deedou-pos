import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BACKEND_MODES,
  CONNECTION_STATES,
  createAuthoritativeBackendApi,
  createBackendClient,
  getBackendConfig,
  getBackendMode,
  getConnectionState,
  normalizeCommandResult,
  probeBackendConnection,
  subscribeConnectionState,
  validatePublicBackendConfig
} from "../src/shared/backend/index.js";

const migrationSql = readFileSync(new URL("../supabase/migrations/20260812000000_dd008a_backend_foundation.sql", import.meta.url), "utf8");
const authMigrationSql = readFileSync(new URL("../supabase/migrations/20260812010000_dd008b_auth_rbac.sql", import.meta.url), "utf8");
const authoritativeMigrationSql = readFileSync(new URL("../supabase/migrations/20260815080000_dd008c_authoritative_commands_realtime.sql", import.meta.url), "utf8");
const authContractSql = readFileSync(new URL("../supabase/tests/dd008b_auth_rbac_contract.sql", import.meta.url), "utf8");
const authoritativeContractSql = readFileSync(new URL("../supabase/tests/dd008c_authoritative_commands_contract.sql", import.meta.url), "utf8");
const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const supabaseConfig = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const browserSmokeScript = readFileSync(new URL("../scripts/dd008b-browser-smoke.mjs", import.meta.url), "utf8");
const dd008cIntegrationScript = readFileSync(new URL("../scripts/dd008c-command-realtime.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

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

test("browser backend config accepts modern publishable keys and legacy anon JWT only", () => {
  assert.equal(validatePublicBackendConfig({ supabasePublishableKey: "sb_publishable_demo_key" }).ok, true);

  const anonJwt = fakeJwt({ role: "anon" });

  assert.equal(validatePublicBackendConfig({ supabasePublishableKey: anonJwt }).ok, true);
  assert.equal(getBackendConfig({
    mode: "SUPABASE",
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: anonJwt
  }).mode, BACKEND_MODES.SUPABASE);

  [
    ["service_role", fakeJwt({ role: "service_role" })],
    ["authenticated", fakeJwt({ role: "authenticated" })],
    ["custom_role", fakeJwt({ role: "deedou_admin" })],
    ["missing role", fakeJwt({ sub: "anonymous" })],
    ["malformed", "malformed.jwt."]
  ].forEach(([, key]) => {
    assert.equal(validatePublicBackendConfig({ supabasePublishableKey: key }).ok, false);
    assert.equal(getBackendConfig({
      mode: "SUPABASE",
      supabaseUrl: "https://deedou-demo.supabase.co",
      supabasePublishableKey: key
    }).mode, BACKEND_MODES.LOCAL_DEMO);
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

test("DD-008C command result normalization preserves deterministic failure categories", () => {
  assert.deepEqual(normalizeCommandResult([{ ok: true, category: "OK", entity_type: "order", entity_id: "O1", version: 3, payload: { id: "O1" } }]), {
    ok: true,
    category: "OK",
    reason: "",
    entityType: "order",
    entityId: "O1",
    version: 3,
    payload: { id: "O1" }
  });

  assert.equal(normalizeCommandResult(null).ok, false);
  assert.equal(normalizeCommandResult(null).category, "BACKEND_UNAVAILABLE");
});

test("DD-008C shared backend adapter uses the managed Supabase client and injects workstation context", async () => {
  const calls = [];
  const api = createAuthoritativeBackendApi({
    config: {
      mode: BACKEND_MODES.SUPABASE,
      supabaseUrl: "https://deedou-demo.supabase.co",
      supabasePublishableKey: "sb_publishable_demo_key"
    },
    authApi: {
      getClient: () => ({
        rpc: async (functionName, params) => {
          calls.push({ functionName, params });
          return { data: [{ ok: true, category: "OK", entity_type: "order", entity_id: "O1", version: 1, payload: {} }], error: null };
        }
      })
    },
    deviceStorage: memoryStorage({ deedou_device_credential: "server-issued-device" }),
    authStateRef: () => ({
      locationId: "deedou-demo",
      authorization: { workstationMode: "CASHIER" }
    })
  });

  const result = await api.recordOrderPayment({
    orderId: "O1",
    method: "CASH",
    amountVnd: 100000,
    tenderGroupId: "TG-1",
    idempotencyKey: "idem-1"
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].functionName, "record_order_payment");
  assert.deepEqual(calls[0].params, {
    p_location_id: "deedou-demo",
    p_workstation_mode: "CASHIER",
    p_device_credential: "server-issued-device",
    p_order_id: "O1",
    p_method: "CASH",
    p_amount_vnd: 100000,
    p_tender_group_id: "TG-1",
    p_idempotency_key: "idem-1"
  });
});

test("DD-008C app routes authoritative commands instead of SUPABASE localStorage business mutations", () => {
  [
    "submitQrOrder",
    "createServiceRequest",
    "completeServiceRequest",
    "createStaffOrder",
    "setOrderStatus",
    "voidOrder",
    "updateKdsLinePrep",
    "serveOrderLine",
    "serveAllReady",
    "updateOrderLineBillQty",
    "recordOrderPayment",
    "voidOrderPayment",
    "refundOrderPayment",
    "recordTableTender",
    "openTableVisit",
    "transferTableVisit",
    "closeTableVisit",
    "subscribeLocationRefresh"
  ].forEach((apiName) => {
    assert.match(appSource, new RegExp(`authoritativeBackendApi\\.${apiName}`));
  });
  assert.match(appSource, /if \(backendConfig\.mode === BACKEND_MODES\.SUPABASE\) \{\s*state = defaultState\(\);\s*\}/);
  assert.match(appSource, /products = \[\];/);
  assert.match(appSource, /function handleExternalBusinessSignal/);
  assert.match(appSource, /refreshSupabaseAuthoritativeStateFromRoute/);
  assert.match(appSource, /applySupabaseCatalogProducts\(payload\.products\)/);
  assert.doesNotMatch(appSource, /authoritativeBackendApi\.setOrderStatus\(\{\s*orderId,\s*status: "VOIDED"/);
  assert.match(appSource, /localStorage admin changes are disabled in SUPABASE mode/);
  assert.doesNotMatch(appSource, /server command not available until DD-008C/);
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

test("public security definer functions use empty search path and fully qualified objects", () => {
  [
    "resolve_table_token",
    "list_public_menu_products",
    "list_public_menu_product_variants",
    "list_public_menu_modifier_groups",
    "list_public_menu_modifier_options"
  ].forEach((functionName) => {
    const sql = functionSql(functionName);
    assert.match(sql, /security definer/i);
    assert.match(sql, /set search_path = ''/i);
    assert.doesNotMatch(sql, /set search_path = public/i);
    assert.doesNotMatch(sql, /\sfrom\s+(?!public\.)[a-z_][a-z0-9_]*/i);
    assert.doesNotMatch(sql, /\sjoin\s+(?!public\.)[a-z_][a-z0-9_]*/i);
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

test("CI executes real DD-008A Supabase database contract on GitHub runner", () => {
  assert.match(ciWorkflow, /backend-db:/i);
  assert.match(ciWorkflow, /npm ci/i);
  assert.match(ciWorkflow, /npx supabase --version/i);
  assert.match(ciWorkflow, /npx supabase start/i);
  assert.match(ciWorkflow, /npx supabase db reset/i);
  assert.match(ciWorkflow, /supabase\/tests\/dd008a_contract\.sql/i);
  assert.match(ciWorkflow, /DB_URL="postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres"/i);
  assert.match(ciWorkflow, /psql "\$DB_URL" -v ON_ERROR_STOP=1 -f supabase\/tests\/dd008a_contract\.sql/i);
  assert.match(ciWorkflow, /if: always\(\)/i);
  assert.match(ciWorkflow, /npx supabase stop/i);
  assert.doesNotMatch(ciWorkflow, /SUPABASE_SERVICE_ROLE|SERVICE_ROLE|DATABASE_URL|PRODUCTION/i);
});

test("DD-008B enables local Supabase Auth while disabling public signup", () => {
  assert.match(supabaseConfig, /\[auth\]\s+enabled = true/i);
  assert.match(supabaseConfig, /\[auth\][\s\S]*enable_signup = false/i);
  assert.match(supabaseConfig, /\[auth\.email\][\s\S]*enable_signup = true/i);
});

test("DD-008B creates staff profile, role, permission, assignment, and device tables with RLS", () => {
  [
    "staff_profiles",
    "roles",
    "permissions",
    "role_permissions",
    "staff_location_assignments",
    "staff_role_assignments",
    "workstation_devices"
  ].forEach((tableName) => {
    assert.match(authMigrationSql, new RegExp(`create table if not exists public\\.${tableName}`, "i"));
    assert.match(authMigrationSql, new RegExp(`alter table public\\.${tableName} enable row level security;`, "i"));
    assert.match(authMigrationSql, new RegExp(`revoke all on public\\.${tableName} from anon, authenticated;`, "i"));
  });
  assert.match(authMigrationSql, /auth_user_id uuid not null unique references auth\.users\(id\) on delete restrict/i);
  assert.match(authMigrationSql, /credential_hash text not null unique/i);
  assert.match(authMigrationSql, /digest\(convert_to\('deedou-device-v2:' \|\| p_device_credential, 'utf8'\), 'sha256'\)/i);
  assert.doesNotMatch(authMigrationSql, /md5\(/i);
});

test("DD-008B documents and seeds the role permission vocabulary", () => {
  [
    "menu.read",
    "menu.manage",
    "orders.read",
    "orders.accept",
    "orders.create_staff",
    "service.serve",
    "service_requests.read",
    "service_requests.complete",
    "course.manage",
    "kds.kitchen",
    "kds.bar",
    "kds.dessert",
    "tables.read",
    "tables.manage_session",
    "payments.read",
    "payments.record",
    "payments.void",
    "payments.refund",
    "audit.read",
    "staff.read",
    "staff.manage",
    "devices.manage"
  ].forEach((permission) => {
    assert.match(authMigrationSql, new RegExp(`'${escapeRegExp(permission)}'`, "i"));
  });
  ["OWNER", "MANAGER", "CASHIER", "FLOOR_STAFF", "KITCHEN", "BAR", "DESSERT", "ADMIN_MENU"].forEach((role) => {
    assert.match(authMigrationSql, new RegExp(`'${role}'`, "i"));
  });
});

test("DD-008B authorization helpers use auth.uid, empty search path, and fully qualified relations", () => {
  [
    "current_staff_id",
    "is_active_staff",
    "has_location_access",
    "has_permission",
    "resolve_staff_workstation_context",
    "authorize_staff_access",
    "get_my_staff_context",
    "can_grant_role_at_location",
    "register_workstation_device",
    "revoke_workstation_device"
  ].forEach((functionName) => {
    const sql = authFunctionSql(functionName);
    assert.match(sql, /security definer/i);
    assert.match(sql, /set search_path = ''/i);
    assert.doesNotMatch(sql, /set search_path = public/i);
  });
  assert.match(authFunctionSql("current_staff_id"), /auth\.uid\(\)/i);
  assert.match(authFunctionSql("has_permission"), /auth\.uid\(\)/i);
  assert.doesNotMatch(authMigrationSql, /jwt.*staff|staff.*jwt|raw_app_meta_data[\s\S]*role_permissions/i);
});

test("DD-008B exposes only intended RPCs and no business write grants", () => {
  assert.doesNotMatch(authMigrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+anon/i);
  assert.doesNotMatch(authMigrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+authenticated/i);
  assert.match(authMigrationSql, /grant execute on function public\.authorize_staff_access\(text, text, text, text\) to anon, authenticated;/i);
  assert.doesNotMatch(authMigrationSql, /grant execute on function public\.resolve_registered_device\(text, text\)/i);
  assert.doesNotMatch(authMigrationSql, /grant execute on function public\.generate_device_credential/i);
  ["list_staff_orders", "list_staff_payment_transactions", "assign_staff_role_at_location", "revoke_workstation_device"].forEach((functionName) => {
    assert.match(authMigrationSql, new RegExp(`grant execute on function public\\.${functionName}`, "i"));
  });
});

test("DD-008B delegation ceiling and device constraints are enforced server-side", () => {
  const delegation = authFunctionSql("can_grant_role_at_location");
  const authorize = authFunctionSql("authorize_staff_access");
  const audit = authFunctionSql("prepare_audit_context");
  const registerDevice = authFunctionSql("register_workstation_device");
  const revokeDevice = authFunctionSql("revoke_workstation_device");

  assert.match(delegation, /SELF_ESCALATION_BLOCKED/i);
  assert.match(delegation, /PRIVILEGE_CEILING_EXCEEDED/i);
  assert.match(delegation, /public\.authorize_staff_access\(p_location_id, 'staff\.manage', p_current_workstation_mode, p_current_device_credential\)/i);
  assert.match(delegation, /public\.has_permission\(p_location_id, public\.permissions\.permission_key\) = false/i);
  assert.match(authorize, /DEVICE_UNREGISTERED/i);
  assert.match(authorize, /DEVICE_MODE_DENIED/i);
  assert.match(authorize, /public\.workstation_mode_allows_permission/i);
  assert.match(registerDevice, /public\.authorize_staff_access\(p_location_id, 'devices\.manage', p_current_workstation_mode, p_current_device_credential\)/i);
  assert.match(registerDevice, /public\.generate_device_credential\(\)/i);
  assert.match(registerDevice, /public\.generate_device_id\(\)/i);
  assert.doesNotMatch(registerDevice, /on conflict \(credential_hash\) do update/i);
  assert.match(revokeDevice, /public\.authorize_staff_access\(p_location_id, 'devices\.manage', p_current_workstation_mode, p_current_device_credential\)/i);
  assert.match(audit, /public\.resolve_staff_workstation_context\(p_location_id, p_workstation_mode, p_device_credential\)/i);
  assert.match(audit, /coalesce\(v_context\.workstation_mode, ''\)/i);
  assert.doesNotMatch(audit, /then p_workstation_mode/i);
});

test("DD-008B database contract covers required real Supabase auth and RBAC cases", () => {
  [
    "SIGN_IN_REQUIRED",
    "STAFF_INACTIVE",
    "PERMISSION_DENIED",
    "LOCATION_DENIED",
    "DEVICE_UNREGISTERED",
    "DEVICE_MODE_DENIED",
    "SELF_ESCALATION_BLOCKED",
    "PRIVILEGE_CEILING_EXCEEDED",
    "expected authenticated operational write to be blocked",
    "expected owner to register server-issued device",
    "expected staff deactivation immediate without JWT refresh",
    "expected audit context to ignore client mode/actor spoof",
    "expected unauthenticated exact-token QR resolver to work"
  ].forEach((evidence) => {
    assert.match(authContractSql, new RegExp(escapeRegExp(evidence), "i"));
  });
});

test("CI executes real DD-008B Supabase database and Auth integration contracts on GitHub runner", () => {
  assert.match(ciWorkflow, /supabase\/tests\/dd008b_auth_rbac_contract\.sql/i);
  assert.match(ciWorkflow, /psql "\$DB_URL" -v ON_ERROR_STOP=1 -f supabase\/tests\/dd008b_auth_rbac_contract\.sql/i);
  assert.match(ciWorkflow, /auth-integration:/i);
  assert.match(ciWorkflow, /npm run dd008b:auth-integration/i);
  assert.match(ciWorkflow, /Run DD-008B real Supabase Auth integration/i);
  assert.match(ciWorkflow, /"feat\/\*\*"/i);
  assert.doesNotMatch(ciWorkflow, /SUPABASE_SERVICE_ROLE|PRODUCTION/i);
});

test("DD-008C merge gates run on Node 22 and include exact-head integration/browser smoke", () => {
  assert.match(packageJson, /"node":\s*">=22"/i);
  assert.match(packageJson, /"dd008c:command-realtime":\s*"node scripts\/dd008c-command-realtime\.mjs"/i);
  assert.match(packageJson, /node --check scripts\/dd008c-command-realtime\.mjs/i);

  ["test", "backend-db", "auth-integration", "dd008c-integration", "browser-smoke"].forEach((jobName) => {
    const jobMatch = ciWorkflow.match(new RegExp(`${jobName}:([\\s\\S]*?)(?:\\n  [a-zA-Z0-9_-]+:|\\n?$)`, "i"));
    assert.ok(jobMatch, `Missing CI job ${jobName}`);
    assert.match(jobMatch[1], /node-version:\s*22/i, `${jobName} should use Node 22`);
    assert.match(jobMatch[1], /node --version/i, `${jobName} should print exact Node version`);
  });

  assert.match(ciWorkflow, /dd008c-integration:/i);
  assert.match(ciWorkflow, /npm run dd008c:command-realtime/i);
  assert.match(ciWorkflow, /browser-smoke:/i);
  assert.match(ciWorkflow, /npx playwright install --with-deps chromium/i);
  assert.match(ciWorkflow, /npx supabase start/i);
  assert.match(ciWorkflow, /npx supabase db reset/i);
  assert.match(ciWorkflow, /npm run dd008c:browser-smoke/i);
  assert.match(ciWorkflow, /actions\/upload-artifact@v4/i);
  assert.match(ciWorkflow, /artifacts\/dd008c-browser-smoke\//i);
  assert.doesNotMatch(ciWorkflow, /SUPABASE_SERVICE_ROLE|PRODUCTION/i);
});

test("DD-008C browser smoke waits for auth gate binding before login submit", () => {
  const loginHelper = browserSmokeScript.match(/async function loginThroughGate[\s\S]*?\n}/)?.[0] || "";

  assert.match(loginHelper, /await waitForNotChecking\(page\);[\s\S]*await assertAppReady\(page, `login gate \$\{workstationMode\}`\);/);
  assert.match(loginHelper, /await assertAppReady[\s\S]*button\[type="submit"\]'\)\.click\(\);/);
});

test("DD-008C browser smoke covers Manager Location A allow and Location B deny", () => {
  const assignmentBlock = browserSmokeScript.match(/insert into public\.staff_location_assignments[\s\S]*?on conflict/)?.[0] || "";

  assert.match(browserSmokeScript, /manager: await createRuntimeUser\("manager"\)/);
  assert.match(browserSmokeScript, /\$\{lit\(ids\.manager\)\}, \$\{lit\(users\.manager\.id\)\}::uuid, 'Browser Smoke Manager', true/);
  assert.match(browserSmokeScript, /\$\{lit\(ids\.manager\)\}, \$\{lit\(ids\.locationA\)\}, 'MANAGER', true/);
  assert.match(browserSmokeScript, /'Browser Smoke Manager Staff', 'STAFF'/);
  assert.match(browserSmokeScript, /'Browser Smoke Manager B Staff', 'STAFF'/);
  assert.match(assignmentBlock, /\$\{lit\(ids\.manager\)\}, \$\{lit\(ids\.locationA\)\}/);
  assert.doesNotMatch(assignmentBlock, /\$\{lit\(ids\.manager\)\}, \$\{lit\(ids\.locationB\)\}/);
  assert.match(browserSmokeScript, /SUPABASE manager Location A staff allow\/authoritative[\s\S]*loginThroughGate\(managerPage, users\.manager, ids\.locationA, "STAFF"\)[\s\S]*expectAuthoritativeAuthorized\(managerPage, "Staff"\)/);
  assert.match(browserSmokeScript, /SUPABASE manager Location B denied[\s\S]*user: users\.manager[\s\S]*locationId: ids\.locationB[\s\S]*workstationMode: "STAFF"[\s\S]*routeName: "staff"/);
});

test("DD-008C browser smoke covers separate-context operational realtime E2E", () => {
  [
    "runOperationalRealtimeE2E",
    "SUPABASE E2E customer",
    "SUPABASE E2E staff",
    "SUPABASE E2E kitchen",
    "SUPABASE E2E cashier",
    "timezoneId: \"Asia/Ho_Chi_Minh\"",
    "setFixedTime(new Date(\"2026-08-15T20:00:00+07:00\"))",
    "evening kitchen fixture missing",
    "browser operational E2E",
    "customer QR authoritative pending order",
    "DeeDou đang kiểm tra order của bạn.",
    "99.000 đ",
    "data-status=\"ACCEPTED\"",
    "clickStationAction(kitchenPage, note, \"ACKNOWLEDGED\")",
    "clickStationAction(kitchenPage, note, \"PREPARING\")",
    "clickStationAction(kitchenPage, note, \"READY\")",
    "data-serve-line",
    "data-table-pay=\"A01\"",
    "publicClient.rpc(\"create_service_request\"",
    "Staff reconnect operational E2E",
    "activeRealtimeTicketCount",
    "multi-context realtime customer QR"
  ].forEach((evidence) => {
    assert.match(browserSmokeScript, new RegExp(escapeRegExp(evidence), "i"));
  });
});

test("DD-008C creates authoritative command RPCs with SECURITY DEFINER and empty search path", () => {
  [
    "submit_qr_order",
    "create_service_request",
    "dd008c_get_public_table_snapshot",
    "dd008c_get_location_snapshot",
    "create_staff_order",
    "set_order_status",
    "void_order",
    "update_kds_line_prep",
    "serve_order_line",
    "serve_all_ready",
    "assign_order_family_course",
    "hold_order_family",
    "fire_order_family",
    "fire_order_course",
    "open_table_visit",
    "transfer_table_visit",
    "close_table_visit",
    "complete_service_request",
    "update_order_line_bill_qty",
    "record_order_payment",
    "void_order_payment",
    "refund_order_payment",
    "record_table_tender",
    "dd008c_issue_realtime_ticket"
  ].forEach((functionName) => {
    const sql = authoritativeFunctionSql(functionName);
    assert.match(sql, /security definer/i, `${functionName} must be SECURITY DEFINER`);
    assert.match(sql, /set search_path = ''/i, `${functionName} must pin empty search_path`);
  });
});

test("DD-008C exposes only intended public and authenticated command grants", () => {
  ["submit_qr_order", "create_service_request", "dd008c_get_public_table_snapshot"].forEach((functionName) => {
    assert.match(authoritativeMigrationSql, new RegExp(`grant execute on function public\\.${functionName}\\([\\s\\S]*?\\) to anon, authenticated;`, "i"));
  });

  [
    "dd008c_get_location_snapshot",
    "create_staff_order",
    "set_order_status",
    "void_order",
    "update_kds_line_prep",
    "serve_order_line",
    "serve_all_ready",
    "complete_service_request",
    "update_order_line_bill_qty",
    "record_order_payment",
    "void_order_payment",
    "refund_order_payment",
    "record_table_tender",
    "dd008c_issue_realtime_ticket"
  ].forEach((functionName) => {
    assert.match(authoritativeMigrationSql, new RegExp(`grant execute on function public\\.${functionName}\\([\\s\\S]*?\\) to authenticated;`, "i"));
  });

  assert.doesNotMatch(authoritativeMigrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+anon/i);
  assert.doesNotMatch(authoritativeMigrationSql, /grant\s+(insert|update|delete|all)[\s\S]*to\s+authenticated/i);
});

test("DD-008C Supabase snapshots carry PostgreSQL catalog data without routing internals", () => {
  const catalog = authoritativeFunctionSql("dd008c_public_menu_payload");
  const staffSnapshot = authoritativeFunctionSql("dd008c_get_location_snapshot");
  const publicSnapshot = authoritativeFunctionSql("dd008c_get_public_table_snapshot");

  assert.match(staffSnapshot, /'products', public\.dd008c_public_menu_payload\(p_location_id\)/i);
  assert.match(publicSnapshot, /'products', public\.dd008c_public_menu_payload\(v_table\.location_id\)/i);
  assert.match(catalog, /public\.products\.available = true/i);
  assert.match(catalog, /public\.product_variants\.available = true/i);
  assert.match(catalog, /public\.modifier_options\.available = true/i);
  assert.match(catalog, /public\.product_components/i);
  assert.doesNotMatch(catalog, /station_code/i);
  ["payment_transactions", "audit_events", "command_deduplication", "staff_profiles", "workstation_devices", "device_credential"].forEach((forbidden) => {
    assert.equal(catalog.includes(forbidden), false, forbidden);
  });
});

test("DD-008C authoritative commands keep DD-003 through DD-007 invariants server-side", () => {
  const qrSubmit = authoritativeFunctionSql("submit_qr_order");
  const insertOrder = authoritativeFunctionSql("dd008c_insert_order_from_items");
  const kds = authoritativeFunctionSql("update_kds_line_prep");
  const serveLine = authoritativeFunctionSql("serve_order_line");
  const assignCourse = authoritativeFunctionSql("assign_order_family_course");
  const holdFamily = authoritativeFunctionSql("hold_order_family");
  const fireFamily = authoritativeFunctionSql("fire_order_family");
  const fireCourse = authoritativeFunctionSql("fire_order_course");
  const payment = authoritativeFunctionSql("record_order_payment");
  const refund = authoritativeFunctionSql("refund_order_payment");
  const billQty = authoritativeFunctionSql("update_order_line_bill_qty");
  const voidOrder = authoritativeFunctionSql("void_order");

  assert.match(qrSubmit, /command_deduplication/i);
  assert.match(qrSubmit, /dd008c_public_order_validation_reason\(SQLERRM\)/i);
  assert.match(insertOrder, /products\.available = true/i);
  assert.match(insertOrder, /PRODUCT_UNAVAILABLE/i);
  assert.match(insertOrder, /dd008c_current_service_period\(p_location_id\)/i);
  assert.match(insertOrder, /PRODUCT_OUT_OF_PERIOD/i);
  assert.match(insertOrder, /OPTION_COUNT_INVALID/i);
  assert.match(kds, /station_code <> 'COMBO'/i);
  assert.match(kds, /hold_state <> 'FIRED'/i);
  assert.match(kds, /INVALID_PREP_STATUS_TRANSITION/i);
  assert.doesNotMatch(kds, /SERVED/);
  assert.match(serveLine, /v_line\.served_qty \+ p_qty > v_line\.qty/i);
  assert.doesNotMatch(serveLine, /dd008c_audited_failure[\s\S]*'serve_all_ready'/i);
  assert.match(fireFamily, /ALREADY_FIRED/i);
  [assignCourse, holdFamily, fireFamily, fireCourse].forEach((courseCommand) => {
    assert.match(courseCommand, /where id = p_order_id and location_id = p_location_id for update/i);
    assert.match(courseCommand, /ORDER_NOT_FOUND/i);
  });
  [assignCourse, holdFamily, fireFamily].forEach((familyCommand) => {
    assert.match(familyCommand, /LINE_NOT_FOUND/i);
  });
  assert.match(payment, /PAYMENT_EXCEEDS_OUTSTANDING/i);
  assert.match(payment, /command_deduplication/i);
  assert.match(refund, /REFUND_EXCEEDS_REMAINING/i);
  assert.match(billQty, /PAYMENT_EXISTS/i);
  assert.match(billQty, /BILL_QTY_EXCEEDS_QTY/i);
  assert.match(voidOrder, /'orders\.void'/i);
  assert.match(voidOrder, /PAYMENT_EXISTS/i);
  assert.match(voidOrder, /IDEMPOTENCY_KEY_REUSED/i);
  assert.match(voidOrder, /dd008c_audit_staff_result/i);
  assert.match(voidOrder, /ORDER_VOIDED/i);
  assert.match(authoritativeMigrationSql, /'orders\.void', 'orders\.void'/i);
  assert.match(authoritativeMigrationSql, /when 'CASHIER' then p_permission_key in \([\s\S]*'orders\.void'/i);
});

test("DD-008C table tender validates outstanding balance before ledger inserts", () => {
  const tableTender = authoritativeFunctionSql("record_table_tender");

  assert.match(tableTender, /select \* into v_session from public\.table_sessions/i);
  assert.match(tableTender, /for update/i);
  assert.match(tableTender, /order by public\.orders\.created_at, public\.orders\.id[\s\S]*for update/i);
  assert.match(tableTender, /NO_OUTSTANDING_BALANCE/i);
  assert.match(tableTender, /TENDER_EXCEEDS_OUTSTANDING/i);
  assert.ok(
    tableTender.indexOf("TENDER_EXCEEDS_OUTSTANDING") < tableTender.indexOf("insert into public.payment_transactions"),
    "table tender must reject overpayment before inserting payment rows"
  );
  assert.match(tableTender, /command_deduplication/i);
});

test("DD-008C realtime refresh is audience and workstation-device ticket scoped", () => {
  const issueTicket = authoritativeFunctionSql("dd008c_issue_realtime_ticket");

  assert.match(authoritativeMigrationSql, /create table if not exists public\.dd008c_refresh_hints/i);
  assert.match(authoritativeMigrationSql, /create table if not exists public\.dd008c_realtime_subscription_tickets/i);
  assert.match(authoritativeMigrationSql, /alter table public\.dd008c_refresh_hints enable row level security/i);
  assert.match(authoritativeMigrationSql, /alter table public\.dd008c_realtime_subscription_tickets enable row level security/i);
  assert.match(authoritativeMigrationSql, /revoke all on public\.dd008c_refresh_hints from anon, authenticated/i);
  assert.match(authoritativeMigrationSql, /revoke all on public\.dd008c_realtime_subscription_tickets from anon, authenticated/i);
  assert.doesNotMatch(authoritativeMigrationSql, /grant select on public\.dd008c_refresh_hints to authenticated/i);
  assert.doesNotMatch(authoritativeMigrationSql, /grant select on public\.dd008c_realtime_subscription_tickets to (anon|authenticated)/i);
  assert.doesNotMatch(authoritativeMigrationSql, /create policy dd008c_refresh_hints_staff_location_read/i);
  assert.doesNotMatch(authoritativeMigrationSql, /using\s*\(\s*public\.dd008c_refresh_audience_allowed\(location_id,\s*audience\)\s*\)/i);
  assert.match(authoritativeMigrationSql, /create or replace function public\.dd008c_refresh_audience_allowed\(\s*p_location_id text,\s*p_audience text,\s*p_ticket_id text/i);
  assert.match(authoritativeMigrationSql, /public\.dd008c_refresh_permission_for_audience\(p_audience\)/i);
  assert.match(issueTicket, /public\.authorize_staff_access\(p_location_id, v_permission, p_workstation_mode, p_device_credential\)/i);
  assert.match(issueTicket, /'location:' \|\| p_location_id \|\| ':' \|\| v_audience \|\| ':' \|\| v_ticket_id::text/i);
  assert.match(authoritativeMigrationSql, /public\.workstation_mode_allows_permission\(/i);
  assert.match(authoritativeMigrationSql, /public\.workstation_devices\.active = true/i);
  assert.match(authoritativeMigrationSql, /realtime\.send\(v_payload, 'refresh', v_ticket_topic, true\)/i);
  assert.match(authoritativeMigrationSql, /public\.dd008c_refresh_audience_allowed\(\s*split_part\(realtime\.topic\(\), ':', 2\),\s*split_part\(realtime\.topic\(\), ':', 3\),\s*split_part\(realtime\.topic\(\), ':', 4\)/i);
  assert.doesNotMatch(authoritativeMigrationSql, /realtime\.send\(v_payload, 'refresh', v_topic, true\)/i);
  assert.match(authoritativeMigrationSql, /alter publication supabase_realtime add table public\.dd008c_refresh_hints/i);
  assert.match(authoritativeMigrationSql, /public\.dd008c_emit_refresh/i);
  assert.match(authoritativeContractSql, /manager on STAFF workstation denied cashier realtime/i);
  assert.match(authoritativeContractSql, /expected KDS denied cashier realtime/i);
  assert.match(authoritativeContractSql, /expected revoked device denied realtime/i);
  assert.match(authoritativeContractSql, /expected authenticated raw refresh hint read to be blocked/i);
  assert.match(browserSmokeScript, /execFileSync\("psql"/i);
  assert.doesNotMatch(browserSmokeScript, /\.from\("dd008c_realtime_subscription_tickets"\)/i);
});

test("DD-008C app reuses pending command-intent idempotency keys", () => {
  assert.match(appSource, /SUPABASE_COMMAND_INTENTS_KEY/);
  assert.match(appSource, /function pendingCommandKey/);
  assert.match(appSource, /function clearPendingCommandKey/);
  assert.match(appSource, /function isTerminalCommandResult/);
  assert.match(appSource, /operation\(idempotencyKey\)/);
  assert.match(appSource, /tenderGroupIdForCommand\(idempotencyKey\)/);
  assert.doesNotMatch(appSource, /idempotencyKey:\s*nextCommandKey\(/);
});

test("CI executes the DD-008C authoritative command contract against the real local database", () => {
  assert.match(ciWorkflow, /supabase\/tests\/dd008c_authoritative_commands_contract\.sql/i);
  [
    "submit_qr_order",
    "create_staff_order",
    "set_order_status",
    "void_order",
    "update_kds_line_prep",
    "serve_order_line",
    "record_order_payment",
    "record_table_tender",
    "open_table_visit",
    "transfer_table_visit",
    "close_table_visit"
  ].forEach((functionName) => {
    assert.match(authoritativeContractSql, new RegExp(`public\\.${functionName}`, "i"));
  });
  assert.match(authoritativeContractSql, /TENDER_EXCEEDS_OUTSTANDING/i);
  assert.match(authoritativeContractSql, /SERVED_QTY_EXCEEDS_REMAINING/i);
  assert.match(authoritativeContractSql, /expected multi-station order READY after all stations ready/i);
  assert.match(authoritativeContractSql, /expected void accepted version 2/i);
  assert.match(authoritativeContractSql, /PRODUCT_OUT_OF_PERIOD/i);
  assert.match(authoritativeContractSql, /ORDER_VALIDATION_FAILED/i);
  assert.match(authoritativeContractSql, /public catalog snapshot to include configured mango-tea options/i);
});

test("DD-008C real integration script covers command concurrency and refresh convergence", () => {
  [
    "Promise.all",
    "submit_qr_order",
    "record_order_payment",
    "assign_order_family_course",
    "record_table_tender",
    "open_table_visit",
    "transfer_table_visit",
    "STALE_VERSION",
    "course conflict",
    "payment race",
    "staffRefresh",
    "cashierRefresh",
    "audiences: [\"ops\"]",
    "audiences: [\"ops\", \"cashier\"]",
    "dd008c_issue_realtime_ticket",
    "location:${LOCATION_ID}:${audience}:",
    "manager STAFF workstation denied cashier realtime",
    "forged cashier realtime subscription denied by RLS",
    "revoked device denied realtime ticket",
    "private refresh broadcast",
    "SUBSCRIPTION_READY",
    "payload.events",
    "create_service_request",
    "reconnect/refetch",
    "Real password login"
  ].forEach((evidence) => {
    assert.match(dd008cIntegrationScript, new RegExp(escapeRegExp(evidence), "i"));
  });

  assert.doesNotMatch(dd008cIntegrationScript, /console\.log\([^)]*(serviceRoleKey|anonKey|deviceSecrets|password)/i);
});

function functionSql(functionName) {
  const match = migrationSql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `Missing function ${functionName}`);
  return match[0];
}

function authFunctionSql(functionName) {
  const match = authMigrationSql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `Missing auth function ${functionName}`);
  return match[0];
}

function authoritativeFunctionSql(functionName) {
  const match = authoritativeMigrationSql.match(new RegExp(`create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `Missing DD-008C function ${functionName}`);
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

function memoryStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
