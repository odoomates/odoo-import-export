/* Odoo Import Export page bridge.
 *
 * Runs in the page's own JS world (injected with world: "MAIN") so it can read the Odoo web
 * client: the model of the current view, its search (the domain of the search bar and the
 * action), the records ticked in a list and the list's columns. The panel lives in the extension's isolated world
 * and asks with DOM events carrying JSON strings (strings cross JS worlds in every browser):
 *
 *   panel  -> "odoo-import-export:req" {id, cmd, ...args}
 *   bridge -> "odoo-import-export:res" {id, ok, result | error}
 *
 * "context" reads the page and changes nothing. "open" opens an action in the web client, as a
 * menu would (no page reload, so the breadcrumb and the search of the view are kept). "reload"
 * reloads the view on screen in place (Odoo's soft_reload: same search, the panel stays open).
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

  /* The columns of the list renderer showing `list`, in screen order: shown (optional columns
   * as the user toggled them) and hidden (optional columns switched off). The renderer keeps
   * them in allColumns, and the shown ones in columns (Odoo 18+) or state.columns (16, 17). */
  function listColumns(renderer) {
    const all = (renderer.allColumns || []).filter((col) => col.type === "field" && col.name && col.widget !== "handle");
    const active = renderer.columns || (renderer.state && renderer.state.columns) || [];
    const on = new Set(active.filter((col) => col.type === "field").map((col) => col.name));
    return {
      shown: all.filter((col) => on.has(col.name)).map((col) => col.name),
      hidden: all.filter((col) => !on.has(col.name) && col.optional).map((col) => col.name),
    };
  }

  // The main view (not a dialog): its model, search domain, list selection and columns.
  function context() {
    let search = null;
    let list = null;
    const renderers = [];
    for (const node of walk()) {
      const c = node.component;
      const env = c && c.env;
      if (!search && env && env.searchModel && env.searchModel.resModel && !env.inDialog) search = env.searchModel;
      const root = c && c.model && c.model.root;
      if (!list && root && Array.isArray(root.selection) && root.resModel && !(env && env.inDialog)) list = root;
      if (c && Array.isArray(c.allColumns) && c.props && c.props.list) renderers.push(c);
    }
    const renderer = list && renderers.find((c) => c.props.list === list);
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
      columns: renderer && list.resModel === model ? listColumns(renderer) : null,
    };
  }

  // The web client's action service (any component's env has it).
  function actionService() {
    for (const node of walk()) {
      const env = node.component && node.component.env;
      if (env && env.services && env.services.action) return env.services.action;
    }
    return null;
  }

  // Open an action (xml id or id) with extra context, e.g. search_default_* filters. Answers once
  // the action started: the view loads on its own.
  function open({ action, context }) {
    const service = actionService();
    if (!service) return false;
    Promise.resolve(service.doAction(action, { additionalContext: context || {}, clearBreadcrumbs: true })).catch(() => null);
    return true;
  }

  // Reload the view on screen with fresh data; false when there is none (or no action service).
  function reload() {
    const service = actionService();
    if (!service || !service.currentController) return false;
    Promise.resolve(service.doAction("soft_reload")).catch(() => null);
    return true;
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
      else if (req.cmd === "reload") res = { id: req.id, ok: true, result: reload() };
      else if (req.cmd === "open") res = { id: req.id, ok: true, result: open(req) };
      else res = { id: req.id, ok: false, error: `Unknown command ${req.cmd}` };
    } catch (e) {
      res = { id: req.id, ok: false, error: String(e && e.message ? e.message : e) };
    }
    document.dispatchEvent(new CustomEvent("odoo-import-export:res", { detail: JSON.stringify(res) }));
  });
})();
