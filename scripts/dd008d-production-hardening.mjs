import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname;
const failures = [];
const warnings = [];
const passes = [];

function pass(message) {
  passes.push(message);
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function collectSourceFiles(dir) {
  const full = join(rootPath, dir);
  if (!existsSync(full)) return [];
  const result = [];
  for (const name of readdirSync(full)) {
    const path = join(full, name);
    const stat = statSync(path);
    if (stat.isDirectory()) result.push(...collectSourceFiles(relative(rootPath, path)));
    else if (/\.(?:js|mjs|html)$/.test(name)) result.push(path);
  }
  return result;
}

function tomlSection(source, sectionName) {
  const lines = String(source || "").split(/\r?\n/);
  const header = `[${sectionName}]`;
  const collected = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      active = trimmed === header;
      continue;
    }
    if (active) collected.push(line);
  }
  return collected.join("\n");
}

const packageJson = JSON.parse(read("package.json"));
const packageLockExists = existsSync(new URL("package-lock.json", root));
if (packageLockExists && packageJson.private === true) pass("dependency lockfile present and package is private");
else fail("package-lock.json and private package are required for reproducible production installs");

const browserFiles = [join(rootPath, "app.js"), join(rootPath, "index.html"), ...collectSourceFiles("src")];
const browserSource = browserFiles.map((path) => readFileSync(path, "utf8")).join("\n");
const secretPatterns = [
  /sb_secret_[A-Za-z0-9_-]+/,
  /service[_-]?role[_-]?key\s*[:=]\s*["'`][^"'`]+/i,
  /postgres(?:ql)?:\/\/[^\s"'`]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
const secretHit = secretPatterns.find((pattern) => pattern.test(browserSource));
if (secretHit) fail(`browser source contains a server-secret-like value matching ${secretHit}`);
else pass("browser source contains no service-role/database/private-key material");

const cutoverSource = read("src/shared/backend/cutover.js");
if (/allowDualWrite:\s*false/.test(cutoverSource) && /allowLegacyAutoImport:\s*false/.test(cutoverSource)) {
  pass("cutover policy explicitly forbids dual-write and automatic legacy upload");
} else {
  fail("cutover policy must explicitly forbid dual-write and automatic legacy upload");
}

const appSource = read("app.js");
if (/blockSupabaseLocalCommand\("MENU_SAVE"\)/.test(appSource) && /blockSupabaseLocalCommand\("STATE_SAVE"\)/.test(appSource)) {
  pass("SUPABASE path blocks remaining local business persistence entry points");
} else {
  fail("SUPABASE must block local product/state business writes");
}

const migrationSource = read("supabase/migrations/20260816010000_dd008d_cutover_resilience.sql");
for (const required of [
  "alter table public.legacy_import_batches enable row level security",
  "alter table public.legacy_id_map enable row level security",
  "revoke all on public.legacy_import_batches from anon, authenticated",
  "revoke all on public.legacy_id_map from anon, authenticated",
  "PREVIEW_REQUIRED",
  "PREVIEW_PAYLOAD_CHANGED",
  "SKIP_NO_OVERWRITE",
  "dd008d_production_readiness"
]) {
  if (!migrationSource.includes(required)) fail(`DD-008D migration missing required hardening marker: ${required}`);
}
if (!failures.some((item) => item.includes("DD-008D migration missing"))) pass("legacy import tables/RPCs retain RLS, preview-first, and no-overwrite contracts");

const supabaseConfig = read("supabase/config.toml");
const authSection = tomlSection(supabaseConfig, "auth");
const emailAuthSection = tomlSection(supabaseConfig, "auth.email");
if (/^\s*enable_signup\s*=\s*false\s*(?:#.*)?$/m.test(authSection)) pass("local Supabase general signup is disabled");
else warn("local Supabase [auth] section does not clearly disable general signup");
if (/additional_redirect_urls\s*=\s*\["http:\/\/127\.0\.0\.1:8099"\]/.test(authSection)) {
  pass("checked-in redirect allowlist is local-only, not a permissive production wildcard");
} else {
  warn("review checked-in auth redirect allowlist before production cutover");
}
if (/^\s*enable_signup\s*=\s*true\s*(?:#.*)?$/m.test(emailAuthSection)) {
  warn("local [auth.email] signup is enabled for integration fixtures; production Supabase Auth must disable public signup unless intentionally approved");
}

const seed = read("supabase/seed.sql");
if (/deedou-demo/i.test(seed)) {
  warn("supabase/seed.sql contains demo fixtures; production deployment must run migrations without applying local demo seed credentials/data");
}

const workflow = read(".github/workflows/ci.yml");
if (workflow.includes("npm ci")) pass("CI installs from lockfile with npm ci");
else fail("CI must use npm ci for dependency lock enforcement");

const runbookExists = existsSync(new URL("docs/DD008D_CUTOVER_RUNBOOK.md", root));
if (runbookExists) pass("DD-008D production cutover/rollback runbook exists");
else fail("docs/DD008D_CUTOVER_RUNBOOK.md is required before production cutover");

warn("EXTERNAL GATE: verify production Supabase Auth signup policy and exact redirect origins in the deployed project");
warn("EXTERNAL GATE: verify database backup/PITR availability and restoration procedure for the production plan");
warn("EXTERNAL GATE: verify API/edge rate limits for public QR submit, service requests, auth, and migration/admin functions");
warn("EXTERNAL GATE: define audit retention/access policy and verify production logs contain no secrets or payment instrument data");
warn("EXTERNAL GATE: confirm production deployment excludes local seed/demo credentials and uses only publishable browser keys");

console.log("DD-008D production hardening checks");
for (const item of passes) console.log(`PASS  ${item}`);
for (const item of warnings) console.log(`WARN  ${item}`);
for (const item of failures) console.error(`FAIL  ${item}`);
console.log(`SUMMARY pass=${passes.length} warn=${warnings.length} fail=${failures.length}`);

if (failures.length > 0) process.exitCode = 1;
