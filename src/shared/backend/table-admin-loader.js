let loadStarted = false;

window.addEventListener("hashchange", () => queueMicrotask(maybeLoadTableAdminUi));

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(maybeLoadTableAdminUi)).observe(appRoot, { childList: true, subtree: true });
}

queueMicrotask(maybeLoadTableAdminUi);

function maybeLoadTableAdminUi() {
  if (loadStarted || !isAdminRoute()) return;
  const adminPage = document.querySelector("#app .admin-page");
  if (!adminPage || adminPage.querySelector(".auth-gate")) return;

  loadStarted = true;
  import("./table-admin-ui.js").catch(() => {
    loadStarted = false;
  });
}

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}
