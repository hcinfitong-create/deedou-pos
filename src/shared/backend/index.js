export {
  BACKEND_CONFIG_KEYS,
  BACKEND_MODES,
  CONNECTION_STATES,
  getBackendConfig,
  getBackendMode,
  readRuntimeBackendConfig,
  validatePublicBackendConfig
} from "./config.js";

export {
  CUTOVER_CONFIG_KEY,
  CUTOVER_STAGES,
  cutoverPolicy,
  getCutoverStage,
  isAuthoritativeCutover
} from "./cutover.js";

export {
  createBackendClient,
  getConnectionState,
  probeBackendConnection,
  subscribeConnectionState
} from "./connection.js";

export {
  COMMAND_FAILURE_CATEGORIES,
  commandFailure,
  normalizeCommandResult
} from "./commands.js";

export {
  OPERATIONAL_STATE_EVENT,
  createAuthoritativeBackendApi
} from "./authoritative.js";

export {
  AUTH_HEALTH_STATES,
  OPERATIONAL_STATES,
  REALTIME_HEALTH_STATES,
  createCorrelationId,
  createOperationalStateController,
  deriveOperationalState,
  evaluateMutationSafety,
  sanitizeOperationalDiagnostic
} from "./resilience.js";

export { createReconnectCoordinator } from "./reconnect.js";

export {
  LEGACY_EXPORT_SCHEMA_VERSION,
  LEGACY_EXPORT_SOURCE,
  buildLegacyExport,
  createLegacyMigrationApi,
  previewLegacyExport,
  serializeLegacyExport
} from "./migration.js";
