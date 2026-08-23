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
  const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", timeout: 30_000 }));
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
      await originalAddInitScript(installDD011BDomWatch);

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

function installDD011BDomWatch() {
  if (window.__DD011B_DOM_WATCH_INSTALLED__) return;
  window.__DD011B_DOM_WATCH_INSTALLED__ = true;
  const selectors = {
    app: "#app",
    page: "#app .page",
    adminPage: "#app .admin-page",
    authLogin: "[data-auth-login]",
    adminMenu: "[data-dd008d-admin-menu]",
    migrationPanel: "[data-dd008d-migration-panel]"
  };
  const safe = (value) => String(value || "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer_[REDACTED]")
    .replace(/[^A-Za-z0-9:_.#/?=& -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  const state = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return "missing";
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    return `${visible ? "visible" : "hidden"}:${Math.round(rect.width)}x${Math.round(rect.height)}:${style.display}:${style.visibility}`;
  };
  const summary = () => {
    const authGateText = safe(document.querySelector(".auth-gate")?.innerText || "");
    return [
      `href=${safe(location.href.replace(location.origin, ""))}`,
      `ready=${safe(document.readyState)}`,
      `app=${state(selectors.app)}`,
      `page=${state(selectors.page)}`,
      `adminPage=${state(selectors.adminPage)}`,
      `authLogin=${state(selectors.authLogin)}`,
      `adminMenu=${state(selectors.adminMenu)}`,
      `migrationPanel=${state(selectors.migrationPanel)}`,
      `authGate=${authGateText || "none"}`
    ].join(" ");
  };
  let lastSummary = "";
  const log = (event) => {
    const current = summary();
    if (event !== "heartbeat" || current !== lastSummary) {
      console.log(`[DD011B dom-watch] event=${safe(event)} ${current}`);
      lastSummary = current;
    }
  };
  const matchesInteresting = (node) => {
    if (!node || node.nodeType !== 1) return false;
    return Object.values(selectors).some((selector) => node.matches?.(selector) || node.querySelector?.(selector));
  };
  window.addEventListener("DOMContentLoaded", () => log("domcontentloaded"), { once: true });
  window.addEventListener("load", () => log("load"), { once: true });
  window.addEventListener("hashchange", () => log("hashchange"));
  window.addEventListener("error", (event) => console.log(`[DD011B dom-watch] event=window-error message=${safe(event?.message)}`));
  window.addEventListener("unhandledrejection", (event) => console.log(`[DD011B dom-watch] event=unhandled-rejection message=${safe(event?.reason?.message || event?.reason)}`));
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => (
      matchesInteresting(mutation.target)
      || [...mutation.addedNodes].some(matchesInteresting)
      || [...mutation.removedNodes].some(matchesInteresting)
    ))) log("mutation");
  });
  const observe = () => {
    const root = document.documentElement || document;
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-dd008d-admin-menu", "data-dd008d-migration-panel", "data-auth-login"] });
    log("observer-ready");
  };
  if (document.documentElement) observe();
  else window.addEventListener("DOMContentLoaded", observe, { once: true });
  setInterval(() => log("heartbeat"), 5_000);
}

async function handleApiRequest(request, response, handler) {
  adaptNodeResponse(response);
  request.body = await readJsonBody(request);
  installSafeWorkstationDiagnostics(request, response);
  await attachBackendManagedFixtureSession(request);
  await handler(request, response);
}

async function attachBackendManagedFixtureSession(request) {
  const contextId = readCookie(request, TEST_CONTEXT_COOKIE);
  const fixture = fixtureContexts.get(contextId);
  if (!fixture) return;
  if (readCookie(request, DEVICE_SESSION_COOKIE)) return;

  const caller = await authenticatedCaller(request);
  if (!caller.ok) return;

  const key = `${contextId}:${caller.user.id}`;
  if (!sessionPromises.has(key)) {
    sessionPromises.set(key, createFixtureSession(caller, fixture));
  }
  const token = await sessionPromises.get(key);
  if (!token) return;

  const current = String(request.headers.cookie || "").trim();
  request.headers.cookie = `${current}${current ? "; " : ""}${DEVICE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function createFixtureSession(caller, fixture) {
  // Legacy DD-008 browser fixtures already provision a real registered device in
  // PostgreSQL. Resolve that exact staff/location/device context through the
  // existing authenticated contract; do not duplicate route permission policy in
  // this test bridge. The production /api/staff-rpc handler remains responsible
  // for permission and workstation authorization on each real request.
  const { data, error } = await caller.userClient.rpc("get_my_staff_context", {
    p_location_id: fixture.locationId,
    p_workstation_mode: fixture.workstationMode,
    p_device_credential: fixture.deviceCredential
  });
  const resolved = firstRow(data) || {};
  if (error || !resolved.device_id) {
    fixture.authorizationDenied = !error && !resolved.device_id;
    console.log(`[DD011B smoke] ${safeModeLabel(fixture)} device context unresolved reason=${safeDiagnosticReason(error?.code || error?.message || "NO_DEVICE_CONTEXT")}`);
    return "";
  }

  fixture.authorizationDenied = false;
  console.log(`[DD011B smoke] ${safeModeLabel(fixture)} device context resolved deviceId=yes locationId=${resolved.location_id || resolved.locationId ? "yes" : "no"} workstationMode=${safeDiagnosticReason(resolved.workstation_mode || resolved.workstationMode || fixture.workstationMode) || "none"}`);
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
  console.log(`[DD011B smoke] ${safeModeLabel(fixture)} backend device session created`);
  return token;
}

function installSafeWorkstationDiagnostics(request, response) {
  const fixture = fixtureContexts.get(readCookie(request, TEST_CONTEXT_COOKIE));
  if (!fixture) return;
  const pathname = safePathname(request?.url);
  const action = pathname === "/api/staff-rpc"
    ? String(request.body?.functionName || "unknown-rpc")
    : String(request.body?.action || "status");
  const originalJson = response.json.bind(response);
  response.json = (body) => {
    console.log(`[DD011B smoke] ${safeModeLabel(fixture)} ${pathname} ${safeDiagnosticReason(action)} -> ${response.statusCode || 200} ${formatWorkstationDiagnosticBody(body)}`);
    return originalJson(body);
  };
}

function formatWorkstationDiagnosticBody(body) {
  const shape = Array.isArray(body) ? "array" : body && typeof body === "object" ? "object" : typeof body;
  const row = Array.isArray(body) ? body[0] : body;
  const length = Array.isArray(body) ? body.length : "";
  if (!row || typeof row !== "object") return `shape=${shape}${length === "" ? "" : ` length=${length}`} ok=missing reason=EMPTY`;
  const ok = Object.prototype.hasOwnProperty.call(row, "ok") ? String(row.ok === true) : "missing";
  const reason = safeDiagnosticReason(row.reason || row.message || row.code || "");
  const deviceId = row.device_id || row.deviceId ? "yes" : "no";
  const workstationMode = safeDiagnosticReason(row.workstation_mode || row.workstationMode || "");
  const locationId = row.location_id || row.locationId ? "yes" : "no";
  const parts = [`shape=${shape}`];
  if (length !== "") parts.push(`length=${length}`);
  parts.push(`ok=${ok}`);
  parts.push(`reason=${reason || "none"}`);
  parts.push(`deviceId=${deviceId}`);
  parts.push(`workstationMode=${workstationMode || "none"}`);
  parts.push(`locationId=${locationId}`);
  return parts.join(" ");
}

function safeModeLabel(fixture) {
  return safeDiagnosticReason(fixture?.workstationMode || "UNKNOWN") || "UNKNOWN";
}

function safeDiagnosticReason(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 120);
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
