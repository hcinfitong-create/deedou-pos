import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const apiUrl = requireEnv("DEEDOU_HOSTED_SUPABASE_URL");
const publishableKey = requireEnv("DEEDOU_HOSTED_SUPABASE_PUBLISHABLE_KEY");
const bootstrapUrl = requireEnv("DEEDOU_HOSTED_BOOTSTRAP_URL");
const sourcePath = "scripts/dd008d-browser-smoke.mjs";
const runtimePath = "scripts/.dd008d-hosted-smoke-runtime.mjs";
const runId = `dd008d_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");

let source = await readFile(sourcePath, "utf8");
source = replaceExact(source,
`const DB_URL = process.env.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY;
const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!anonKey || !serviceRoleKey) throw new Error("Supabase local keys unavailable");`,
`const apiUrl = ${JSON.stringify(apiUrl)};
const anonKey = ${JSON.stringify(publishableKey)};
const bootstrapUrl = ${JSON.stringify(bootstrapUrl)};`);

source = replaceExact(source,
`const runId = \`dd008d_\${Date.now()}_\${randomUUID().slice(0, 8)}\`.replace(/-/g, "_");`,
`const runId = ${JSON.stringify(runId)};`);

source = replaceExact(source,
`const adminClient = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const publicClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const createdUserIds = [];`,
`const publicClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });`);

source = replaceExact(source,
`  await provisionUsers();
  provisionDatabase();`,
`  await provisionHostedFixture();`);

source = replaceExact(source,
`  for (const userId of createdUserIds) await adminClient.auth.admin.deleteUser(userId).catch(() => {});`,
`  await cleanupHostedFixture().catch(() => {});`);

source = replaceExact(source,
`    email: \`\${runId}.\${name}@example.invalid\`,`,
`    email: \`deedou.smoke.\${runId}.\${name}@gmail.com\`,`);

source = replaceExact(source,
`  await waitFor(async () => psqlScalar(\`select status from public.table_sessions where id='\${sql(sessionId)}'\`) === "CLOSED", "table visit closed");`,
`  await waitFor(async () => {
    const snapshot = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
    return snapshot.tableSessions.some((session) => session.id === sessionId && session.status === "CLOSED");
  }, "table visit closed");`);

source = replaceExact(source,
`  assert(psqlScalar(\`select status from public.table_sessions where id='\${sql(sessionId)}'\`) === "CLOSED", "refund reopened closed table visit");`,
`  const postRefundSnapshot = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
  assert(postRefundSnapshot.tableSessions.some((session) => session.id === sessionId && session.status === "CLOSED"), "refund reopened closed table visit");`);

source = replaceExact(source,
`  assert(Number(psqlScalar(\`select count(*) from public.command_deduplication where location_id='\${LOCATION_ID}' and command='dd008d_set_product_availability' and command_key='\${sql(idemKey)}'\`)) === 1, "duplicate idempotency created more than one dedup record");`,
`  // Hosted DB contracts already prove one dedup row; the browser gate proves replay returns the same authoritative timestamp.`);

source = replaceExact(source,
`async function serveAllReadyForNote(page, note, expectedCount) {
  let served = 0;
  while (served < expectedCount) {
    const card = page.locator(".order-card").filter({ hasText: note }).first();
    await card.waitFor({ timeout: 30_000 });
    const button = card.locator("[data-serve-line]").first();
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    served += 1;
    await sleep(100);
  }
}`,
`async function serveAllReadyForNote(page, note, expectedCount) {
  let served = 0;
  while (served < expectedCount) {
    const card = page.locator(".order-card").filter({ hasText: note }).first();
    await card.waitFor({ timeout: 30_000 });
    const button = card.locator("[data-serve-line]").first();
    await button.waitFor({ timeout: 30_000 });
    const lineId = await button.getAttribute("data-serve-line");
    assert(lineId, "serve action missing line id");
    await button.click();
    await sleep(800);
    const notice = await page.locator(".notice").last().innerText().catch(() => "");
    console.log(\`DD008_HOSTED_SERVE_NOTICE=\${lineId}:\${String(notice).replace(/\\s+/g, " ").slice(0, 220)}\`);
    try {
      await waitFor(async () => {
        const refreshed = page.locator(".order-card").filter({ hasText: note }).first();
        return await refreshed.locator(\`[data-serve-line="\${lineId}"]\`).count() === 0;
      }, \`serve line \${lineId} convergence\`, 15_000);
    } catch (error) {
      const diagnostic = await callHostedBootstrap("diagnose", { runId });
      console.log("DD008_HOSTED_SERVE_SERVER_DIAG=" + JSON.stringify(diagnostic?.diagnostic || {}));
      throw error;
    }
    served += 1;
  }
}`);

source = replaceExact(source,
`  await waitOrderStatus(runtimeClients.cashier, firstOrder.id, "SERVED", accounts.cashier);`,
`  try {
    await waitOrderStatus(runtimeClients.cashier, firstOrder.id, "SERVED", accounts.cashier);
  } catch (error) {
    const snapshot = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
    const order = snapshot.orders.find((candidate) => candidate.id === firstOrder.id);
    console.log("DD008_HOSTED_SERVE_DIAG=" + JSON.stringify({
      status: order?.status || "MISSING",
      items: (order?.items || []).map((item) => ({ lineId: item.lineId, id: item.id, servedQty: item.servedQty, qty: item.qty, prepStatus: item.prepStatus, status: item.status }))
    }));
    throw error;
  }`);

const hostedHelpers = `
async function provisionHostedFixture() {
  const result = await callHostedBootstrap("setup", {
    runId,
    accounts: Object.values(accounts),
    qrTokens
  });
  if (!result?.ok) throw new Error(\`hosted bootstrap setup failed: \${result?.reason || "UNKNOWN"}\`);
}

async function cleanupHostedFixture() {
  const result = await callHostedBootstrap("cleanup", { runId });
  if (!result?.ok) throw new Error(\`hosted bootstrap cleanup failed: \${result?.reason || "UNKNOWN"}\`);
}

async function callHostedBootstrap(action, payload) {
  const token = await githubOidcToken();
  const response = await fetch(bootstrapUrl, {
    method: "POST",
    headers: {
      authorization: \`Bearer \${token}\`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(\`hosted bootstrap HTTP \${response.status}: \${body?.reason || "UNKNOWN"}\`);
  return body;
}

async function githubOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error("GitHub OIDC environment unavailable");
  const url = new URL(requestUrl);
  url.searchParams.set("audience", "deedou-hosted-smoke");
  const response = await fetch(url, { headers: { authorization: \`Bearer \${requestToken}\` } });
  if (!response.ok) throw new Error(\`GitHub OIDC request failed: \${response.status}\`);
  const body = await response.json();
  if (!body?.value) throw new Error("GitHub OIDC token missing");
  return body.value;
}
`;
source += hostedHelpers;

await writeFile(runtimePath, source, "utf8");
console.log(`DD008_HOSTED_RUN_ID=${runId}`);
try {
  const result = spawnSync(process.execPath, [runtimePath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  await unlink(runtimePath).catch(() => {});
}

function replaceExact(text, expected, replacement) {
  if (!text.includes(expected)) throw new Error(`hosted launcher patch target missing: ${expected.slice(0, 100)}`);
  return text.replace(expected, replacement);
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
