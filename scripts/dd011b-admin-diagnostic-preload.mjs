import { chromium } from "playwright";

const originalLaunch = chromium.launch.bind(chromium);

chromium.launch = async (...launchArgs) => {
  const browser = await originalLaunch(...launchArgs);
  const originalNewContext = browser.newContext.bind(browser);

  browser.newContext = async (...contextArgs) => {
    const context = await originalNewContext(...contextArgs);
    const originalAddInitScript = context.addInitScript.bind(context);
    const originalNewPage = context.newPage.bind(context);
    let isAdminFixture = false;
    let authTraceInstalled = false;

    context.addInitScript = async (script, arg) => {
      const mode = String(arg?.mode || arg?.storage?.deedou_workstation_mode || "");
      if (mode === "ADMIN") {
        isAdminFixture = true;
        if (!authTraceInstalled) {
          authTraceInstalled = true;
          await originalAddInitScript(() => {
            let supabaseGlobal;
            const wrap = (value) => {
              if (!value || typeof value.createClient !== "function" || value.__dd011bDiagnoseWrapped) return value;
              const originalCreateClient = value.createClient.bind(value);
              value.createClient = (...args) => {
                const client = originalCreateClient(...args);
                const auth = client?.auth;
                if (auth && typeof auth.onAuthStateChange === "function" && !auth.__dd011bDiagnoseWrapped) {
                  const originalOnAuthStateChange = auth.onAuthStateChange.bind(auth);
                  auth.onAuthStateChange = (callback) => originalOnAuthStateChange((event, session) => {
                    const identity = String(session?.user?.id || session?.user?.email || "").slice(0, 80);
                    console.info(`[DD011B auth-event] ${event} identity=${identity || "none"}`);
                    return callback(event, session);
                  });
                  auth.__dd011bDiagnoseWrapped = true;
                }
                return client;
              };
              value.__dd011bDiagnoseWrapped = true;
              return value;
            };
            try {
              Object.defineProperty(globalThis, "supabase", {
                configurable: true,
                enumerable: true,
                get() { return supabaseGlobal; },
                set(value) { supabaseGlobal = wrap(value); }
              });
            } catch {
              // Diagnostic only; normal smoke behavior must remain unchanged.
            }
          });
        }
      }
      return originalAddInitScript(script, arg);
    };

    context.newPage = async (...pageArgs) => {
      const page = await originalNewPage(...pageArgs);
      const requestStartedAt = new WeakMap();

      if (isAdminFixture) await installAppStateTrace(page);

      page.on("pageerror", (error) => {
        if (isAdminFixture) console.log(`[DD011B diagnose] ADMIN pageerror ${safe(error?.message)}`);
      });
      page.on("console", (message) => {
        if (!isAdminFixture) return;
        if (message.type() === "error") {
          console.log(`[DD011B diagnose] ADMIN console ${safe(message.text())}`);
        } else if (message.type() === "info" && (message.text().startsWith("[DD011B auth-event]") || message.text().startsWith("[DD011B auth-state]"))) {
          console.log(message.text());
        }
      });
      page.on("request", (request) => {
        if (!isAdminFixture) return;
        let pathname = "";
        try { pathname = new URL(request.url()).pathname; } catch { return; }
        if (pathname === "/api/staff-rpc" || pathname === "/api/security") {
          requestStartedAt.set(request, Date.now());
        }
      });
      page.on("response", async (response) => {
        if (!isAdminFixture) return;
        let pathname = "";
        try { pathname = new URL(response.url()).pathname; } catch { return; }
        if (pathname !== "/api/staff-rpc" && pathname !== "/api/security") return;

        const request = response.request();
        const elapsedMs = Math.max(0, Date.now() - (requestStartedAt.get(request) || Date.now()));
        let requestBody = null;
        try { requestBody = request.postDataJSON(); } catch { requestBody = null; }

        if (pathname === "/api/security") {
          console.log(`[DD011B diagnose] ADMIN security action=${safe(requestBody?.action || "status")} http=${response.status()} elapsedMs=${elapsedMs}`);
          return;
        }

        const functionName = String(requestBody?.functionName || "unknown-rpc");
        if (!["get_my_staff_context", "authorize_staff_access"].includes(functionName)) return;

        let responseBody = null;
        try { responseBody = await response.json(); } catch { responseBody = null; }
        const row = Array.isArray(responseBody) ? responseBody[0] : responseBody;
        const params = requestBody?.params && typeof requestBody.params === "object" ? requestBody.params : {};
        const shape = responseBody === null
          ? "null"
          : Array.isArray(responseBody)
            ? `array:${responseBody.length}`
            : typeof responseBody === "object"
              ? `object:${Object.keys(responseBody).sort().join(",")}`
              : typeof responseBody;
        console.log(`[DD011B diagnose] ADMIN ${functionName} http=${response.status()} elapsedMs=${elapsedMs} shape=${safe(shape)} contentType=${safe(response.headers()["content-type"] || "")} location=${safe(params.p_location_id || "")} permission=${safe(params.p_permission_key || "")} requestedMode=${safe(params.p_workstation_mode || "")} ok=${row?.ok === true} reason=${safe(row?.reason || "")} device=${safe(row?.device_id || "")} mode=${safe(row?.workstation_mode || "")}`);

        if (functionName === "authorize_staff_access") {
          await dumpAdminDom(page, "authz-response");
          setTimeout(() => dumpAdminDom(page, "authz-plus-250ms"), 250);
          setTimeout(() => dumpAdminDom(page, "authz-plus-1500ms"), 1500);
        }
      });

      return page;
    };

    return context;
  };

  return browser;
};

async function installAppStateTrace(page) {
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const replacements = [
      [
        "pendingStaffAuthKey = nextKey;\n  staffAuthState = {",
        "console.info(`[DD011B auth-state] refresh-start next=${nextKey} pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status}`);\n  pendingStaffAuthKey = nextKey;\n  staffAuthState = {"
      ],
      [
        "    ]);\n    if (pendingStaffAuthKey !== nextKey) return;\n    staffAuthState = {",
        "    ]);\n    console.info(`[DD011B auth-state] refresh-resolved next=${nextKey} pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status} ok=${authorization?.ok === true} reason=${authorization?.reason || \"\"} contextRows=${Array.isArray(staffContext) ? staffContext.length : -1}`);\n    if (pendingStaffAuthKey !== nextKey) {\n      console.info(`[DD011B auth-state] refresh-discard next=${nextKey} pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0}`);\n      return;\n    }\n    staffAuthState = {"
      ],
      [
        "  } catch (error) {\n    if (pendingStaffAuthKey !== nextKey) return;\n    staffAuthState = {",
        "  } catch (error) {\n    console.info(`[DD011B auth-state] refresh-error next=${nextKey} pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status} error=${error?.message || error || \"UNKNOWN\"}`);\n    if (pendingStaffAuthKey !== nextKey) {\n      console.info(`[DD011B auth-state] refresh-error-discard next=${nextKey} pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0}`);\n      return;\n    }\n    staffAuthState = {"
      ],
      [
        "pendingStaffAuthKey = \"\";\n  render();\n}\n\nfunction syncStaffAuthSession",
        "console.info(`[DD011B auth-state] restore-clear pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status}`);\n  pendingStaffAuthKey = \"\";\n  render();\n}\n\nfunction syncStaffAuthSession"
      ],
      [
        "function syncStaffAuthSession({ session } = {}) {\n  if (backendConfig.mode !== BACKEND_MODES.SUPABASE) return;",
        "function syncStaffAuthSession({ session } = {}) {\n  if (backendConfig.mode !== BACKEND_MODES.SUPABASE) return;\n  console.info(`[DD011B auth-state] sync-enter pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status} session=${session ? \"yes\" : \"no\"}`);"
      ],
      [
        "pendingStaffAuthKey = \"\";\n  render();\n}\n\nfunction supabaseLoadingPage",
        "console.info(`[DD011B auth-state] sync-clear pending=${pendingStaffAuthKey} version=${staffAuthState.authVersion || 0} status=${staffAuthState.status}`);\n  pendingStaffAuthKey = \"\";\n  render();\n}\n\nfunction supabaseLoadingPage"
      ]
    ];
    for (const [needle, replacement] of replacements) {
      if (!body.includes(needle)) console.log(`[DD011B diagnose] app-state injection missing ${safe(needle.slice(0, 80))}`);
      body = body.replace(needle, replacement);
    }
    await route.fulfill({ response, body });
  });
}

async function dumpAdminDom(page, label) {
  try {
    const state = await page.evaluate(() => {
      const authForm = document.querySelector("[data-auth-login]");
      const authGate = document.querySelector("#app .auth-gate");
      const adminPage = document.querySelector("#app .admin-page");
      const adminMenu = document.querySelector("[data-dd008d-admin-menu]");
      return {
        hash: location.hash,
        authForm: Boolean(authForm),
        authGate: Boolean(authGate),
        adminPage: Boolean(adminPage),
        adminMenu: Boolean(adminMenu),
        appText: String(document.querySelector("#app")?.innerText || "").replace(/\s+/g, " ").slice(0, 500)
      };
    });
    console.log(`[DD011B diagnose] ADMIN DOM ${label} ${JSON.stringify(state)}`);
  } catch (error) {
    console.log(`[DD011B diagnose] ADMIN DOM ${label} failed ${safe(error?.message)}`);
  }
}

function safe(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.:@/,-]+/g, "_").slice(0, 220);
}
