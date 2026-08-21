import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const browserSmokePath = "scripts/dd008d-browser-smoke.mjs";
const hostedSmokePath = "scripts/dd008p-preview-hosted-smoke.mjs";
const runtimeHostedSmokePath = "scripts/.dd008p-production-hosted-smoke-runtime.mjs";
const productionSmokeLocationId = "deedou-prod-smoke";

const originalBrowserSmoke = await readFile(browserSmokePath, "utf8");
const originalHostedSmoke = await readFile(hostedSmokePath, "utf8");

try {
  const productionBrowserSmoke = replaceExact(
    originalBrowserSmoke,
    'const LOCATION_ID = "deedou-demo";',
    `const LOCATION_ID = ${JSON.stringify(productionSmokeLocationId)};`
  );
  await writeFile(browserSmokePath, productionBrowserSmoke, "utf8");

  let productionHostedSmoke = replaceExact(
    originalHostedSmoke,
    'localStorage.setItem("deedou_staff_location_id", "deedou-demo");',
    `localStorage.setItem("deedou_staff_location_id", ${JSON.stringify(productionSmokeLocationId)});`
  );
  productionHostedSmoke = productionHostedSmoke
    .replaceAll("DD008_PREVIEW_", "DD008_PRODUCTION_")
    .replaceAll("Preview runtime config", "Production runtime config")
    .replaceAll("preview runtime config", "production runtime config");
  await writeFile(runtimeHostedSmokePath, productionHostedSmoke, "utf8");

  const result = spawnSync(process.execPath, [runtimeHostedSmokePath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  await writeFile(browserSmokePath, originalBrowserSmoke, "utf8").catch(() => {});
  await unlink(runtimeHostedSmokePath).catch(() => {});
}

function replaceExact(text, expected, replacement) {
  if (!text.includes(expected)) {
    throw new Error(`Production smoke patch target missing: ${expected.slice(0, 120)}`);
  }
  return text.replace(expected, replacement);
}
