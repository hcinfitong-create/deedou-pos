import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_AUTH_DATA_TABLES = {
  users: { schema: "auth", table: "users" },
  identities: { schema: "auth", table: "identities" },
  mfaFactors: { schema: "auth", table: "mfa_factors" },
};

const SUPABASE_MANAGED_RESTORE_INCOMPATIBLE_ROLE_SETTINGS = [
  {
    role: "authenticator",
    guc: "log_min_messages",
    normalizedValue: "fatal",
    reason: "LOCAL_RESTORE_TARGET_REJECTS_MANAGED_LOG_GUC",
  },
];

function unquoteIdentifier(identifier) {
  const text = String(identifier || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('""', '"');
  }
  return text;
}

function normalizeSqlValue(value) {
  const text = String(value || "").trim().replace(/;$/, "").trim();
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'").toLowerCase();
  }
  return text.toLowerCase();
}

function splitSqlStatementsWithLines(sqlText) {
  const statements = [];
  const lines = String(sqlText || "").split(/\r?\n/);
  let startLine = 1;
  let current = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (current.length === 0) startLine = index + 1;
    current.push(line);
    if (/;\s*(?:--.*)?$/.test(line)) {
      statements.push({ text: `${current.join("\n")}\n`, startLine });
      current = [];
    }
  }

  if (current.length > 0 && current.some((line) => line.trim() !== "")) {
    statements.push({ text: `${current.join("\n")}\n`, startLine });
  }

  return statements;
}

function parseAlterRoleSet(statement) {
  const match = String(statement || "").match(
    /^\s*ALTER\s+ROLE\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+SET\s+("?[\w.]+\"?)\s+(?:TO|=)\s+(.+?)\s*;\s*$/is,
  );
  if (!match) return null;
  return {
    role: unquoteIdentifier(match[1]).toLowerCase(),
    guc: unquoteIdentifier(match[2]).toLowerCase(),
    normalizedValue: normalizeSqlValue(match[3]),
  };
}

function findManagedRoleSetting(setting) {
  return SUPABASE_MANAGED_RESTORE_INCOMPATIBLE_ROLE_SETTINGS.find(
    (allowed) =>
      allowed.role === setting.role &&
      allowed.guc === setting.guc &&
      allowed.normalizedValue === setting.normalizedValue,
  );
}

export async function prepareRolesForDisposableRestore({ inputPath, outputPath }) {
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputPath);
  const raw = await readFile(resolvedInput, "utf8");
  const prepared = [];
  const suppressed = [];

  for (const statement of splitSqlStatementsWithLines(raw)) {
    const parsed = parseAlterRoleSet(statement.text);
    if (parsed?.guc === "log_min_messages") {
      const allowed = findManagedRoleSetting(parsed);
      if (!allowed) {
        throw new Error(
          `Unexpected restore-incompatible role setting at roles.sql line ${statement.startLine}: role=${parsed.role}, guc=${parsed.guc}`,
        );
      }
      suppressed.push({ ...parsed, line: statement.startLine, reason: allowed.reason });
      prepared.push(
        `-- Phase 1A disposable restore intentionally suppresses Supabase-managed role setting at raw roles.sql line ${statement.startLine}: role=${parsed.role}, guc=${parsed.guc}, reason=${allowed.reason}\n`,
      );
      continue;
    }
    prepared.push(statement.text);
  }

  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, prepared.join(""), { mode: 0o600 });
  return { suppressed };
}

function authTablePattern({ schema, table }) {
  return `(?:"${schema}"|${schema})\\s*\\.\\s*(?:"${table}"|${table})`;
}

export function detectAuthDataTables(sqlText) {
  const text = String(sqlText || "");
  const result = {};
  for (const [key, table] of Object.entries(REQUIRED_AUTH_DATA_TABLES)) {
    const pattern = authTablePattern(table);
    result[key] =
      new RegExp(`(?:^|\\n)\\s*COPY\\s+${pattern}(?:\\s|\\()`, "i").test(text) ||
      new RegExp(`(?:^|\\n)\\s*INSERT\\s+INTO\\s+${pattern}(?:\\s|\\()`, "i").test(text);
  }
  return result;
}

function keyForSqlDataLine(line) {
  const match = String(line || "").match(
    /^\s*(?:COPY|INSERT\s+INTO)\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i,
  );
  if (!match) return null;
  const schema = unquoteIdentifier(match[1]).toLowerCase();
  const table = unquoteIdentifier(match[2]).toLowerCase();
  return Object.entries(REQUIRED_AUTH_DATA_TABLES).find(
    ([, required]) => required.schema === schema && required.table === table,
  )?.[0] || null;
}

function extractAuthDataStatements(sqlText, selectedKeys) {
  const selected = new Set(selectedKeys);
  const lines = String(sqlText || "").split(/\r?\n/);
  const output = [];
  const found = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = keyForSqlDataLine(line);
    if (!key) continue;

    const isCopy = /^\s*COPY\s+/i.test(line);
    const chunk = [line];
    if (isCopy) {
      let terminated = false;
      while (index + 1 < lines.length) {
        index += 1;
        chunk.push(lines[index]);
        if (lines[index].trim() === "\\.") {
          terminated = true;
          break;
        }
      }
      if (!terminated) {
        throw new Error(`Could not isolate auth_data.sql COPY block for ${key}`);
      }
    } else {
      while (!/;\s*$/.test(lines[index]) && index + 1 < lines.length) {
        index += 1;
        chunk.push(lines[index]);
      }
      if (!/;\s*$/.test(chunk[chunk.length - 1])) {
        throw new Error(`Could not isolate auth_data.sql INSERT statement for ${key}`);
      }
    }

    if (selected.has(key)) {
      found.add(key);
      output.push(...chunk, "");
    }
  }

  for (const key of selected) {
    if (!found.has(key)) {
      throw new Error(`Auth restore authority requires explicit auth_data.sql for ${key}, but no isolatable statement was found`);
    }
  }

  return output.join("\n");
}

export function buildAuthRestoreAuthority({ standardCoverage, explicitCoverage }) {
  const authority = {};
  const explicitRestoreKeys = [];
  const missing = [];

  for (const key of Object.keys(REQUIRED_AUTH_DATA_TABLES)) {
    if (standardCoverage?.[key] === true) {
      authority[key] = "data.sql";
    } else if (explicitCoverage?.[key] === true) {
      authority[key] = "auth_data.restore.sql";
      explicitRestoreKeys.push(key);
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Pinned Supabase CLI dump did not capture required Auth table data: ${missing.join(", ")}`);
  }

  return { authority, explicitRestoreKeys };
}

export async function prepareAuthDataForDisposableRestore({
  verificationPath,
  dataPath,
  authDataPath,
  outputPath,
}) {
  const resolvedVerification = resolve(verificationPath);
  const resolvedData = resolve(dataPath);
  const resolvedAuthData = resolve(authDataPath);
  const resolvedOutput = resolve(outputPath);
  if (!existsSync(resolvedVerification)) {
    throw new Error("verification.json is required to prepare Auth restore authority");
  }

  const verification = JSON.parse(await readFile(resolvedVerification, "utf8"));
  const dataText = await readFile(resolvedData, "utf8");
  const authDataText = await readFile(resolvedAuthData, "utf8");
  const standardCoverage = verification.cliDumpProbe?.standardDumpAuthTables || detectAuthDataTables(dataText);
  const explicitCoverage = verification.cliDumpProbe?.explicitAuthDumpTables || detectAuthDataTables(authDataText);
  const { authority, explicitRestoreKeys } = buildAuthRestoreAuthority({ standardCoverage, explicitCoverage });
  const selectedSql = extractAuthDataStatements(authDataText, explicitRestoreKeys);
  const header = [
    "-- Phase 1A derived Auth restore file.",
    "-- Raw auth_data.sql remains unchanged in the encrypted backup bundle.",
    ...Object.entries(authority).map(([key, source]) => `-- ${key}: ${source}`),
    "",
  ].join("\n");
  const body = selectedSql || "-- No explicit Auth data statements are required; standard data.sql is authoritative for required Auth tables.\n";

  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${header}${body}`, { mode: 0o600 });
  return { authority, explicitRestoreKeys };
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === "prepare-roles") {
    const inputPath = readFlag(args, "--input");
    const outputPath = readFlag(args, "--output");
    if (!inputPath || !outputPath) {
      throw new Error("Usage: phase1a-restore-prepare.mjs prepare-roles --input <roles.sql> --output <roles.restore.sql>");
    }
    const result = await prepareRolesForDisposableRestore({ inputPath, outputPath });
    const settings = result.suppressed.map((setting) => `${setting.role}.${setting.guc}`).join(", ") || "none";
    console.log(`Prepared disposable restore roles SQL; suppressed managed settings: ${settings}`);
    return;
  }

  if (command === "prepare-auth-data") {
    const verificationPath = readFlag(args, "--verification");
    const dataPath = readFlag(args, "--data");
    const authDataPath = readFlag(args, "--auth-data");
    const outputPath = readFlag(args, "--output");
    if (!verificationPath || !dataPath || !authDataPath || !outputPath) {
      throw new Error("Usage: phase1a-restore-prepare.mjs prepare-auth-data --verification <verification.json> --data <data.sql> --auth-data <auth_data.sql> --output <auth_data.restore.sql>");
    }
    const result = await prepareAuthDataForDisposableRestore({ verificationPath, dataPath, authDataPath, outputPath });
    console.log(
      `Prepared disposable restore Auth data SQL; explicit tables: ${result.explicitRestoreKeys.join(", ") || "none"}`,
    );
    return;
  }

  throw new Error("Usage: phase1a-restore-prepare.mjs <prepare-roles|prepare-auth-data> ...");
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
