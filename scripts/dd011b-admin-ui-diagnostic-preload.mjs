import { chromium } from "playwright";

const previousLaunch = chromium.launch.bind(chromium);

chromium.launch = async (...launchArgs) => {
  const browser = await previousLaunch(...launchArgs);
  const previousNewContext = browser.newContext.bind(browser);

  browser.newContext = async (...contextArgs) => {
    const context = await previousNewContext(...contextArgs);
    const previousAddInitScript = context.addInitScript.bind(context);
    const previousNewPage = context.newPage.bind(context);
    let isAdminFixture = false;
    let domWatchInstalled = false;

    context.addInitScript = async (script, arg) => {
      const mode = String(arg?.mode || arg?.storage?.deedou_workstation_mode || "");
      if (mode === "ADMIN") {
        isAdminFixture = true;
        if (!domWatchInstalled) {
          domWatchInstalled = true;
          await previousAddInitScript(() => {
            const snapshot = () => {
              const app = document.getElementById("app");
              return {
                directChildren: app?.childElementCount || 0,
                authForm: Boolean(document.querySelector("#app [data-auth-login]")),
                adminPage: Boolean(document.querySelector("#app .admin-page")),
                adminMenu: Boolean(document.querySelector("[data-dd008d-admin-menu]")),
                migrationPanel: Boolean(document.querySelector("[data-dd008d-migration-panel]")),
                text: String(app?.innerText || "").replace(/\s+/g, " ").slice(0, 180)
              };
            };
            const install = () => {
              const app = document.getElementById("app");
              if (!app) return;
              let sequence = 0;
              console.info(`[DD011B dom-watch] installed ${JSON.stringify(snapshot())}`);
              new MutationObserver((records) => {
                sequence += 1;
                const directChildList = records.filter((record) => record.type === "childList" && record.target === app).length;
                console.info(`[DD011B dom-watch] mutation=${sequence} records=${records.length} direct=${directChildList} ${JSON.stringify(snapshot())}`);
              }).observe(app, { childList: true, subtree: true });
            };
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", install, { once: true });
            } else {
              queueMicrotask(install);
            }
          });
        }
      }
      return previousAddInitScript(script, arg);
    };

    context.newPage = async (...pageArgs) => {
      const page = await previousNewPage(...pageArgs);
      if (!isAdminFixture) return page;

      await page.route("**/src/shared/backend/admin-ui.js", async (route) => {
        const response = await route.fetch();
        let body = await response.text();
        const replacements = [
          [
            "const appRoot = document.getElementById(\"app\");",
            "const appRoot = document.getElementById(\"app\");\nconsole.info(`[DD011B admin-ui] module-loaded appRoot=${Boolean(appRoot)} route=${location.hash}`);"
          ],
          [
            "  new MutationObserver(() => queueMicrotask(render)).observe(appRoot, { childList: true });",
            "  new MutationObserver((records) => { console.info(`[DD011B admin-ui] observer records=${records.length} directChildren=${appRoot.childElementCount}`); queueMicrotask(render); }).observe(appRoot, { childList: true });"
          ],
          [
            "function render() {\n  const existing = document.querySelector(\"[data-dd008d-admin-menu]\");",
            "function render() {\n  const existing = document.querySelector(\"[data-dd008d-admin-menu]\");\n  console.info(`[DD011B admin-ui] render-enter route=${location.hash} existing=${Boolean(existing)}`);"
          ],
          [
            "  const adminPage = document.querySelector(\"#app .admin-page\") || document.querySelector(\"#app .page\");\n  if (!adminPage || adminPage.querySelector(\"[data-auth-login]\")) {",
            "  const adminPage = document.querySelector(\"#app .admin-page\") || document.querySelector(\"#app .page\");\n  console.info(`[DD011B admin-ui] page-check page=${Boolean(adminPage)} authForm=${Boolean(adminPage?.querySelector(\"[data-auth-login]\"))}`);\n  if (!adminPage || adminPage.querySelector(\"[data-auth-login]\")) {\n    console.info(`[DD011B admin-ui] render-blocked reason=${!adminPage ? \"NO_PAGE\" : \"AUTH_FORM\"}`);"
          ],
          [
            "  if (!existing) adminPage.appendChild(panel);",
            "  if (!existing) { adminPage.appendChild(panel); console.info(`[DD011B admin-ui] panel-appended connected=${panel.isConnected}`); } else { console.info(`[DD011B admin-ui] panel-reused connected=${panel.isConnected}`); }"
          ],
          [
            "  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) queueMicrotask(() => loadMenu());",
            "  console.info(`[DD011B admin-ui] render-complete connected=${panel.isConnected} loaded=${state.loaded} loading=${state.loading}`);\n  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) queueMicrotask(() => loadMenu());"
          ]
        ];
        for (const [needle, replacement] of replacements) {
          if (!body.includes(needle)) console.log(`[DD011B admin-ui-diagnose] injection-missing ${safe(needle.slice(0, 100))}`);
          body = body.replace(needle, replacement);
        }
        await route.fulfill({ response, body });
      });

      page.on("console", (message) => {
        if (message.type() !== "info") return;
        const text = message.text();
        if (text.startsWith("[DD011B admin-ui]") || text.startsWith("[DD011B dom-watch]")) {
          console.log(text);
        }
      });

      return page;
    };

    return context;
  };

  return browser;
};

function safe(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.:@/,-]+/g, "_").slice(0, 220);
}
