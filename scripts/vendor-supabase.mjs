import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(root, "node_modules", "@supabase", "supabase-js", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version !== "2.112.3") {
  throw new Error(`Expected @supabase/supabase-js 2.112.3, got ${packageJson.version || "unknown"}`);
}

const source = join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js");
const destinationDir = join(root, "vendor");
const destination = join(destinationDir, "supabase.js");
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
console.log("Vendored @supabase/supabase-js 2.112.3 from npm package into vendor/supabase.js");
