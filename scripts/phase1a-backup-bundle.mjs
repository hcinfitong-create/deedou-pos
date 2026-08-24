import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

export const BACKUP_FORMAT = "deedou.phase1a.logical-backup.v1";
export const PASSPHRASE_ENV = "DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE";
export const PRODUCTION_DB_URL_ENV = "DEEDOU_PRODUCTION_DB_URL";
export const EXPECTED_PRODUCTION_REF = "nwohsyzpmogqjbmknwbl";
export const KNOWN_NON_PRODUCTION_REFS = new Set(["nwyhxdcslxxjirsmqnxo"]);
export const REQUIRED_SQL_FILES = [
  "roles.sql",
  "schema.sql",
  "data.sql",
  "migration_history_schema.sql",
  "migration_history_data.sql",
  "auth_schema.sql",
  "auth_data.sql",
];
const OPTIONAL_FILES = ["verification.json"];
const PBKDF2_ITERATIONS = 210000;
const SUPABASE_PROJECT_REF_PATTERN = /[a-z0-9]{20}/g;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function requirePassphrase(passphrase = process.env[PASSPHRASE_ENV]) {
  if (!passphrase || Buffer.byteLength(passphrase, "utf8") === 0) {
    throw new Error(`${PASSPHRASE_ENV} is required`);
  }
  return passphrase;
}

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

export function collectSupabaseProjectRefsFromDbUrl(dbUrl) {
  let parsed;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error("Configured Production DB URL is malformed or unsupported");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Configured Production DB URL is malformed or unsupported");
  }

  const refs = new Set();
  for (const part of [parsed.hostname, decodeUrlPart(parsed.username)]) {
    const matches = String(part || "").toLowerCase().match(SUPABASE_PROJECT_REF_PATTERN) || [];
    for (const match of matches) refs.add(match);
  }
  return [...refs].sort();
}

export function validateProductionDbUrl({
  dbUrl = process.env[PRODUCTION_DB_URL_ENV],
  expectedRef = EXPECTED_PRODUCTION_REF,
  forbiddenRefs = KNOWN_NON_PRODUCTION_REFS,
} = {}) {
  if (!dbUrl) {
    throw new Error(`${PRODUCTION_DB_URL_ENV} is required`);
  }
  const refs = collectSupabaseProjectRefsFromDbUrl(dbUrl);
  if (refs.length === 0) {
    throw new Error("Configured Production DB URL does not target the expected Production project ref");
  }
  if (refs.length > 1) {
    throw new Error("Configured Production DB URL is ambiguous; multiple Supabase project refs were detected");
  }
  if (forbiddenRefs.has(refs[0]) || refs[0] !== expectedRef) {
    throw new Error("Configured Production DB URL does not target the expected Production project ref");
  }
  return { ok: true, projectRef: expectedRef };
}

function sanitizeVerificationForManifest(verification) {
  if (!verification || typeof verification !== "object") return undefined;
  const sanitized = {};
  if (verification.capturedAt) sanitized.capturedAt = verification.capturedAt;
  if (verification.sourceProjectRef) sanitized.sourceProjectRef = verification.sourceProjectRef;
  if (verification.counts) sanitized.counts = verification.counts;
  if (verification.auth?.counts) {
    sanitized.auth = {
      counts: verification.auth.counts,
      relationsExpected: Object.keys(verification.auth.relations || {}).sort(),
    };
  }
  if (verification.ownerRecovery) {
    sanitized.ownerRecovery = verification.ownerRecovery;
  }
  if (verification.cliDumpProbe) {
    sanitized.cliDumpProbe = verification.cliDumpProbe;
  }
  if (verification.migrationHistory?.rows) {
    sanitized.migrationHistory = {
      count: verification.migrationHistory.rows.length,
      rowsSha256: hashJson(sortMigrationRows(verification.migrationHistory.rows)),
    };
  }
  return sanitized;
}

function sortMigrationRows(rows = []) {
  return [...rows]
    .map((row) => ({
      version: String(row.version || ""),
      name: String(row.name || ""),
    }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

async function readBackupFiles(inputDir) {
  const files = {};
  for (const fileName of REQUIRED_SQL_FILES) {
    const filePath = join(inputDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Missing required backup file: ${fileName}`);
    }
    files[fileName] = await readFile(filePath);
  }

  for (const fileName of OPTIONAL_FILES) {
    const filePath = join(inputDir, fileName);
    if (existsSync(filePath)) {
      files[fileName] = await readFile(filePath);
    }
  }
  return files;
}

async function buildManifest({ inputDir, sourceRef, createdAt = new Date().toISOString() }) {
  if (!sourceRef || sourceRef.trim() === "") {
    throw new Error("A non-secret source project ref/name is required");
  }

  const fileEntries = {};
  for (const fileName of [...REQUIRED_SQL_FILES, ...OPTIONAL_FILES]) {
    const filePath = join(inputDir, fileName);
    if (!existsSync(filePath)) continue;
    const fileStat = await stat(filePath);
    const content = await readFile(filePath);
    fileEntries[fileName] = {
      bytes: fileStat.size,
      sha256: sha256(content),
    };
  }

  const manifest = {
    format: BACKUP_FORMAT,
    createdAt,
    source: {
      projectRef: sourceRef,
    },
    files: fileEntries,
  };

  const verificationPath = join(inputDir, "verification.json");
  if (existsSync(verificationPath)) {
    const verification = JSON.parse(await readFile(verificationPath, "utf8"));
    manifest.verification = sanitizeVerificationForManifest(verification);
  }

  return manifest;
}

export async function recordDumpProbe({ verificationPath, schemaPath, dataPath }) {
  const resolvedVerification = resolve(verificationPath);
  const verification = existsSync(resolvedVerification)
    ? JSON.parse(await readFile(resolvedVerification, "utf8"))
    : {};
  const schemaText = await readFile(resolve(schemaPath), "utf8");
  const dataText = await readFile(resolve(dataPath), "utf8");
  verification.cliDumpProbe = {
    supabaseCliVersion: process.env.DEEDOU_SUPABASE_CLI_VERSION || "UNKNOWN",
    standardDumpContainsAuthSchema:
      /CREATE TABLE\s+(auth\.|"auth"\.)?"?users"?/i.test(schemaText) ||
      /CREATE SCHEMA\s+(auth|"auth")/i.test(schemaText),
    standardDumpContainsAuthData:
      /COPY\s+(auth\.|"auth"\.)?"?users"?/i.test(dataText) ||
      /INSERT INTO\s+(auth\.|"auth"\.)?"?users"?/i.test(dataText),
  };
  await writeFile(resolvedVerification, `${JSON.stringify(verification, null, 2)}\n`);
  return verification.cliDumpProbe;
}

export async function packBackupBundle({
  inputDir,
  outputPath,
  sourceRef,
  manifestOutputPath,
  passphrase = process.env[PASSPHRASE_ENV],
  createdAt,
}) {
  const resolvedInput = resolve(inputDir);
  const resolvedOutput = resolve(outputPath);
  const safePassphrase = requirePassphrase(passphrase);
  const files = await readBackupFiles(resolvedInput);
  const manifest = await buildManifest({ inputDir: resolvedInput, sourceRef, createdAt });

  const payload = {
    manifest,
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, content.toString("base64")]),
    ),
  };
  const plaintext = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(safePassphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(BACKUP_FORMAT, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = {
    format: BACKUP_FORMAT,
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "pbkdf2-sha256",
      iterations: PBKDF2_ITERATIONS,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };

  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

  if (manifestOutputPath) {
    const resolvedManifestOutput = resolve(manifestOutputPath);
    await mkdir(dirname(resolvedManifestOutput), { recursive: true });
    await writeFile(resolvedManifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return manifest;
}

export async function unpackBackupBundle({
  inputPath,
  outputDir,
  passphrase = process.env[PASSPHRASE_ENV],
}) {
  const safePassphrase = requirePassphrase(passphrase);
  const envelope = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  if (envelope.format !== BACKUP_FORMAT) {
    throw new Error(`Unsupported backup format: ${envelope.format || "UNKNOWN"}`);
  }
  if (envelope.encryption?.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported backup encryption algorithm");
  }

  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const iv = Buffer.from(envelope.encryption.iv, "base64");
  const authTag = Buffer.from(envelope.encryption.authTag, "base64");
  const key = deriveKey(safePassphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(BACKUP_FORMAT, "utf8"));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const payload = JSON.parse(gunzipSync(decrypted).toString("utf8"));
  const manifest = payload.manifest;
  if (!manifest || manifest.format !== BACKUP_FORMAT) {
    throw new Error("Backup payload manifest is missing or invalid");
  }

  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  for (const [fileName, encodedContent] of Object.entries(payload.files || {})) {
    const content = Buffer.from(encodedContent, "base64");
    const expected = manifest.files?.[fileName];
    if (!expected) {
      throw new Error(`Backup payload includes unexpected file: ${fileName}`);
    }
    if (sha256(content) !== expected.sha256) {
      throw new Error(`Checksum mismatch for ${fileName}`);
    }
    await writeFile(join(resolvedOutput, fileName), content, { mode: 0o600 });
  }
  await writeFile(join(resolvedOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
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
  if (command === "pack") {
    const inputDir = readFlag(args, "--input-dir");
    const outputPath = readFlag(args, "--output");
    const sourceRef = readFlag(args, "--source-ref");
    const manifestOutputPath = readFlag(args, "--manifest-output");
    if (!inputDir || !outputPath || !sourceRef) {
      throw new Error("Usage: phase1a-backup-bundle.mjs pack --input-dir <dir> --output <file> --source-ref <ref> [--manifest-output <file>]");
    }
    const manifest = await packBackupBundle({ inputDir, outputPath, sourceRef, manifestOutputPath });
    console.log(`Created encrypted DeeDou logical backup bundle for ${manifest.source.projectRef}`);
    return;
  }

  if (command === "unpack") {
    const inputPath = readFlag(args, "--input");
    const outputDir = readFlag(args, "--output-dir");
    if (!inputPath || !outputDir) {
      throw new Error("Usage: phase1a-backup-bundle.mjs unpack --input <file> --output-dir <dir>");
    }
    const manifest = await unpackBackupBundle({ inputPath, outputDir });
    console.log(`Decrypted DeeDou logical backup bundle created at ${manifest.createdAt}`);
    return;
  }

  if (command === "record-probe") {
    const verificationPath = readFlag(args, "--verification");
    const schemaPath = readFlag(args, "--schema");
    const dataPath = readFlag(args, "--data");
    if (!verificationPath || !schemaPath || !dataPath) {
      throw new Error("Usage: phase1a-backup-bundle.mjs record-probe --verification <file> --schema <file> --data <file>");
    }
    const probe = await recordDumpProbe({ verificationPath, schemaPath, dataPath });
    console.log(
      `Recorded Supabase CLI dump probe: standardAuthSchema=${probe.standardDumpContainsAuthSchema}, standardAuthData=${probe.standardDumpContainsAuthData}`,
    );
    return;
  }

  if (command === "validate-production-url") {
    const expectedRef = readFlag(args, "--expected-ref") || EXPECTED_PRODUCTION_REF;
    validateProductionDbUrl({ expectedRef });
    console.log("Validated configured Production DB target ref.");
    return;
  }

  throw new Error("Usage: phase1a-backup-bundle.mjs <pack|unpack|record-probe|validate-production-url> ...");
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
