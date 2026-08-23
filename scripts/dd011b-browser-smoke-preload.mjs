import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";

import { chromium } from "playwright";

import securityHandler from "../api/security.js";
import securityAdminHandler from "../api/security-admin.js";
import staffRpcHandler from "../api/staff-rpc.js";
import {
  DEVICE_SESSION_COOKIE,
  authenticatedCaller,
  firstRow,
  sha256
} from "../api/_dd011b.js";

const TEST_CONTEXT_COOKIE = "dd011b_browser_smoke_context";
const apiHandlers = new Map([
  ["/api/security", securityHandler],
  ["/api/security-admin", securityAdminHandler],
  ["/api/staff-rpc", staffRpcHandler]
]);
const fixtureContexts = new Map();
const sessionPromises = new Map();

configureLocalSupabaseEnv();
installLocalApiInterceptor();
installPlaywrightFixtureBridge();

function configureLocalSupabaseEnv() {
  const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
  const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
  const publishableKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY || "";
  const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!publishableKey || !serviceRoleKey) throw new Error("DD-011B browser smoke preload could not resolve local Supabase keys");
  process.env.DEEDOU_SUPABASE_URL = apiUrl;
  process.env.DEEDOU_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  process.env.DEEDOU_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
}

function installLocalApiInterceptor() {
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(event, ...args) {
    if (event === "request") {
      const [request, response] = args;
      const pathname = safePathname(request?.url);
      const handler = apiHandlers.get(pathname);
      if (handler) {
        handleApiRequest(request, response, handler).catch((error) => {
          if (response.writableEnded) return;
          response.statusCode = 500;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ ok: false, reason: "LOCAL_API_TEST_ADAPTER_FAILED", detail: String(error?.message || error) }));
        });
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}

function installPlaywrightFixtureBridge() {
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await originalLaunch(...args);
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...contextArgs) => {
      const context = await originalNewContext(...contextArgs);
      const originalAddInitScript = context.addInitScript.bind(context);
      const originalNewPage = context.newPage.bind(context);

      context.addInitScript = async (script, arg) => {
        const fixture = extractLegacyFixture(arg);
        if (!fixture) return originalAddInitScript(script, arg);

        const contextId = randomBytes(18).toString("base64url");
        fixtureContexts.set(contextId, fixture);
        context.__dd011bFixture = fixture;
        await context.addCookies([{
          name: TEST_CONTEXT_COOKIE,
          value: contextId,
          domain: "127.0.0.1",
          path: "/api",
          httpOnly: true,
          secure: false,
          sameSite: "Strict"
        }]);
        return originalAddInitScript(script, sanitizeLegacyFixtureArg(arg));
      };

      context.newPage = async (...pageArgs) => {
        const page = await originalNewPage(...pageArgs);
        const originalOn = page.on.bind(page);
        page.on = (event, listener) => {
          if (event !== "console") return originalOn(event, listener);
          return originalOn(event, (message) => {
            if (context.__dd011bFixture?.authorizationDenied === true && isIntentionalAuthorizationDenialConsole(message)) return;
            listener(message);
          });
        };
        return page;
      };

      return context;
    };
    return browser;
  };
}

async function handleApiRequest(request, response, handler) {
  adaptNodeResponse(response);
  request.body = await readJsonBody(request);
  await attachBackendManagedFixtureSession(request);
  await handler(request, response);
}

async function attachBackendManagedFixtureSession(request) {
  const contextId = readCookie(request, TEST_CONTEXT_COOKIE);
  const fixture = fixtureContexts.get(contextId);
  if (!fixture) return;
  if (readCookie(request, DEVICE_SESSION_COOKIE)) return;

  const permission = requestedAuthorizationPermission(request);
  if (!permission) return;

  const caller = await authenticatedCaller(request);
  if (!caller.ok) return;

  const key = `${contextId}:${caller.user.id}`;
  if (!sessionPromises.has(key)) {
    sessionPromises.set(key, createFixtureSession(caller, fixture, permission));
  }
  const token = await sessionPromises.get(key);
  if (!token) return;

  const current = String(request.headers.cookie || "").trim();
  request.headers.cookie = `${current}${current ? "; " : ""}${DEVICE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function createFixtureSession(caller, fixture, permission) {
  const { data, error } = await caller.userClient.rpc("authorize_staff_access", {
    p_location_id: fixture.locationId,
    p_permission_key: permission,
    p_workstation_mode: fixture.workstationMode,
    p_device_credential: fixture.deviceCredential
  });
  const resolved = firstRow(data) || {};
  if (error || resolved.ok !== true || !resolved.device_id) {
    fixture.authorizationDenied = !error && resolved.ok === false;
    return "";
  }

  fixture.authorizationDenied = false;
  const { error: secretError } = await caller.serviceClient
    .from("workstation_device_secrets")
    .upsert({
      device_id: resolved.device_id,
      credential: fixture.deviceCredential,
      rotated_at: null
    }, { onConflict: "device_id" });
  if (secretError) throw new Error(`fixture device secret upsert failed: ${secretError.message}`);

  const token = randomBytes(32).toString("base64url");
  const { error: sessionError } = await caller.serviceClient
    .from("workstation_device_sessions")
    .insert({
      device_id: resolved.device_id,
      auth_user_id: caller.user.id,
      session_token_hash: sha256(token),
      active: true,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    });
  if (sessionError) throw new Error(`fixture device session insert failed: ${sessionError.message}`);
  return token;
}

function requestedAuthorizationPermission(request) {
  const body = request?.body;
  if (!body || body.functionName !== "authorize_staff_access") return "";
  const params = body.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  return String(params.p_permission_key || "").trim();
}

function isIntentionalAuthorizationDenialConsole(message) {
  if (message?.type?.() !== "error") return false;
  if (message.text?.() !== "Failed to load resource: the server responded with a status of 403 (Forbidden)") return false;
  const locationUrl = String(message.location?.()?.url || "");
  return !locationUrl || safePathname(locationUrl) === "/api/staff-rpc";
}

function extractLegacyFixture(arg) {
  if (arg?.storage && Object.prototype.hasOwnProperty.call(arg.storage, "deedou_device_credential")) {
    const deviceCredential = String(arg.storage.deedou_device_credential || "");
    if (!deviceCredential) return null;
    return {
      deviceCredential,
      workstationMode: String(arg.storage.deedou_workstation_mode || ""),
      locationId: String(arg.storage.deedou_staff_location_id || "deedou-demo"),
      authorizationDenied: false
    };
  }
  if (arg && Object.prototype.hasOwnProperty.call(arg, "deviceSecret")) {
    const deviceCredential = String(arg.deviceSecret || "");
    if (!deviceCredential) return null;
    return {
      deviceCredential,
      workstationMode: String(arg.mode || ""),
      locationId: "deedou-demo",
      authorizationDenied: false
    };
  }
  return null;
}

function sanitizeLegacyFixtureArg(arg) {
  if (arg?.storage && Object.prototype.hasOwnProperty.call(arg.storage, "deedou_device_credential")) {
    return { ...arg, storage: { ...arg.storage, deedou_device_credential: "" } };
  }
  if (arg && Object.prototype.hasOwnProperty.call(arg, "deviceSecret")) {
    return { ...arg, deviceSecret: "" };
  }
  return arg;
}

function adaptNodeResponse(response) {
  if (typeof response.status !== "function") {
    response.status = (statusCode) => {
      response.statusCode = Number(statusCode) || 200;
      return response;
    };
  }
  if (typeof response.json !== "function") {
    response.json = (body) => {
      if (!response.hasHeader("content-type")) response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(body));
      return response;
    };
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function readCookie(request, name) {
  const raw = String(request?.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function safePathname(value) {
  try {
    return new URL(String(value || "/"), "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function parseEnvOutput(output) {
  return String(output || "").split(/\r?\n/).reduce((acc, line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return acc;
    acc[match[1]] = match[2].replace(/^"|"$/g, "");
    return acc;
  }, {});
}
