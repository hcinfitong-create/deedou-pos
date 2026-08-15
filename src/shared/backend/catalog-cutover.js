import { defaultProducts } from "../../features/customer-menu/index.js";
import { BACKEND_MODES, getBackendConfig } from "./config.js";

export function removeLegacyCatalogAuthorityFallback(products = defaultProducts) {
  for (const product of Array.isArray(products) ? products : []) {
    if (!product || typeof product !== "object") continue;
    // app.js historically treats an empty server array as "missing" and falls back
    // to these default fields. In server-authoritative mode the safe fallback is
    // empty, so explicit [] from PostgreSQL remains empty instead of resurrecting
    // legacy course periods/combo components.
    product.periods = [];
    product.components = [];
  }
  return products;
}

if (getBackendConfig().mode === BACKEND_MODES.SUPABASE) {
  removeLegacyCatalogAuthorityFallback(defaultProducts);
}
