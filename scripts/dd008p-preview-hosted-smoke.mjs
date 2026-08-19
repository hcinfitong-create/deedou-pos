import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const previewUrl = requireEnv("DEEDOU_PREVIEW_URL").replace(/\/+$/, "");
const apiUrl = requireEnv("DEEDOU_HOSTED_SUPABASE_URL");
const publishableKey = requireEnv("DEEDOU_HOSTED_SUPABASE_PUBLISHABLE_KEY");
requireEnv("DEEDOU_HOSTED_BOOTSTRAP_URL");

const sourcePath = "scripts/dd008d-browser-smoke.mjs";
const launcherPath = "scripts/.dd008d-pr31-hosted-launcher.mjs";
const launcherUrl = "https://raw.githubusercontent.com/hcinfitong-create/deedou-pos/52f70c75a19db3a405e435aa6c9d61b3b76f2d39/scripts/dd008d-hosted-smoke-launcher.mjs";
const launcherBlobSha = "666413bda14307f72ab404ab407b8641dc4c15e1";

const originalSource = await readFile(sourcePath, "utf8");

try {
  const vercelOidcToken = await githubOidcToken();
  process.env.DEEDOU_VERCEL_TRUSTED_OIDC_TOKEN = vercelOidcToken;
  await waitForPreviewRuntimeConfig(vercelOidcToken);

  let patchedSource = originalSource;
  patchedSource = replaceExact(
    patchedSource,
    'const BASE_URL = "http://127.0.0.1:8099";',
    `const BASE_URL = ${JSON.stringify(previewUrl)};`
  );
  patchedSource = replaceExact(
    patchedSource,
    "  server = await startStaticServer();",
    "  server = null;"
  );
  patchedSource = replaceExact(
    patchedSource,
`async function createBrowserContext(spec = {}) {
  const context = await browser.newContext({ timezoneId: spec.timezoneId || "Asia/Ho_Chi_Minh" });
  await context.addInitScript(({ backendConfig, deviceSecret, mode }) => {
    window.DEEDOU_BACKEND_CONFIG = backendConfig;
    window.__DEEDOU_BACKEND_CONFIG__ = backendConfig;
    if (deviceSecret) localStorage.setItem("deedou_device_credential", deviceSecret);
    if (mode) localStorage.setItem("deedou_workstation_mode", mode);
    localStorage.setItem("deedou_staff_location_id", "deedou-demo");
  }, {
    backendConfig: { mode: "SUPABASE", supabaseUrl: apiUrl, supabasePublishableKey: anonKey },
    deviceSecret: spec.deviceSecret || "",
    mode: spec.mode || ""
  });
  return context;
}`,
`async function createBrowserContext(spec = {}) {
  const context = await browser.newContext({ timezoneId: spec.timezoneId || "Asia/Ho_Chi_Minh" });
  const vercelOidcToken = String(process.env.DEEDOU_VERCEL_TRUSTED_OIDC_TOKEN || "");
  if (!vercelOidcToken) throw new Error("Vercel trusted OIDC token unavailable");
  await context.route(\`${previewUrl}/**\`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-vercel-trusted-oidc-idp-token": vercelOidcToken
      }
    });
  });
  await context.addInitScript(({ deviceSecret, mode }) => {
    if (deviceSecret) localStorage.setItem("deedou_device_credential", deviceSecret);
    if (mode) localStorage.setItem("deedou_workstation_mode", mode);
    localStorage.setItem("deedou_staff_location_id", "deedou-demo");
  }, {
    deviceSecret: spec.deviceSecret || "",
    mode: spec.mode || ""
  });
  return context;
}`
  );

  await writeFile(sourcePath, patchedSource, "utf8");

  const launcherResponse = await fetch(launcherUrl, {
    headers: { accept: "text/plain", "cache-control": "no-cache" }
  });
  if (!launcherResponse.ok) {
    throw new Error(`Pinned PR #31 launcher fetch failed: HTTP ${launcherResponse.status}`);
  }
  const launcherSource = await launcherResponse.text();
  const actualBlobSha = gitBlobSha(launcherSource);
  if (actualBlobSha !== launcherBlobSha) {
    throw new Error(`Pinned PR #31 launcher blob mismatch: ${actualBlobSha}`);
  }
  await writeFile(launcherPath, launcherSource, "utf8");

  console.log(`DD008_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD008_REUSED_PR31_LAUNCHER_BLOB=${actualBlobSha}`);
  console.log("DD008_VERCEL_TRUSTED_OIDC=PASS");

  const result = spawnSync(process.execPath, [launcherPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  delete process.env.DEEDOU_VERCEL_TRUSTED_OIDC_TOKEN;
  await writeFile(sourcePath, originalSource, "utf8").catch(() => {});
  await unlink(launcherPath).catch(() => {});
}

async function waitForPreviewRuntimeConfig(vercelOidcToken) {
  const startedAt = Date.now();
  let last = "not attempted";
  while (Date.now() - startedAt < 120_000) {
    try {
      const response = await fetch(`${previewUrl}/api/runtime-config`, {
        headers: {
          "cache-control": "no-cache",
          "x-vercel-trusted-oidc-idp-token": vercelOidcToken
        }
      });
      const body = await response.text();
      const safe = !/service_role|SUPABASE_SECRET|DATABASE_URL|DB_PASSWORD|JWT_SECRET/i.test(body);
      const expected = body.includes('"mode":"SUPABASE"')
        && body.includes(apiUrl)
        && body.includes(publishableKey);
      if (response.ok && safe && expected) {
        console.log("DD008_PREVIEW_RUNTIME_CONFIG=PASS");
        return;
      }
      last = `status=${response.status} safe=${safe} expected=${expected}`;
    } catch (error) {
      last = safeMessage(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Preview runtime config did not become ready: ${last}`);
}

async function githubOidcToken() {
  const requestUrl = String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || "").trim();
  const requestToken = String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "").trim();
  if (!requestUrl || !requestToken) throw new Error("GitHub OIDC environment unavailable");
  const response = await fetch(requestUrl, {
    headers: { authorization: `Bearer ${requestToken}` }
  });
  if (!response.ok) throw new Error(`GitHub OIDC request failed: ${response.status}`);
  const body = await response.json();
  if (!body?.value) throw new Error("GitHub OIDC token missing");
  return body.value;
}

function gitBlobSha(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes}\0`, "utf8")
    .update(content, "utf8")
    .digest("hex");
}

function replaceExact(text, expected, replacement) {
  if (!text.includes(expected)) {
    throw new Error(`Preview smoke patch target missing: ${expected.slice(0, 120)}`);
  }
  return text.replace(expected, replacement);
}

function safeMessage(error) {
  return String(error?.message || error || "UNKNOWN")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .slice(0, 240);
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
