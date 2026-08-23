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

    context.addInitScript = async (script, arg) => {
      const mode = String(arg?.mode || arg?.storage?.deedou_workstation_mode || "");
      if (mode === "ADMIN") isAdminFixture = true;
      return originalAddInitScript(script, arg);
    };

    context.newPage = async (...pageArgs) => {
      const page = await originalNewPage(...pageArgs);

      page.on("pageerror", (error) => {
        if (isAdminFixture) console.log(`[DD011B diagnose] ADMIN pageerror ${safe(error?.message)}`);
      });
      page.on("console", (message) => {
        if (isAdminFixture && message.type() === "error") {
          console.log(`[DD011B diagnose] ADMIN console ${safe(message.text())}`);
        }
      });
      page.on("response", async (response) => {
        if (!isAdminFixture) return;
        let pathname = "";
        try { pathname = new URL(response.url()).pathname; } catch { return; }
        if (pathname !== "/api/staff-rpc") return;

        let requestBody = null;
        try { requestBody = response.request().postDataJSON(); } catch { requestBody = null; }
        const functionName = String(requestBody?.functionName || "unknown-rpc");
        if (!["get_my_staff_context", "authorize_staff_access"].includes(functionName)) return;

        let responseBody = null;
        try { responseBody = await response.json(); } catch { responseBody = null; }
        const row = Array.isArray(responseBody) ? responseBody[0] : responseBody;
        console.log(`[DD011B diagnose] ADMIN ${functionName} http=${response.status()} ok=${row?.ok === true} reason=${safe(row?.reason || "")} device=${safe(row?.device_id || "")} mode=${safe(row?.workstation_mode || "")}`);

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
  return String(value || "").replace(/[^A-Za-z0-9_.:@/-]+/g, "_").slice(0, 180);
}
