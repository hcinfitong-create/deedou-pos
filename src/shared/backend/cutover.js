import { BACKEND_MODES, getBackendConfig, readRuntimeBackendConfig } from "./config.js";

export const CUTOVER_STAGES = Object.freeze({
  LOCAL_DEMO: "LOCAL_DEMO",
  SUPABASE_TEST: "SUPABASE_TEST",
  SUPABASE_AUTHORITATIVE: "SUPABASE_AUTHORITATIVE"
});

export const CUTOVER_CONFIG_KEY = "DEEDOU_CUTOVER_STAGE";

export function getCutoverStage(input = readRuntimeBackendConfig()) {
  const raw = input && typeof input === "object" ? input : {};
  const configuredBackend = getBackendConfig(normalizeBackendInput(raw));
  if (configuredBackend.mode !== BACKEND_MODES.SUPABASE) return CUTOVER_STAGES.LOCAL_DEMO;
  const requested = normalizeStage(raw.cutoverStage || raw[CUTOVER_CONFIG_KEY] || raw.mode);
  return requested === CUTOVER_STAGES.SUPABASE_TEST
    ? CUTOVER_STAGES.SUPABASE_TEST
    : CUTOVER_STAGES.SUPABASE_AUTHORITATIVE;
}

export function isAuthoritativeCutover(input) {
  return getCutoverStage(input) === CUTOVER_STAGES.SUPABASE_AUTHORITATIVE;
}

export function cutoverPolicy(input = readRuntimeBackendConfig()) {
  const stage = getCutoverStage(input);
  return Object.freeze({
    stage,
    serverAuthority: stage !== CUTOVER_STAGES.LOCAL_DEMO,
    allowLocalBusinessWrites: stage === CUTOVER_STAGES.LOCAL_DEMO,
    allowLegacyAutoImport: false,
    allowDualWrite: false,
    cachedBusinessReadsAreStaleWhenOffline: stage !== CUTOVER_STAGES.LOCAL_DEMO,
    requireAuthoritativeRefetchAfterReconnect: stage !== CUTOVER_STAGES.LOCAL_DEMO
  });
}

function normalizeBackendInput(raw) {
  const mode = normalizeStage(raw.mode);
  if (mode === CUTOVER_STAGES.SUPABASE_TEST || mode === CUTOVER_STAGES.SUPABASE_AUTHORITATIVE) {
    return { ...raw, mode: BACKEND_MODES.SUPABASE };
  }
  return raw;
}

function normalizeStage(value) {
  const stage = String(value || "").trim().toUpperCase();
  if (stage === CUTOVER_STAGES.SUPABASE_TEST) return CUTOVER_STAGES.SUPABASE_TEST;
  if (stage === CUTOVER_STAGES.SUPABASE_AUTHORITATIVE || stage === BACKEND_MODES.SUPABASE) return CUTOVER_STAGES.SUPABASE_AUTHORITATIVE;
  return CUTOVER_STAGES.LOCAL_DEMO;
}
