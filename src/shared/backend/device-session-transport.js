export const LEGACY_DEVICE_CREDENTIAL_KEY = "deedou_device_credential";
const STAFF_EMAIL_DOMAIN = "staff.deedou.invalid";

export function normalizeStaffUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function loginEmailForIdentifier(value) {
  const identifier = String(value || "").trim();
  if (identifier.includes("@")) return identifier;
  const username = normalizeStaffUsername(identifier);
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(username) ? `${username}@${STAFF_EMAIL_DOMAIN}` : identifier;
}

export function shouldProxyStaffRpc(url, params) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (!/\/rest\/v1\/rpc\/[a-z0-9_]+$/i.test(parsed.pathname)) return false;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  return Object.prototype.hasOwnProperty.call(params, "p_device_credential")
    || Object.prototype.hasOwnProperty.call(params, "p_current_device_credential");
}

export function rpcFunctionName(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) || "");
  } catch {
    return "";
  }
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function removeLegacyCredential() {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      storage?.removeItem?.(LEGACY_DEVICE_CREDENTIAL_KEY);
    } catch {
      // Storage may be unavailable in privacy/sandbox contexts.
    }
  }
}

export function installDeviceSessionTransport(options = {}) {
  const nativeFetch = options.fetch || globalThis.fetch;
  const origin = options.origin || globalThis.location?.origin || "";
  if (typeof nativeFetch !== "function" || !origin) return () => {};
  if (globalThis.__DEEDOU_DD011B_FETCH_INSTALLED__) return () => {};

  removeLegacyCredential();
  const boundFetch = nativeFetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "password") {
      const bodyText = await request.clone().text();
      const payload = parseJson(bodyText);
      if (payload && typeof payload.email === "string" && !payload.email.includes("@")) {
        payload.email = loginEmailForIdentifier(payload.email);
        const headers = new Headers(request.headers);
        headers.set("content-type", "application/json");
        return boundFetch(new Request(request, { body: JSON.stringify(payload), headers }));
      }
    }

    if (request.method === "POST" && /\/rest\/v1\/rpc\/[a-z0-9_]+$/i.test(url.pathname)) {
      const bodyText = await request.clone().text();
      const params = parseJson(bodyText);
      if (shouldProxyStaffRpc(request.url, params)) {
        const authorization = request.headers.get("authorization") || "";
        return boundFetch(new URL("/api/staff-rpc", origin), {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            authorization
          },
          body: JSON.stringify({ functionName: rpcFunctionName(request.url), params })
        });
      }
    }

    return boundFetch(request);
  };

  globalThis.__DEEDOU_DD011B_FETCH_INSTALLED__ = true;
  return () => {
    globalThis.fetch = nativeFetch;
    delete globalThis.__DEEDOU_DD011B_FETCH_INSTALLED__;
  };
}

if (typeof window !== "undefined") {
  installDeviceSessionTransport();
}
