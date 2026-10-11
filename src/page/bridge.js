/* Odoo Import Export page bridge.
 *
 * Runs in the page's own JS world (injected with world: "MAIN") so it can read the Odoo web
 * client: the model of the current view, its search (the domain of the search bar and the
 * action) and the records ticked in a list. The panel lives in the extension's isolated world
 * and asks with DOM events carrying JSON strings (strings cross JS worlds in every browser):
 *
 *   panel  -> "odoo-import-export:req" {id, cmd}
 *   bridge -> "odoo-import-export:res" {id, ok, result | error}
 *
 * Read-only: nothing in the page is changed.
 */
(() => {
  "use strict";

  if (window.__odooImportExportBridge) return;
  window.__odooImportExportBridge = true;

  function owlRoot() {
    const dbg = window.odoo && window.odoo.__WOWL_DEBUG__;
    return dbg && dbg.root && dbg.root.__owl__;
  }

  function childNodes(node) {
    const ch = node && node.children;
    if (!ch) return [];
    return ch instanceof Map ? [...ch.values()] : Object.values(ch);
  }

  function* walk() {
    const root = owlRoot();
    if (!root) return;
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      yield node;
      queue.push(...childNodes(node));
    }
  }

  // Plain JSON copy of a domain (drops anything that isn't data).
  function plain(domain) {
    try {
      return JSON.parse(JSON.stringify(Array.isArray(domain) ? domain : domain && domain.toList ? domain.toList() : []));
    } catch {
      return [];
    }
  }

  // The main view (not a dialog): its model, search domain and list selection.
  function context() {
    let search = null;
    let list = null;
    for (const node of walk()) {
      const c = node.component;
      const env = c && c.env;
      if (!search && env && env.searchModel && env.searchModel.resModel && !env.inDialog) search = env.searchModel;
      const root = c && c.model && c.model.root;
      if (!list && root && Array.isArray(root.selection) && root.resModel && !(env && env.inDialog)) list = root;
      if (search && list) break;
    }
    if (!search && !list) return null;
    const model = (search && search.resModel) || list.resModel;
    const selected = list && list.resModel === model ? list.selection.map((r) => r.resId).filter((id) => Number.isInteger(id)) : [];
    return {
      model,
      domain: search ? plain(search.domain) : [],
      selectedIds: selected,
      // "Select all" ticked across pages: the whole search, not just the visible rows
      domainSelected: !!(list && list.isDomainSelected),
      count: list && Number.isInteger(list.count) ? list.count : null,
    };
  }

  document.addEventListener("odoo-import-export:req", (ev) => {
    let req;
    try {
      req = JSON.parse(ev.detail);
    } catch {
      return;
    }
    let res;
    try {
      if (req.cmd === "context") res = { id: req.id, ok: true, result: context() };
      else res = { id: req.id, ok: false, error: `Unknown command ${req.cmd}` };
    } catch (e) {
      res = { id: req.id, ok: false, error: String(e && e.message ? e.message : e) };
    }
    document.dispatchEvent(new CustomEvent("odoo-import-export:res", { detail: JSON.stringify(res) }));
  });
})();
