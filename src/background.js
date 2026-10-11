/* Odoo Import Export background: injects (or toggles) the import panel in the active
 * tab when the toolbar button or the keyboard shortcut is used. Injection relies
 * on the activeTab permission, so the extension never has standing access to any site.
 */
const api = globalThis.browser || globalThis.chrome;

// Into the page's own JS world: reads the current view (model, search, ticked records).
const PAGE_FILES = ["src/page/bridge.js"];

const FILES = [
  "src/shared/text.js",
  "src/shared/rpc.js",
  "src/shared/errors.js",
  "src/shared/csv.js",
  "src/shared/xlsx.js",
  "src/shared/sheet.js",
  "src/shared/profile.js",
  "src/shared/synonyms.js",
  "src/shared/schema.js",
  "src/shared/columns.js",
  "src/shared/values.js",
  "src/shared/m2o.js",
  "src/shared/records.js",
  "src/shared/plan.js",
  "src/shared/execute.js",
  "src/shared/xlsxwriter.js",
  "src/shared/domain.js",
  "src/shared/analyze.js",
  "src/shared/chart.js",
  "src/shared/export.js",
  "src/shared/template.js",
  "src/shared/sample.js",
  "src/shared/pipeline.js",
  "src/content/panel-css.js",
  "src/content/odoo-import.js",
];

async function toggle(tab) {
  if (!tab || tab.id === undefined) return;
  try {
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: PAGE_FILES, world: "MAIN" });
    } catch {
      // Without the bridge the panel still works; it just can't start from the list on screen.
    }
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    api.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (e) {
    // chrome://, about:, the web stores, PDF viewers... can't be scripted.
    api.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#c0392b" });
    api.action.setBadgeText({ tabId: tab.id, text: "!" });
    api.action.setTitle({ tabId: tab.id, title: `Odoo Import Export can't run on this page: ${e && e.message ? e.message : e}` });
  }
}

api.action.onClicked.addListener(toggle);

// First install: a short page on how to start (not on updates).
api.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") api.tabs.create({ url: api.runtime.getURL("src/welcome/welcome.html") });
});
