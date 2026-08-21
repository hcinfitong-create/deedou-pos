import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const LOCATION_ID = "deedou-demo";
const BASE_URL = "http://127.0.0.1:8099";
const DB_URL = process.env.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = env.API_URL || env.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = env.ANON_KEY || env.SUPABASE_ANON_KEY;
const serviceRoleKey = env.SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!anonKey || !serviceRoleKey) throw new Error("Supabase local keys unavailable");

const runId = `dd012_diag_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const staffId = `${runId}_staff`;
const deviceId = `${runId}_device`;
const deviceCredential = `${runId}_device_secret`;
const email = `${runId}@example.invalid`;
const password = `Dd12!${randomUUID().slice(0, 8)}Aa1`;
const adminClient = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
let userId = "";
let server;
let browser;

try {
  const created = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data?.user?.id) throw new Error(`createUser: ${created.error?.message || "missing user"}`);
  userId = created.data.user.id;
  psql(`
    insert into public.staff_profiles (id, auth_user_id, display_name, active)
    values ('${sql(staffId)}','${sql(userId)}','DD-012 Admin Diagnostic',true)
    on conflict (id) do update set active=true;
    insert into public.staff_location_assignments (staff_profile_id, location_id, active)
    values ('${sql(staffId)}','${LOCATION_ID}',true)
    on conflict (staff_profile_id,location_id) do update set active=true;
    insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
    values ('${sql(staffId)}','${LOCATION_ID}','ADMIN_MENU',true)
    on conflict (staff_profile_id,location_id,role_id) do update set active=true;
    insert into public.workstation_devices (id,location_id,label,mode,credential_hash,active,registered_by_staff_profile_id)
    values ('${sql(deviceId)}','${LOCATION_ID}','DD-012 Admin Diagnostic','ADMIN',public.hash_device_credential('${sql(deviceCredential)}'),true,'${sql(staffId)}')
    on conflict (id) do update set active=true, mode=excluded.mode, credential_hash=excluded.credential_hash;
  `);

  server = await startStaticServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript(({ backendConfig, secret }) => {
    window.DEEDOU_BACKEND_CONFIG = backendConfig;
    window.__DEEDOU_BACKEND_CONFIG__ = backendConfig;
    localStorage.setItem("deedou_device_credential", secret);
    localStorage.setItem("deedou_workstation_mode", "ADMIN");
    localStorage.setItem("deedou_staff_location_id", "deedou-demo");
  }, {
    backendConfig: { mode: "SUPABASE", supabaseUrl: apiUrl, supabasePublishableKey: anonKey },
    secret: deviceCredential
  });

  const page = await context.newPage();
  const responses = [];
  const consoleErrors = [];
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    responses.push(`${response.status()} ${response.request().method()} ${url.origin}${url.pathname}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${BASE_URL}/#/admin`, { waitUntil: "domcontentloaded" });
  const form = page.locator("[data-auth-login]");
  await form.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Đang kiểm tra quyền truy cập."), null, { timeout: 25_000 });
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('input[name="locationId"]').fill(LOCATION_ID);
  await form.locator('select[name="workstationMode"]').selectOption("ADMIN");
  await form.locator('button[type="submit"]').click();
  await page.locator("[data-dd008d-admin-menu]").waitFor({ timeout: 30_000 });
  await page.locator("[data-dd011-security-admin]").waitFor({ timeout: 30_000 });
  await page.locator("[data-dd008d-admin-refresh]").click();
  await page.locator('[data-dd008d-admin-product="fried-rice"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(3_000);

  console.log("DD-012 admin diagnostic HTTP >=400:");
  console.log(responses.length ? responses.join("\n") : "none");
  console.log("DD-012 admin diagnostic console errors:");
  console.log(consoleErrors.length ? consoleErrors.join("\n") : "none");

  if (responses.some((entry) => entry.startsWith("401 "))) throw new Error("ADMIN_401_REPRODUCED");
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolveClose) => server?.close?.(resolveClose) || resolveClose());
  if (userId) await adminClient.auth.admin.deleteUser(userId).catch(() => {});
}

function psql(statement) {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function startStaticServer() {
  const root = resolve(process.cwd());
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
  const active = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, BASE_URL).pathname;
      if (pathname === "/api/runtime-config") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end("/* DD-012 local diagnostic runtime config no-op */");
        return;
      }
      const filePath = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
      if (!filePath.startsWith(root)) throw new Error("invalid path");
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      const body = await readFile(resolve(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(body);
    }
  });
  await new Promise((resolveListen, reject) => {
    active.once("error", reject);
    active.listen(8099, "127.0.0.1", resolveListen);
  });
  return active;
}

function parseEnvOutput(output) {
  return Object.fromEntries(String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    if (index < 0) return [line, ""];
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [key, value];
  }));
}

function sql(value) {
  return String(value || "").replaceAll("'", "''");
}
