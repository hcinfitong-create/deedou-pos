import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const sourcePath = "scripts/dd012b-preview-hosted-smoke.mjs";
const runtimePath = "scripts/.dd012b-production-hosted-smoke-runtime.mjs";
const original = await readFile(sourcePath, "utf8");

try {
  let runtime = replaceExact(
    original,
    'if (prNumber !== 44) throw new Error(`DD-012B hosted gate must run on PR #44, got #${prNumber}`);',
    'const expectedPrNumber = Number(requireEnv("DEEDOU_EXPECTED_PR_NUMBER"));\nif (prNumber !== expectedPrNumber) throw new Error(`DD-012B production hosted gate must run on PR #${expectedPrNumber}, got #${prNumber}`);'
  );
  runtime = replaceExact(
    runtime,
    "const previewUrl = await discoverReadyVercelPreview();",
    'const previewUrl = requireEnv("DEEDOU_PRODUCTION_URL").replace(/\\/+$/, "");'
  );
  runtime = runtime
    .replaceAll("DD012B_STAGING_", "DD012B_PRODUCTION_")
    .replaceAll("DD012B_PREVIEW_", "DD012B_PRODUCTION_")
    .replaceAll("DD-012B hosted staging options smoke passed", "DD-012B hosted production options smoke passed")
    .replaceAll("Preview ", "Production ")
    .replaceAll("preview ", "production ");

  await writeFile(runtimePath, runtime, "utf8");
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
  if (!text.includes(expected)) {
    throw new Error(`Production smoke patch target missing: ${expected.slice(0, 120)}`);
  }
  return text.replace(expected, replacement);
}
