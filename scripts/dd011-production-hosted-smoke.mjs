import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const sourcePath = "scripts/dd011-preview-hosted-smoke.mjs";
const runtimePath = "scripts/.dd011-production-hosted-smoke-runtime.mjs";
const original = await readFile(sourcePath, "utf8");

try {
  let runtime = replaceExact(
    original,
    'if (prNumber !== 38) throw new Error(`DD-011 hosted gate must run on PR #38, got #${prNumber}`);',
    'const expectedPrNumber = Number(requireEnv("DEEDOU_EXPECTED_PR_NUMBER"));\nif (prNumber !== expectedPrNumber) throw new Error(`DD-011 production hosted gate must run on PR #${expectedPrNumber}, got #${prNumber}`);'
  );
  runtime = replaceExact(
    runtime,
    "const previewUrl = await discoverReadyVercelPreview();",
    'const previewUrl = requireEnv("DEEDOU_PRODUCTION_URL").replace(/\\/+$/, "");'
  );
  runtime = runtime
    .replaceAll("DD011_STAGING_", "DD011_PRODUCTION_")
    .replaceAll("DD011_PREVIEW_", "DD011_PRODUCTION_")
    .replaceAll("DD-011 hosted staging security smoke passed", "DD-011 hosted production security smoke passed")
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
