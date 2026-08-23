export function createInitialComponentsUiState(overrides = {}) {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    saving: false,
    products: [],
    components: [],
    selectedProductId: "",
    message: "",
    contextKey: "",
    ...overrides
  };
}

export function componentAuthorityContextKey({ locationId = "", workstationMode = "ADMIN" } = {}) {
  return `${text(locationId)}|${text(workstationMode) || "ADMIN"}`;
}

export function reconcileComponentsUiContext(state = createInitialComponentsUiState(), contextKey = "", { authenticated = true } = {}) {
  if (!authenticated) return createInitialComponentsUiState();
  const nextContextKey = text(contextKey);
  return state.contextKey === nextContextKey
    ? state
    : createInitialComponentsUiState({ contextKey: nextContextKey });
}

export function shouldLoadComponentsMenu(state = createInitialComponentsUiState(), { force = false, supabaseMode = true } = {}) {
  if (!supabaseMode || state.loading) return false;
  if (force) return true;
  return !state.loaded && !state.loadAttempted;
}

export function markComponentsMenuLoadStarted(state = createInitialComponentsUiState()) {
  return {
    ...state,
    loading: true,
    loadAttempted: true,
    message: ""
  };
}

export function markComponentsMenuLoadFailed(state = createInitialComponentsUiState(), result = {}) {
  return {
    ...state,
    loading: false,
    loaded: false,
    loadAttempted: true,
    message: resultMessage(result)
  };
}

export function resultMessage(result) {
  return [result?.category, result?.reason].filter(Boolean).join(" · ") || "COMPONENT_COMMAND_FAILED";
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
