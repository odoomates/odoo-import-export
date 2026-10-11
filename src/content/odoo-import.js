/* Odoo Import Export: the import panel.
 *
 * Injected on demand (toolbar button / shortcut) into the active tab. Draws the panel in
 * a closed shadow root and talks to Odoo through the page's own session. Running it
 * again toggles the panel; its state (file, mapping, decisions) is kept meanwhile.
 *
 * Steps: File -> Columns -> Review -> Import. The engine lives in src/shared/.
 */
(() => {
  "use strict";

  if (globalThis.__odooImport) {
    globalThis.__odooImport.toggle();
    return;
  }

  const api = globalThis.browser || globalThis.chrome;
  const OI = globalThis.OdooImport;
  const { norm } = OI.text;
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  const STEPS = [
    ["source", "File"],
    ["map", "Columns"],
    ["review", "Review"],
    ["import", "Import"],
  ];
  const HISTORY_MAX = 30;
  const PREVIEW_ROWS = 200;
  const K = { settings: "oi.settings", history: "oi.history", memory: (origin, db) => `oi.memory.${origin}|${db}`, versionOk: "oi.versionOk" };

  // ---------------------------------------------------------------------------
  // storage helpers (never let a storage failure break the panel)
  const store = {
    async get(key, fallback) {
      try {
        const out = await api.storage.local.get(key);
        return out[key] === undefined ? fallback : out[key];
      } catch {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        await api.storage.local.set({ [key]: value });
      } catch {
        /* ignore */
      }
    },
  };

  // ---------------------------------------------------------------------------
  // state
  const S = {
    settings: { batchSize: 500, fast: false },
    expanded: new Set(), // conflict groups unfolded by the user
    groupLimit: new Map(), // group key -> cards drawn (more on demand)
    visible: [], // conflict cards on screen, in order (keyboard navigation)
    client: OI.rpc.createClient(),
    deps: null,
    session: null,
    step: "source",
    model: null,
    modelName: "",
    models: null,
    book: null, // {name, kind, sheets, sheet, rows, header}
    job: null,
    analysis: null,
    busy: "",
    focus: 0,
    reviewTab: "conflicts",
    result: null, // last run result
    check: null, // last dry run result
    progress: null,
    op: null, // the long operation in progress: {kind, ctrl}
    history: [],
    mode: "import", // "export", "analyze"
    filters: [], // conditions on the current model (Export and Analyze)
    page: null, // what the Odoo page shows: {model, domain, selectedIds, domainSelected} (page bridge)
    scope: "all", // Export/Analyze records: "all" | "search" (the list's search) | "selected"
    an: { model: null, groupby: null, split: null, measure: { agg: "count" }, top: 10, chart: "auto", compare: "none", archived: false, result: null, count: null, saved: [], measures: [] },
    exp: { purpose: null, columns: [], format: "xlsx", archived: false, count: null, hasActive: false, done: null, model: null },
  };

  // ---------------------------------------------------------------------------
  // DOM
  const host = document.createElement("odoo-import-root");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646; top: 0; left: 0; width: 0; height: 0;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = globalThis.ODOO_IMPORT_CSS || "";
  shadow.append(style);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const backdrop = h("div", { class: "backdrop", onclick: () => hide() });
  const conn = h("span", { class: "conn" }, h("span", { class: "dot" }), h("span", { class: "conn-text" }, "Connecting…"));
  const stepNav = h("nav", { class: "steps", "aria-label": "Steps" });
  const body = h("main", { class: "body", tabindex: "-1" });
  const status = h("span", { class: "status", role: "status", "aria-live": "polite" });
  const backBtn = h("button", { type: "button", class: "btn ghost", onclick: () => back() }, "← Back");
  const nextBtn = h("button", { type: "button", class: "btn primary", onclick: () => next() }, "Next →");
  const toastEl = h("div", { class: "toast", role: "status" });
  const historySheet = h("section", { class: "sheet", hidden: true });
  const modeSwitch = h("div", { class: "modes", role: "tablist", "aria-label": "Mode" },
    h("button", { type: "button", role: "tab", "data-mode": "import", onclick: () => setMode("import") }, "Import"),
    h("button", { type: "button", role: "tab", "data-mode": "export", onclick: () => setMode("export") }, "Export"),
    h("button", { type: "button", role: "tab", "data-mode": "analyze", onclick: () => setMode("analyze") }, "Analyze"));
  const cancelBtn = h("button", { type: "button", class: "btn small", hidden: true, onclick: () => cancelTask() }, "Cancel");
  let discardArmed = null;
  const discardBtn = h("button", { type: "button", class: "icon-btn", hidden: true, onclick: () => {
    if (S.result || !S.job) return discard(); // nothing to lose: no confirmation
    if (discardArmed) {
      clearTimeout(discardArmed);
      discardArmed = null;
      return discard();
    }
    discardBtn.textContent = "Discard everything? Click again";
    discardBtn.classList.add("armed");
    discardArmed = setTimeout(() => {
      discardArmed = null;
      renderFooter();
    }, 4000);
  } });
  const panel = h(
    "div",
    { class: "panel", role: "dialog", "aria-label": "Odoo Import Export" },
    h(
      "header",
      null,
      h("span", { class: "logo" }, "Odoo ", h("b", null, "Import Export")),
      modeSwitch,
      conn,
      h("span", { class: "spacer" }),
      discardBtn,
      h("button", { type: "button", class: "icon-btn", title: "Past imports and undo", onclick: () => openHistory() }, "History"),
      h("button", { type: "button", class: "icon-btn big", title: "Close (Alt+Shift+I reopens it; your work is kept)", "aria-label": "Close", onclick: () => hide() }, "×"),
    ),
    stepNav,
    body,
    h("footer", null, status, cancelBtn, h("span", { class: "spacer" }), backBtn, nextBtn),
    historySheet,
    toastEl,
  );
  shadow.append(backdrop, panel);

  // Keep the host page (and Odoo's hotkeys) from reacting to keys typed in the panel.
  for (const type of ["keydown", "keyup", "keypress", "input", "paste"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    // Follow Odoo's own dark mode when it is on (color_scheme cookie), else the system.
    const odooDark = /(?:^|;\s*)color_scheme=dark/.test(document.cookie);
    host.setAttribute("data-theme", odooDark || darkQuery.matches ? "dark" : "light");
  }
  darkQuery.addEventListener("change", applyTheme);

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function setBusy(text) {
    S.busy = text || "";
    renderFooter();
  }

  // One long operation at a time (reading, matching, lookups, check, import). Cancel aborts
  // it; requests in flight are aborted too, except during the real import (see cancelTask).
  async function task(kind, label, fn, { abortRequests = true } = {}) {
    if (S.op) return;
    const op = { kind, ctrl: new AbortController() };
    // Everything the operation calls goes through its own client and signal.
    const client = S.client.bind(abortRequests ? op.ctrl.signal : null);
    op.client = client;
    op.deps = {
      ...OI.pipeline.makeDeps(client, MEMORY, { schemas: S.deps.schemas }),
      signal: op.ctrl.signal,
      onProgress: (text) => alive(op) && setBusy(text),
    };
    S.op = op;
    setBusy(label);
    try {
      await fn(op);
    } catch (e) {
      if (S.op === op && !(e && e.aborted)) fail(e);
    } finally {
      if (S.op === op) {
        endTask();
        setBusy("");
      }
    }
  }

  function endTask() {
    S.op = null;
    // The analysis asked for while something else ran (see runAnalysis).
    if (S.an && S.an.rerun && S.mode === "analyze") setTimeout(() => runAnalysis());
  }

  // Still the current operation? (After every await: a cancelled one must not touch the state.)
  const alive = (op) => S.op === op && !op.ctrl.signal.aborted;

  function cancelTask() {
    const op = S.op;
    if (!op) return;
    op.ctrl.abort();
    // The real import stops after the batch being saved, so its ids are kept for undo.
    if (op.kind === "import") return renderFooter();
    endTask();
    S.progress = null;
    // A lookup stopped half-way leaves partial matches: they must be looked up again.
    if (op.kind === "lookup") {
      S.analysis = null;
      if (S.step === "review" || S.step === "import") S.step = "map";
    }
    S.busy = "";
    toast("Cancelled");
    render();
  }

  // Throw the current file, mapping and decisions away and start again (the model stays).
  function discard() {
    if (S.op && S.op.kind === "import") return;
    const finished = !!S.result;
    if (S.op) {
      S.op.ctrl.abort();
      endTask();
    }
    Object.assign(S, { book: null, job: null, analysis: null, check: null, result: null, progress: null, busy: "", reviewTab: "conflicts", focus: 0, expanded: new Set(), groupLimit: new Map() });
    S.step = "source";
    toast(finished ? "Ready for a new import" : "Discarded");
    render();
  }

  function fail(e) {
    S.busy = "";
    const raw = e && e.title ? `${e.title}: ${e.message}` : String(e && e.message ? e.message : e);
    const x = OI.errors.explain(raw);
    const msg = x.hint ? `${x.title}. ${x.hint}` : x.title;
    renderFooter(msg, true);
    status.title = raw;
    return msg;
  }

  // ---------------------------------------------------------------------------
  // connection, model detection
  function setConn(kind, text, title) {
    conn.className = `conn ${kind}`;
    conn.querySelector(".conn-text").textContent = text;
    conn.title = title || text;
  }

  async function connect() {
    setConn("", "Connecting…");
    try {
      const info = await S.client.connect();
      S.session = info;
      S.version = OI.rpc.version(info);
      if (S.version.support !== "yes") {
        // Unsupported version: say so, and let the user decide (remembered per database and version).
        const ok = await store.get(K.versionOk, []);
        S.versionWarning = !ok.includes(`${location.origin}|${info.db}|${S.version.label}`);
      }
      const version = info.server_version || (info.server_version_info || []).slice(0, 2).join(".");
      setConn("ok", `${info.db} · ${info.username || info.name}${version ? ` · ${version}` : ""}`,
        `Database: ${info.db}\nUser: ${info.name} (${info.username})\nOdoo ${version}\n${location.origin}\nEverything runs with your access rights.`);
      S.deps = OI.pipeline.makeDeps(S.client, MEMORY);
      loadModels();
      if (!S.model) {
        const model = await detectModel().catch(() => null);
        if (model && !S.model) await setModel(model);
      }
      render();
    } catch (e) {
      setConn("err", e.title === "Network error" || /^HTTP/.test(e.title || "") ? "Not an Odoo page?" : e.title || "Error", `${e.title}: ${e.message}`);
      render();
    }
  }

  async function loadModels() {
    try {
      const rows = await S.client.call("ir.model", "search_read", [[["transient", "=", false]], ["model", "name"]], { order: "name" });
      S.models = rows.filter((r) => !/^(ir\.|base_import\.|bus\.|mail\.(message|followers|notification|tracking))/.test(r.model) || r.model === "ir.attachment");
      if (S.step === "source") renderBodyKeepFocus();
    } catch {
      S.models = [];
    }
  }

  // What the Odoo page shows (page bridge in the page's own JS world); null without the bridge.
  let bridgeSeq = 0;
  function pageContext() {
    return new Promise((resolve) => {
      const id = ++bridgeSeq;
      const done = (value) => {
        document.removeEventListener("odoo-import-export:res", onRes);
        clearTimeout(timer);
        resolve(value);
      };
      const onRes = (ev) => {
        let res;
        try {
          res = JSON.parse(ev.detail);
        } catch {
          return;
        }
        if (res.id === id) done(res.ok ? res.result : null);
      };
      const timer = setTimeout(() => done(null), 400); // no bridge (or no Odoo web client)
      document.addEventListener("odoo-import-export:res", onRes);
      document.dispatchEvent(new CustomEvent("odoo-import-export:req", { detail: JSON.stringify({ id, cmd: "context" }) }));
    });
  }

  // Read the page again; start Export/Analyze from what it shows (ticked records, else its search).
  // Returns whether anything changed.
  async function refreshPage() {
    const before = JSON.stringify([S.page, S.scope]);
    S.page = await pageContext();
    const p = S.page;
    if (p && p.model === S.model) S.scope = p.selectedIds.length && !p.domainSelected ? "selected" : p.domain.length ? "search" : "all";
    else S.scope = "all";
    return JSON.stringify([S.page, S.scope]) !== before;
  }

  const pageScope = () => (S.page && S.page.model === S.model ? S.page : null);

  // The model of the page the user is on: /odoo/<path>, /odoo/action-<id|xmlid>, /odoo/<model>, #model=.
  async function detectModel() {
    const page = await pageContext();
    if (page && page.model) return page.model;
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("model")) return hash.get("model");
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "odoo") return null;
    for (let i = parts.length - 1; i >= 1; i--) {
      const p = decodeURIComponent(parts[i]);
      if (/^\d+$/.test(p) || p === "new") continue;
      if (p.startsWith("action-")) {
        const ref = p.slice(7);
        let id = /^\d+$/.test(ref) ? Number(ref) : null;
        if (!id && ref.includes(".")) {
          const [module, name] = [ref.slice(0, ref.indexOf(".")), ref.slice(ref.indexOf(".") + 1)];
          const rows = await S.client.call("ir.model.data", "search_read", [[["module", "=", module], ["name", "=", name]], ["res_id"]]);
          id = rows.length ? rows[0].res_id : null;
        }
        if (!id) return null;
        const act = await S.client.call("ir.actions.act_window", "search_read", [[["id", "=", id]], ["res_model"]]);
        return act.length ? act[0].res_model : null;
      }
      if (p.startsWith("m-")) return p.slice(2);
      if (p.includes(".")) return p;
      const act = await S.client.call("ir.actions.act_window", "search_read", [[["path", "=", p]], ["res_model"]], { limit: 1 }).catch(() => []);
      if (act.length) return act[0].res_model;
    }
    return null;
  }

  async function setModel(model) {
    if (!model) return;
    try {
      const rows = await S.client.call("ir.model", "search_read", [[["model", "=", model]], ["model", "name"]]);
      if (!rows.length) throw new Error(`Unknown model ${model}`);
      if (S.model !== model) S.filters = [];
      S.model = model;
      S.modelName = rows[0].name;
      if (S.mode === "export") prepareExport();
      if (S.mode === "analyze") prepareAnalyze();
      S.job = null;
      S.analysis = null;
      S.check = null;
      S.result = null;
      render();
    } catch (e) {
      fail(e);
    }
  }

  const MEMORY = {
    headers: async (model) => new Map(Object.entries((await memory()).headers[model] || {})),
    values: async (relation) => new Map(Object.entries((await memory()).values[relation] || {}).map(([k, v]) => [k, Number(v)])),
  };

  // ---------------------------------------------------------------------------
  // memory (per database): header -> field path, value -> record id
  let memoryCache = null;
  async function memory() {
    if (!S.session) return { headers: {}, values: {} };
    if (!memoryCache) memoryCache = await store.get(K.memory(location.origin, S.session.db), { headers: {}, values: {} });
    return memoryCache;
  }

  async function remember(job, result) {
    const mem = await memory();
    const heads = (mem.headers[job.model] = mem.headers[job.model] || {});
    for (const m of OI.plan.active(job)) heads[norm(job.table.headers[m.col])] = m.path;
    for (const m of job.mapping) if (m.status === "ignored") delete heads[norm(job.table.headers[m.col])];
    const created = new Map((result.createdRecords || []).map((c) => [`${c.relation}\u0000${lower(c.name)}`, c.id]));
    for (const [key, d] of job.decisions) {
      if (!key.startsWith("m2o:")) continue;
      const [, col, value] = key.match(/^m2o:(\d+):(.*)$/) || [];
      const rel = job.rel.get(Number(col));
      if (!rel) continue;
      let id = null;
      if (d.action === "pick") id = d.id;
      else if (d.action === "create") id = created.get(`${rel.field.relation}\u0000${lower(d.value)}`);
      if (!id) continue;
      const vals = (mem.values[rel.field.relation] = mem.values[rel.field.relation] || {});
      vals[value] = id;
    }
    await store.set(K.memory(location.origin, S.session.db), mem);
  }

  // ---------------------------------------------------------------------------
  // navigation
  function stepIndex(step) {
    return STEPS.findIndex(([k]) => k === step);
  }

  function canEnter(step) {
    if (step === "source") return true;
    if (step === "map") return !!S.job;
    if (step === "review" || step === "import") return !!S.analysis;
    return false;
  }

  function go(step) {
    if (!canEnter(step)) return;
    S.step = step;
    S.focus = 0;
    render();
    body.scrollTop = 0;
  }

  function back() {
    const i = stepIndex(S.step);
    if (i > 0) go(STEPS[i - 1][0]);
  }

  async function next() {
    if (S.busy) return;
    if (S.mode === "export") return runExport();
    if (S.mode === "analyze") return;
    try {
      if (S.step === "source") await prepareJob();
      else if (S.step === "map") await resolveJob();
      else if (S.step === "review") go("import");
      else if (S.step === "import") await runImport(false);
    } catch (e) {
      fail(e);
    }
  }

  // ---------------------------------------------------------------------------
  // step 1: file
  function loadBuffer(name, buffer) {
    return task("read", "Reading the file…", async (op) => {
      const book = await OI.sheet.readFile(name, buffer);
      if (alive(op)) await openBook({ name, ...book }, 0, op);
    });
  }

  async function openBook(book, sheet = 0, op = null) {
    const rows = await book.sheets[sheet].load();
    if (op && !alive(op)) return;
    const header = OI.sheet.detectHeader(rows);
    S.book = { ...book, sheet, rows, header };
    S.job = null;
    S.analysis = null;
    S.check = null;
    S.result = null;
    if (!op) setBusy("");
    render();
  }

  function currentTable() {
    if (!S.book) return null;
    return OI.sheet.buildTable(S.book.rows, S.book.header);
  }

  async function prepareJob() {
    if (!S.model) throw new Error("Choose the model to import into first.");
    const table = currentTable();
    if (!table || !table.rows.length) throw new Error("The file has no data rows.");
    const lang = (S.session.user_context && S.session.user_context.lang) || "en_US";
    // en_US reads 03/04 as month/day; most other languages day/month.
    const dateOrder = /^en_(US|PH|CA)$/.test(lang) ? "MDY" : "DMY";
    await task("prepare", "Matching columns to fields…", async (op) => {
      const job = await OI.pipeline.prepare(op.deps, S.model, table, { dateOrder });
      if (!alive(op)) return;
      S.job = job;
      S.job.file = S.book.name;
      S.analysis = null;
      endTask();
      setBusy("");
      go("map");
    });
  }

  function renderSource() {
    const wrap = h("div");
    wrap.append(h("div", { class: "field-row" }, h("label", null, "Import into"), modelPicker()));

    if (!S.book) {
      const input = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx,.xlsm,.ods,text/csv", hidden: true, onchange: async () => {
        const f = input.files[0];
        if (f) await loadBuffer(f.name, await f.arrayBuffer());
      } });
      const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Choose a file to import",
        onclick: () => input.click(),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } },
        ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
        ondragleave: () => drop.classList.remove("over"),
        ondrop: async (e) => {
          e.preventDefault();
          drop.classList.remove("over");
          const f = e.dataTransfer.files[0];
          if (f) await loadBuffer(f.name, await f.arrayBuffer());
        },
      },
      h("div", { class: "big" }, "Drop a spreadsheet here, or click to choose one"),
      h("div", null, "…or copy cells in Excel / Google Sheets and press ", h("kbd", null, "Ctrl"), "+", h("kbd", null, "V"), " here"),
      h("div", { class: "formats muted" }, "CSV, TSV, XLSX, ODS · the file never leaves your browser except to your Odoo"));
      wrap.append(drop, input);
      const paste = h("textarea", { class: "paste", placeholder: "Or paste rows here (the first row can be the headers)", spellcheck: "false",
        oninput: () => {
          clearTimeout(paste._t);
          paste._t = setTimeout(() => paste.value.trim() && openBook({ name: "Pasted data", ...OI.sheet.readPaste(paste.value) }), 400);
        } });
      wrap.append(paste);
      if (S.model && S.session) wrap.append(templateRow());
      return wrap;
    }

    const table = currentTable();
    const info = h("div", { class: "file-info" },
      h("span", { class: "name" }, S.book.name),
      S.book.sheets.length > 1
        ? h("select", { "aria-label": "Sheet", onchange: (e) => openBook(S.book, Number(e.target.value)) },
          S.book.sheets.map((s, i) => h("option", { value: i, selected: i === S.book.sheet }, s.name)))
        : null,
      h("label", { class: "row small" }, h("input", { type: "checkbox", checked: S.book.header >= 0, onchange: (e) => {
        S.book.header = e.target.checked ? Math.max(0, OI.sheet.detectHeader(S.book.rows)) : -1;
        S.job = null;
        render();
      } }), "First row has the column names"),
      h("span", { class: "muted small" }, `${table.rows.length} rows · ${table.headers.length} columns${S.book.encoding && S.book.encoding !== "utf-8" ? ` · ${S.book.encoding}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn small", onclick: () => { S.book = null; S.job = null; S.analysis = null; render(); } }, "Choose another file"));
    wrap.append(info, previewTable(table.headers, table.rows.slice(0, 8), table.lines));
    return wrap;
  }

  // "Not sure which columns?" -> a template for the model (and Odoo's own, when it ships one).
  const odooTemplates = new Map();
  function templateRow() {
    const model = S.model;
    if (!odooTemplates.has(model)) {
      odooTemplates.set(model, []);
      S.client.call(model, "get_import_templates", []).then((t) => {
        odooTemplates.set(model, (t || []).map((x) => ({ label: x.label, url: x.template })));
        if (S.model === model && S.step === "source" && !S.book) renderBodyKeepFocus();
      }).catch(() => {});
    }
    return h("div", { class: "row template-row" },
      h("span", { class: "muted small" }, "Not sure which columns to use?"),
      h("button", { type: "button", class: "btn small", onclick: () => downloadTemplate() }, `Download a template for ${S.modelName}`),
      ...odooTemplates.get(model).map((t) => h("a", { class: "btn small ghost", href: t.url, download: "" }, t.label)));
  }

  function downloadTemplate() {
    return task("template", "Building the template…", async (op) => {
      const t = await OI.template.build(op.client, S.deps.schemas, S.model, S.modelName);
      if (!alive(op)) return;
      const blob = await OI.xlsxwriter.book({ sheets: t.sheets });
      if (!alive(op)) return;
      const url = URL.createObjectURL(blob);
      S.lastTemplate = { name: t.fileName, blob, columns: t.columns };
      download(url, t.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      endTask();
      setBusy("");
      toast(`Template with ${t.columns.length} columns downloaded`);
    });
  }

  function previewTable(headers, rows, lines) {
    return h("div", { class: "table-wrap" }, h("table", { class: "grid" },
      h("thead", null, h("tr", null, h("th", { class: "ln" }, "#"), headers.map((x) => h("th", { title: x }, x)))),
      h("tbody", null, rows.map((r, i) => h("tr", null, h("td", { class: "ln" }, lines ? lines[i] : i + 1), r.map((v) => h("td", { title: v }, v)))))));
  }

  function modelPicker() {
    const wrap = h("div", { class: "model-picker" });
    const input = h("input", { type: "text", placeholder: "Search a model: Contacts, Products, res.partner…", "aria-label": "Model",
      value: S.model ? `${S.modelName} (${S.model})` : "" });
    const list = h("ul", { class: "dropdown", hidden: true, role: "listbox" });
    let sel = 0;
    let items = [];
    const show = () => {
      const q = norm(input.value.replace(/\(.*\)$/, ""));
      items = (S.models || []).filter((m) => !q || norm(m.name).includes(q) || norm(m.model).includes(q)).slice(0, 60);
      list.replaceChildren(...items.map((m, i) => h("li", { class: i === sel ? "sel" : "", role: "option", onmousedown: (e) => { e.preventDefault(); choose(m); } },
        h("span", null, m.name), h("span", { class: "tech" }, m.model))));
      list.hidden = !items.length;
    };
    const choose = (m) => {
      list.hidden = true;
      input.value = `${m.name} (${m.model})`;
      setModel(m.model);
    };
    input.addEventListener("focus", () => { input.select(); sel = 0; show(); });
    input.addEventListener("input", () => { sel = 0; show(); });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); show(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); show(); e.preventDefault(); }
      else if (e.key === "Enter" && items[sel]) { choose(items[sel]); e.preventDefault(); }
      else if (e.key === "Escape") { list.hidden = true; }
    });
    wrap.append(input, list);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // step 2: columns
  function resolveJob() {
    const job = S.job;
    return task("lookup", "Looking up values in Odoo…", async (op) => {
      await OI.pipeline.updateRequired(op.deps, job);
      await OI.pipeline.resolve(op.deps, job);
      if (!alive(op)) return;
      S.analysis = OI.plan.analyze(job);
      S.check = null;
      S.reviewTab = "conflicts";
      S.expanded = new Set();
      S.groupLimit = new Map();
      endTask();
      setBusy("");
      go("review");
    });
  }

  const TYPE_LABEL = { char: "text", text: "text", html: "html", integer: "integer", float: "decimal", monetary: "amount", boolean: "yes/no", date: "date", datetime: "date & time",
    selection: "choice", many2one: "link", many2many: "tags", one2many: "lines", binary: "file", id: "external id", dbid: "id" };

  function pathLabel(fields) {
    return fields.map((f) => f.string).join(" / ");
  }

  function renderMap() {
    const job = S.job;
    const wrap = h("div");
    const mapped = job.mapping.filter((m) => m.path).length;
    const suggest = job.mapping.filter((m) => m.status === "suggest" && !m.confirmed).length;
    wrap.append(h("div", { class: "summary" },
      h("div", { class: "stat good" }, h("b", null, mapped), "columns mapped"),
      suggest ? h("div", { class: "stat warn" }, h("b", null, suggest), "to confirm") : null,
      h("div", { class: "stat" }, h("b", null, job.mapping.length - mapped), "not imported"),
      h("span", { class: "spacer" }),
      h("span", { class: "muted small" }, `Into ${S.modelName}`)));

    const table = h("table", { class: "map-table" },
      h("thead", null, h("tr", null, h("th", null, "Column in your file"), h("th", null, "Odoo field"), h("th", null, ""))));
    const tbody = h("tbody");
    for (const m of job.mapping) {
      const p = job.profiles[m.col];
      const status = m.status === "suggest" && m.confirmed ? "manual" : m.status;
      const chipText = { auto: "✓ auto", memory: "✓ remembered", suggest: "? check", manual: "✓ chosen", none: "not mapped", ignored: "skipped" }[m.source === "memory" && status === "auto" ? "memory" : status];
      tbody.append(h("tr", { class: m.path ? "" : "ignored" },
        h("td", null,
          h("div", { class: "colname" }, job.table.headers[m.col], h("span", { class: "type" }, p.type === "empty" ? "empty" : p.list ? `${p.type} list` : p.type)),
          h("div", { class: "samples", title: p.samples.join(" · ") }, p.samples.length ? p.samples.slice(0, 3).join(" · ") : "—")),
        h("td", null, fieldPicker(m)),
        h("td", null,
          h("span", { class: `chip ${m.source === "memory" && status === "auto" ? "memory" : status}`, title: m.score ? `Match score ${Math.round(m.score * 100)}% (${m.source})` : "" }, chipText),
          m.status === "suggest" && !m.confirmed
            ? h("button", { type: "button", class: "btn small", style: "margin-left:6px", onclick: () => { m.confirmed = true; render(); } }, "OK")
            : null)));
    }
    table.append(tbody);
    wrap.append(table);

    const req = job.requiredMissing.filter((f) => !job.mapping.some((m) => m.path && m.path[0] === f.name));
    if (req.length) {
      wrap.append(h("div", { class: "notice info" }, h("span", null, "ℹ"), h("div", { class: "grow" },
        h("b", null, "Required fields without a column: "), req.map((f) => f.string).join(", "),
        h("div", { class: "small muted" }, "Odoo may compute them from other fields. If not, you can set one value for every record in the review step."))));
    }
    return wrap;
  }

  // Field picker: search importable fields; one2many fields open their own fields.
  function fieldPicker(m) {
    const job = S.job;
    const wrap = h("div", { class: "picker" });
    const label = m.fields ? pathLabel(m.fields) : null;
    const tech = m.path ? m.path.join("/") : "";
    const btn = h("button", { type: "button", class: `fieldbtn${m.path ? "" : " none"}`, "aria-haspopup": "listbox" },
      h("span", null, label || "Don't import"), tech ? h("span", { class: "tech" }, tech) : null, h("span", null, "▾"));
    wrap.append(btn);
    btn.addEventListener("click", () => openPop());

    async function openPop() {
      closePops();
      const pop = h("div", { class: "pop" });
      const input = h("input", { type: "search", placeholder: "Search fields…", "aria-label": "Search fields" });
      const crumb = h("div", { class: "crumb" });
      const list = h("ul", { role: "listbox" });
      pop.append(crumb, input, list);
      wrap.append(pop);
      let stack = [{ model: job.model, prefix: [], label: S.modelName }];
      let items = [];
      let sel = 0;
      const load = async () => {
        const top = stack[stack.length - 1];
        const fields = await S.deps.schemas.importable(top.model);
        crumb.replaceChildren(...(stack.length > 1
          ? [h("button", { type: "button", class: "btn small ghost", onclick: () => { stack.pop(); load(); } }, "←"), stack.map((s) => s.label).join(" / ")]
          : []));
        const q = norm(input.value);
        const list2 = fields.filter((f) => !q || norm(f.string).includes(q) || norm(f.name).includes(q) || norm(f.stringEn).includes(q));
        // Sub-levels can't contain other one2many (Odoo limits the depth too).
        items = [...(stack.length === 1 && !q ? [{ none: true }] : []), ...list2.filter((f) => !(stack.length > 1 && f.type === "one2many"))];
        sel = Math.min(sel, items.length - 1);
        draw();
      };
      const draw = () => {
        list.replaceChildren(...items.slice(0, 200).map((f, i) => f.none
          ? h("li", { class: i === sel ? "sel" : "", onmousedown: (e) => { e.preventDefault(); pick(f); } }, h("i", null, "Don't import this column"))
          : h("li", { class: i === sel ? "sel" : "", onmousedown: (e) => { e.preventDefault(); pick(f); }, title: f.help || "" },
            h("span", null, f.string, f.required ? h("span", { class: "req" }, " *") : null),
            f.type === "one2many" ? h("span", null, "›") : null,
            h("span", { class: "tech" }, `${f.name} · ${TYPE_LABEL[f.type] || f.type}`))));
        const cur = list.children[sel];
        if (cur) cur.scrollIntoView({ block: "nearest" });
      };
      const pick = async (f) => {
        if (f.none) {
          await OI.pipeline.setPath(S.deps, job, m.col, null);
          return done();
        }
        const top = stack[stack.length - 1];
        if (f.type === "one2many" && stack.length === 1) {
          stack.push({ model: f.relation, prefix: [...top.prefix, f.name], label: f.string });
          input.value = "";
          sel = 0;
          await load();
          input.focus();
          return;
        }
        await OI.pipeline.setPath(S.deps, job, m.col, [...top.prefix, f.name], { status: "manual" });
        done();
      };
      const done = async () => {
        closePops();
        await OI.pipeline.updateRequired(S.deps, job);
        S.analysis = null;
        render();
      };
      input.addEventListener("input", () => { sel = 0; load(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
        else if (e.key === "Enter" && items[sel]) { pick(items[sel]); e.preventDefault(); }
        else if (e.key === "Escape") { closePops(); btn.focus(); e.preventDefault(); }
        else if (e.key === "Backspace" && !input.value && stack.length > 1) { stack.pop(); load(); }
      });
      await load();
      input.focus();
    }
    return wrap;
  }

  function closePops() {
    for (const p of shadow.querySelectorAll(".pop")) p.remove();
  }
  shadow.addEventListener("mousedown", (e) => {
    if (!e.composedPath().some((n) => n.classList && (n.classList.contains("pop") || n.classList.contains("fieldbtn")))) closePops();
  });

  // ---------------------------------------------------------------------------
  // step 3: review
  function reanalyze() {
    S.analysis = OI.plan.analyze(S.job);
    S.check = null;
    render();
  }

  function decide(c, d) {
    S.job.decisions.set(c.key, { ...d, rows: c.rows.slice() });
    reanalyze();
  }

  function undecide(key) {
    S.job.decisions.delete(key);
    reanalyze();
  }

  async function columnDecision(c, path) {
    const m = S.job.mapping[c.col];
    if (path === undefined) {
      m.confirmed = true;
      return reanalyze();
    }
    await task("lookup", "Looking up values in Odoo…", async (op) => {
      await OI.pipeline.setPath(op.deps, S.job, c.col, path, { status: "manual" });
      await OI.pipeline.resolve(op.deps, S.job);
      if (!alive(op)) return;
      endTask();
      setBusy("");
      reanalyze();
    });
  }

  function rowsText(rows) {
    const lines = rows.map((r) => S.job.table.lines[r]);
    if (!lines.length) return "";
    const shown = lines.slice(0, 4).join(", ");
    return `${lines.length > 1 ? "rows" : "row"} ${shown}${lines.length > 4 ? ` +${lines.length - 4}` : ""}`;
  }

  const KIND_LABEL = { column: "column", dateorder: "date format", m2o: "", value: "value", requiredempty: "required", existing: "existing", duplicate: "duplicate", requiredcol: "required", archived: "archived" };

  function card(c, index, isWarning) {
    const kind = c.kind === "m2o" ? c.status : c.kind;
    const label = c.kind === "m2o" ? { ambiguous: "ambiguous", missing: "not found", probable: "close match", archived: "archived" }[c.status] : KIND_LABEL[c.kind];
    const el = h("div", { class: `card${index === S.focus && !isWarning ? " focus" : ""}`, tabindex: "0", "data-index": index },
      h("div", { class: "title" }, h("span", { class: `kind ${kind}` }, label), h("span", null, c.title), h("span", { class: "rows" }, rowsText(c.rows))),
      h("div", { class: "msg" }, c.message));
    el.addEventListener("focus", () => {
      if (!isWarning) {
        S.focus = index;
        for (const x of body.querySelectorAll(".card.focus")) x.classList.remove("focus");
        el.classList.add("focus");
      }
    });
    const cands = h("div", { class: "cands" });
    const actions = h("div", { class: "actions" });
    const cand = (n, title, detail, extra, onclick) =>
      h("button", { type: "button", class: "cand", onclick, title: n <= 5 ? `Press ${n}` : "" }, h("span", { class: "l" }, title), detail ? h("span", { class: "d" }, detail) : null, extra ? h("span", { class: "k" }, extra) : null);

    if (c.kind === "column") {
      const m = S.job.mapping[c.col];
      cands.append(cand(1, `Yes: ${m.fields ? pathLabel(m.fields) : m.path.join("/")}`, null, null, () => columnDecision(c)));
      (c.candidates || []).filter((x) => x.path.join("/") !== m.path.join("/")).slice(0, 3).forEach((x, i) =>
        cands.append(cand(i + 2, x.path.join(" / "), `${Math.round(x.score * 100)}% · ${x.source}`, null, () => columnDecision(c, x.path))));
      actions.append(h("button", { type: "button", class: "btn small", onclick: () => columnDecision(c, null) }, "Don't import this column"),
        h("button", { type: "button", class: "btn small ghost", onclick: () => go("map") }, "Choose another field…"));
    } else if (c.kind === "dateorder") {
      c.candidates.forEach((x, i) => cands.append(cand(i + 1, x.label, `${c.value} → ${preview(c.value, x.id)}`, null, () => {
        const p = S.job.profiles[c.col];
        p.dateOrder = x.id;
        p.dateOrderConfirmed = true;
        reanalyze();
      })));
    } else if (c.kind === "m2o") {
      c.candidates.slice(0, 5).forEach((x, i) => cands.append(cand(i + 1, x.label, x.detail, x.score < 1 ? `${Math.round(x.score * 100)}% match` : null, () => decide(c, { action: "pick", id: x.id, label: x.label }))));
      actions.append(searchInline(c.relation, (id, label) => decide(c, { action: "pick", id, label })));
      if (c.status !== "archived") {
        const why = createReason(c);
        actions.append(h("button", { type: "button", class: "btn small", disabled: !!why, title: why || "Press C", onclick: () => decide(c, { action: "create", value: c.value }) }, `Create “${c.value}”`));
      }
      else actions.append(h("button", { type: "button", class: "btn small", onclick: () => decide(c, { action: "pick", id: c.candidates[0].id, label: c.candidates[0].label }) }, "Use the archived record"));
      actions.append(emptyBtn(c, c.field), skipBtn(c));
    } else if (c.kind === "value") {
      (c.candidates || []).slice(0, 5).forEach((x, i) => cands.append(cand(i + 1, x.label, null, x.score ? `${Math.round(x.score * 100)}%` : null, () => decide(c, { action: "pick", id: x.id, label: x.label }))));
      const input = h("input", { type: "text", placeholder: "Replace with…", "aria-label": "Replacement value" });
      const apply = () => {
        const r = OI.values.convert(c.field, input.value, S.job.profiles[c.col]);
        if (!input.value.trim()) return;
        if (!r.ok) return toast(`“${input.value}” ${OI.values.REASONS[r.reason] || "can't be used"}`);
        decide(c, { action: "value", value: input.value, label: input.value });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
      actions.append(input, h("button", { type: "button", class: "btn small", onclick: apply }, "Use"), emptyBtn(c, c.field), skipBtn(c));
    } else if (c.kind === "requiredempty") {
      actions.append(valueSetter(c.field, (out, label) => decide(c, { action: "default", out, label }), "Use for these rows"), skipBtn(c));
    } else if (c.kind === "existing") {
      c.candidates.forEach((x, i) => cands.append(cand(i + 1, x.label, `#${x.id}`, null, () => decide(c, { action: "pick", id: x.id, label: x.label }))));
      actions.append(h("button", { type: "button", class: "btn small", onclick: () => decide(c, { action: "create" }) }, "Create a new one"), skipBtn(c));
    } else if (c.kind === "duplicate") {
      actions.append(
        h("button", { type: "button", class: "btn small", onclick: () => decide(c, { action: "all" }) }, "Import all"),
        h("button", { type: "button", class: "btn small", onclick: () => decide(c, { action: "first" }) }, "Keep the first row"),
        h("button", { type: "button", class: "btn small", onclick: () => decide(c, { action: "last" }) }, "Keep the last row"));
    } else if (c.kind === "requiredcol") {
      actions.append(valueSetter(c.field, (out, label) => {
        S.job.defaults.set(c.field.name, { out, label, path: c.field.type === "many2one" ? `${c.field.name}/.id` : c.field.name });
        reanalyze();
      }, "Use for every record"));
    }
    if (cands.childElementCount) el.append(cands);
    if (actions.childElementCount) el.append(actions);
    return el;
  }

  function preview(value, order) {
    const d = OI.profile.parseDate(value, order);
    if (!d) return "?";
    return new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }

  function emptyBtn(c, field) {
    const required = field && field.required;
    return h("button", { type: "button", class: "btn small", title: required ? "This field is required" : "Press E", onclick: () => decide(c, { action: "empty" }) }, "Leave empty");
  }

  function skipBtn(c) {
    const n = c.rows.length;
    return h("button", { type: "button", class: "btn small danger", title: "Press S", onclick: () => decide(c, { action: "skip" }) }, `Skip ${n > 1 ? `${n} rows` : "row"}`);
  }

  // Search any record of a model (name_search) and pick one.
  function searchInline(relation, onpick, placeholder = "Search…") {
    const wrap = h("span", { class: "search-inline" });
    const input = h("input", { type: "search", placeholder, "aria-label": "Search records" });
    const list = h("ul", { class: "dropdown", hidden: true });
    let items = [];
    let sel = 0;
    let timer;
    const draw = () => {
      list.replaceChildren(...items.map(([id, label], i) => h("li", { class: i === sel ? "sel" : "", onmousedown: (e) => { e.preventDefault(); onpick(id, label); } }, h("span", null, label), h("span", { class: "tech" }, `#${id}`))));
      list.hidden = !items.length;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        items = await S.client.call(relation, "name_search", [input.value, [], "ilike", 12]).catch(() => []);
        sel = 0;
        draw();
      }, 200);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && items[sel]) { onpick(...items[sel]); e.preventDefault(); }
    });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
    wrap.append(input, list);
    return wrap;
  }

  // One value for a field: a record search, a choice list or a typed value.
  function valueSetter(field, onset, buttonText) {
    if (field.type === "many2one") return searchInline(field.relation, (id, label) => onset(String(id), label), `Search ${field.string}…`);
    const wrap = h("span", { class: "row" });
    let input;
    if (field.type === "selection") {
      input = h("select", { "aria-label": field.string }, h("option", { value: "" }, "Choose…"), (field.selection || []).map(([k, l]) => h("option", { value: k }, l)));
    } else if (field.type === "boolean") {
      input = h("select", { "aria-label": field.string }, h("option", { value: "1" }, "Yes"), h("option", { value: "0" }, "No"));
    } else {
      input = h("input", { type: "text", placeholder: field.string, "aria-label": field.string });
    }
    const apply = () => {
      const raw = input.value;
      if (!String(raw).trim()) return;
      const r = OI.values.convert(field, raw, {});
      if (!r.ok) return toast(`“${raw}” ${OI.values.REASONS[r.reason] || "can't be used"}`);
      const label = input.tagName === "SELECT" ? input.selectedOptions[0].textContent : raw;
      onset(r.out, label);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
    wrap.append(input, h("button", { type: "button", class: "btn small", onclick: apply }, buttonText));
    return wrap;
  }

  // Why "Create" isn't possible for a relational conflict (null when it is).
  function createReason(c) {
    const info = S.job.createInfo && S.job.createInfo.get(c.relation);
    if (!info || info.ok) return null;
    if (info.noRights) return `You aren't allowed to create ${c.field.string} records.`;
    return `A new ${c.field.string} needs ${info.missing.join(", ")}, which the name alone doesn't give.`;
  }

  // Same decision for many conflicts at once; `make(c)` returns the decision for one.
  function decideAll(list, make) {
    for (const c of list) S.job.decisions.set(c.key, { ...make(c), rows: c.rows.slice() });
    toast(`${list.length} settled`);
    reanalyze();
  }

  // Conflicts of the same column and kind form a group: "Country: 2,000 not found".
  function groupConflicts(conflicts) {
    const groups = new Map();
    for (const c of conflicts) {
      const key = c.kind === "m2o" ? `m2o:${c.col}:${c.status}` : c.kind === "value" ? `value:${c.col}` : c.key;
      if (!groups.has(key)) groups.set(key, { key, kind: c.kind, status: c.status, col: c.col, field: c.field, items: [] });
      groups.get(key).items.push(c);
    }
    return [...groups.values()];
  }

  const GROUP_LABEL = { missing: "not found", ambiguous: "match several records", probable: "close matches" };

  function groupHead(g) {
    const n = g.items.length;
    const rows = g.items.reduce((sum, c) => sum + c.rows.length, 0);
    const header = S.job.table.headers[g.col];
    const label = g.kind === "m2o" ? GROUP_LABEL[g.status] : "values that can't be imported";
    const head = h("div", { class: "group-head" },
      h("div", { class: "title" }, h("span", null, `${header}: ${n.toLocaleString()} ${label}`), h("span", { class: "rows" }, `${rows.toLocaleString()} rows`)));
    const actions = h("div", { class: "actions" });
    if (g.kind === "m2o") {
      const sample = g.items[0];
      if (g.status === "probable") {
        actions.append(h("button", { type: "button", class: "btn small", onclick: () => decideAll(g.items, (c) => ({ action: "pick", id: c.candidates[0].id, label: c.candidates[0].label })) }, `Accept all ${n} close matches`));
      }
      const why = createReason(sample);
      actions.append(h("button", { type: "button", class: "btn small", disabled: !!why, title: why || `Creates ${n} new ${sample.field.string} records before the import`,
        onclick: () => decideAll(g.items, (c) => ({ action: "create", value: c.value })) }, `Create all ${n}`));
      actions.append(h("span", { class: "muted small" }, "or use one for all:"),
        searchInline(sample.relation, (id, label) => decideAll(g.items, () => ({ action: "pick", id, label })), `Search ${sample.field.string}…`));
    }
    actions.append(
      h("button", { type: "button", class: "btn small", title: g.field && g.field.required ? "This field is required: the rows will then ask for a value" : "",
        onclick: () => decideAll(g.items, () => ({ action: "empty" })) }, "Leave all empty"),
      h("button", { type: "button", class: "btn small danger", onclick: () => decideAll(g.items, () => ({ action: "skip" })) }, `Skip all ${rows.toLocaleString()} rows`));
    head.append(actions);
    if (g.kind === "m2o" && g.status !== "probable") {
      const why = createReason(g.items[0]);
      if (why) head.append(h("div", { class: "small muted", style: "margin-top:4px" }, `Can't create: ${why}`));
    }
    return head;
  }

  function describeDecision(key, d) {
    const [kind] = key.split(":");
    const what = key.replace(/^[a-z0-9]+:(\d+:)?/, "");
    const act = {
      pick: `→ ${d.label || `#${d.id}`}`, create: `→ create “${d.value}”`, empty: "→ left empty", skip: `→ ${d.rows ? d.rows.length : ""} row(s) skipped`,
      value: `→ “${d.value}”`, default: `→ ${d.label}`, first: "→ first row kept", last: "→ last row kept", all: "→ all rows kept",
    }[d.action] || d.action;
    const col = /^[a-z0-9]+:(\d+):/.exec(key);
    const where = col ? `${S.job.table.headers[Number(col[1])]}: ` : kind === "duplicate" ? "Duplicate: " : kind === "existing" ? "Existing: " : "";
    return `${where}“${what}” ${act}`;
  }

  function renderReview() {
    const a = S.analysis;
    const job = S.job;
    const wrap = h("div");
    const probable = a.conflicts.filter((c) => c.status === "probable");
    wrap.append(h("div", { class: "summary" },
      h("div", { class: "stat good" }, h("b", null, a.stats.create), "to create"),
      h("div", { class: "stat good" }, h("b", null, a.stats.update), "to update"),
      a.stats.skip ? h("div", { class: "stat" }, h("b", null, a.stats.skip), "skipped") : null,
      h("div", { class: `stat ${a.conflicts.length ? "bad" : "good"}` }, h("b", null, a.conflicts.length), a.conflicts.length === 1 ? "conflict" : "conflicts"),
      a.warnings.length ? h("div", { class: "stat warn" }, h("b", null, a.warnings.length), "warnings") : null,
      h("span", { class: "spacer" }),
      keyControl()));

    const tabs = h("div", { class: "tabs", role: "tablist" },
      [["conflicts", `To decide (${a.conflicts.length})`], ["warnings", `Warnings (${a.warnings.length})`], ["preview", "Preview data"]].map(([k, l]) =>
        h("button", { type: "button", role: "tab", class: S.reviewTab === k ? "active" : "", onclick: () => { S.reviewTab = k; render(); } }, l)));
    wrap.append(tabs);

    if (S.reviewTab === "conflicts") {
      if (!a.conflicts.length) {
        wrap.append(h("div", { class: "notice ok" }, h("span", { class: "big-ok" }, "✓"), h("div", { class: "grow" },
          h("b", null, "Nothing left to decide."), h("div", null, "Every value matches a record or a valid format. Next: check with Odoo and import."))));
      } else {
        const tools = h("div", { class: "row", style: "margin-bottom:8px" });
        if (probable.length > 1) {
          tools.append(h("button", { type: "button", class: "btn small", onclick: () => decideAll(probable, (c) => ({ action: "pick", id: c.candidates[0].id, label: c.candidates[0].label })) },
            `Accept all ${probable.length} close matches`));
        }
        tools.append(h("span", { class: "kbd-help" }, h("kbd", null, "↑"), h("kbd", null, "↓"), " move · ", h("kbd", null, "1"), "–", h("kbd", null, "5"), " pick · ", h("kbd", null, "C"), " create · ", h("kbd", null, "E"), " empty · ", h("kbd", null, "S"), " skip"));
        wrap.append(tools);
        // Groups of the same column and kind get bulk actions; their cards are folded when
        // there are many. S.visible lists the cards on screen, for the keyboard.
        S.visible = [];
        const list = h("div", { class: "cards" });
        for (const g of groupConflicts(a.conflicts)) {
          if (g.items.length < 2) {
            list.append(card(g.items[0], S.visible.push(g.items[0]) - 1, false));
            continue;
          }
          const box = h("div", { class: "group" }, groupHead(g));
          const open = S.expanded.has(g.key) || g.items.length <= 5;
          if (open) {
            const limit = S.groupLimit.get(g.key) || 50;
            for (const c of g.items.slice(0, limit)) box.append(card(c, S.visible.push(c) - 1, false));
            if (g.items.length > limit) {
              box.append(h("button", { type: "button", class: "btn small", onclick: () => { S.groupLimit.set(g.key, limit + 50); render(); } }, `Show more (${g.items.length - limit} left)`));
            }
            if (g.items.length > 5) box.append(h("button", { type: "button", class: "btn small ghost", onclick: () => { S.expanded.delete(g.key); render(); } }, "Fold"));
          } else {
            box.append(h("button", { type: "button", class: "btn small ghost", onclick: () => { S.expanded.add(g.key); render(); } },
              `Decide one by one (${g.items.length.toLocaleString()} values: ${g.items.slice(0, 3).map((c) => `“${c.value}”`).join(", ")}…)`));
          }
          list.append(box);
        }
        S.focus = Math.max(0, Math.min(S.focus, S.visible.length - 1));
        wrap.append(list);
      }
    } else if (S.reviewTab === "warnings") {
      wrap.append(a.warnings.length ? h("div", { class: "cards" }, a.warnings.slice(0, 200).map((c, i) => card(c, i, true))) : h("div", { class: "empty-state" }, "No warnings."));
      if (a.warnings.length > 200) wrap.append(h("div", { class: "muted small" }, `First 200 of ${a.warnings.length} warnings.`));
    } else {
      wrap.append(gridPreview());
    }

    const decided = [...job.decisions].filter(([k]) => !k.startsWith("error:"));
    const defaults = [...job.defaults];
    if (decided.length || defaults.length) {
      const det = h("details", { class: "done-list" }, h("summary", null, `Your decisions (${(decided.length + defaults.length).toLocaleString()})`));
      // Many identical decisions on one column read as one line: "Country: 2,000 values → skipped".
      const byGroup = new Map();
      for (const [k, d] of decided) {
        const m = /^(m2o|value):(\d+):/.exec(k);
        const g = m ? `${m[2]}:${d.action}:${d.action === "pick" ? d.id : ""}` : k;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push([k, d]);
      }
      for (const items of byGroup.values()) {
        if (items.length > 3) {
          const [k, d] = items[0];
          const col = Number(/^[a-z0-9]+:(\d+):/.exec(k)[1]);
          const rows = items.reduce((sum, [, x]) => sum + (x.rows ? x.rows.length : 0), 0);
          const act = { pick: `→ ${d.label}`, create: "→ created", empty: "→ left empty", skip: "→ rows skipped", value: "→ replaced" }[d.action] || d.action;
          det.append(h("div", { class: "decided" }, h("span", { class: "what" }, `${S.job.table.headers[col]}: ${items.length.toLocaleString()} values ${act} (${rows.toLocaleString()} rows)`),
            h("button", { type: "button", class: "btn small ghost", onclick: () => { for (const [key] of items) job.decisions.delete(key); reanalyze(); } }, "Undo all")));
        } else {
          for (const [k, d] of items) {
            det.append(h("div", { class: "decided" }, h("span", { class: "what" }, describeDecision(k, d)), h("button", { type: "button", class: "btn small ghost", onclick: () => undecide(k) }, "Undo")));
          }
        }
      }
      for (const [name, d] of defaults) {
        det.append(h("div", { class: "decided" }, h("span", { class: "what" }, `Every record: ${name} → ${d.label}`), h("button", { type: "button", class: "btn small ghost", onclick: () => { job.defaults.delete(name); reanalyze(); } }, "Undo")));
      }
      wrap.append(det);
    }
    return wrap;
  }

  function lookupKey(job) {
    return task("lookup", "Looking for existing records…", async (op) => {
      await OI.plan.lookupExisting(job, { client: op.client, onProgress: op.deps.onProgress });
      if (!alive(op)) return;
      endTask();
      setBusy("");
      reanalyze();
    });
  }

  // Match existing records by a key column: update / skip / always create.
  function keyControl() {
    const job = S.job;
    const opts = job.keyOptions || [];
    if (!opts.length) return h("span", { class: "muted small" }, "Every row creates a new record");
    const sel = h("select", { "aria-label": "Match existing records by", onchange: async () => {
      const v = sel.value;
      job.keyChosen = true;
      const o = opts.find((x) => String(x.col) === v);
      job.key = o ? { col: o.col, field: o.field, label: o.label, mode: (job.key && job.key.mode !== "create" && job.key.mode) || "update" } : null;
      await lookupKey(job);
    } },
    h("option", { value: "" }, "nothing (always create)"),
    opts.map((o) => h("option", { value: o.col, selected: job.key && job.key.col === o.col }, `${o.label}${o.unique ? "" : " (not unique)"}`)));
    const mode = h("select", { "aria-label": "When a record exists", disabled: !job.key, onchange: async () => {
      job.key.mode = mode.value;
      await lookupKey(job);
    } },
    h("option", { value: "update", selected: job.key && job.key.mode === "update" }, "update it"),
    h("option", { value: "skip", selected: job.key && job.key.mode === "skip" }, "skip the row"),
    h("option", { value: "create", selected: job.key && job.key.mode === "create" }, "create anyway"));
    return h("span", { class: "row small" }, "Find existing records by", sel, "· if found:", mode);
  }

  // The source rows, each cell tinted by what will happen to it.
  function gridPreview() {
    const job = S.job;
    const a = S.analysis;
    const open = new Set(a.conflicts.map((c) => c.key));
    const maps = OI.plan.active(job);
    const cols = maps.map((m) => m.col);
    const startSet = a.starts;
    const head = h("tr", null, h("th", { class: "ln" }, "#"), maps.map((m) => h("th", { title: m.path.join("/") }, job.table.headers[m.col], h("div", { class: "small muted" }, pathLabel(m.fields)))));
    const rows = [];
    const n = Math.min(job.table.rows.length, PREVIEW_ROWS);
    for (let i = 0; i < n; i++) {
      const row = job.table.rows[i];
      const skipped = a.skipRows.has(i) || (startSet.has(i) && OI.plan.existingTarget(job, i) === "skip");
      const tds = cols.map((col, k) => {
        const raw = String(row[col] ?? "").trim();
        if (!raw) return h("td", null, "");
        const m = maps[k];
        const rel = job.rel.get(col);
        if (rel) {
          const parts = OI.plan.pieces(job, col, raw);
          let cls = "c-ok";
          const labels = [];
          for (const p of parts) {
            const key = `m2o:${col}:${lower(p)}`;
            const d = job.decisions.get(key);
            const narrowed = a.rowId.get(`${col}:${i}:${lower(p)}`);
            const r = (job.resolutions.get(col) || new Map()).get(p);
            if (narrowed) labels.push(`#${narrowed}`);
            else if (d) {
              if (cls === "c-ok") cls = "c-fix";
              labels.push(describeDecision(key, d).split("” ").pop());
            } else if (open.has(key)) {
              cls = "c-bad";
              labels.push("?");
            } else if (r && r.candidates[0]) labels.push(r.candidates.find((x) => x.id === r.id)?.label || r.candidates[0].label);
          }
          return h("td", { class: cls, title: labels.join(", ") }, raw);
        }
        const key = `value:${col}:${lower(raw)}`;
        if (job.decisions.has(key)) return h("td", { class: "c-fix", title: describeDecision(key, job.decisions.get(key)) }, raw);
        if (open.has(key)) return h("td", { class: "c-bad" }, raw);
        const conv = a.conv.get(col) && a.conv.get(col).get(raw);
        return h("td", { title: conv && conv.ok && conv.out !== raw ? `→ ${conv.out}` : m.fields[m.fields.length - 1].string }, raw);
      });
      rows.push(h("tr", { class: skipped ? "skipped" : "" }, h("td", { class: "ln" }, job.table.lines[i]), tds));
    }
    return h("div", null,
      h("div", { class: "row small muted", style: "margin-bottom:6px" },
        h("span", null, "Green: matched · blue: your decision · red: to decide · struck: skipped. Hover a cell for the record it links to."),
        job.table.rows.length > n ? h("span", null, `First ${n} of ${job.table.rows.length} rows.`) : null),
      h("div", { class: "table-wrap", style: "max-height: 460px" }, h("table", { class: "grid" }, h("thead", null, head), h("tbody", null, rows))));
  }

  // Keyboard for the conflict cards.
  body.addEventListener("keydown", (e) => {
    if (S.step !== "review" || S.reviewTab !== "conflicts" || !S.analysis) return;
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    const conflicts = S.visible || [];
    if (!conflicts.length) return;
    const c = conflicts[S.focus];
    const cardEl = body.querySelector(`.card[data-index="${S.focus}"]`);
    const key = e.key.toLowerCase();
    if (key === "arrowdown" || key === "j") {
      S.focus = Math.min(conflicts.length - 1, S.focus + 1);
      focusCard();
    } else if (key === "arrowup" || key === "k") {
      S.focus = Math.max(0, S.focus - 1);
      focusCard();
    } else if (/^[1-5]$/.test(key) && cardEl) {
      const btn = cardEl.querySelectorAll(".cand")[Number(key) - 1];
      if (btn) btn.click();
    } else if (key === "c" && c.kind === "m2o" && c.status !== "archived" && !createReason(c)) decide(c, { action: "create", value: c.value });
    else if (key === "e" && (c.kind === "m2o" || c.kind === "value")) decide(c, { action: "empty" });
    else if (key === "s" && c.rows.length) decide(c, { action: "skip" });
    else return;
    e.preventDefault();
  });

  function focusCard() {
    const el = body.querySelector(`.card[data-index="${S.focus}"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }

  // ---------------------------------------------------------------------------
  // step 4: import
  async function runImport(dryrun) {
    if (S.busy || S.op) return;
    const job = S.job;
    S.analysis = OI.plan.analyze(job);
    if (S.analysis.conflicts.length) {
      go("review");
      return toast("Settle the conflicts first");
    }
    let result = null;
    let cancelled = false;
    // The check can be cut off at any time (Odoo rolls it back anyway); the real import
    // only stops between batches.
    const started = performance.now();
    await task(dryrun ? "check" : "import", dryrun ? "Checking with Odoo (nothing is saved)…" : "Importing…", async (op) => {
      S.progress = { phase: dryrun ? "check" : "import", done: 0, total: 1, started };
      S.result = null;
      if (dryrun) S.check = null;
      render();
      try {
        result = await op.deps.executor.run(job, S.analysis, {
          dryrun,
          batchSize: Math.max(1, Number(S.settings.batchSize) || 500),
          signal: op.ctrl.signal,
          context: S.settings.fast ? { tracking_disable: true } : {},
          onProgress: (p) => {
            if (S.op !== op) return;
            S.progress = { ...p, started: S.progress.started };
            renderProgress();
          },
        });
      } catch (e) {
        if (e && e.aborted) cancelled = true;
        else result = { ok: false, dryrun, errors: [{ row: null, line: null, message: e.message, title: e.title }], created: [], updated: [], deps: [], warnings: [] };
      }
      if (dryrun && !alive(op)) cancelled = true;
    }, { abortRequests: dryrun });
    S.progress = null;
    if (cancelled || !result) return render();
    result.ms = performance.now() - started;
    result.fast = !!S.settings.fast;
    if (dryrun) S.check = result;
    else {
      S.result = result;
      if (result.created.length || result.updated.length || (result.deps || []).length) {
        await addHistory(job, result);
        if (result.ok) await remember(job, result);
      }
    }
    render();
  }

  function duration(secs) {
    if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
    if (secs < 3600) return `${Math.round(secs / 60)} min`;
    return `${(secs / 3600).toFixed(1)} h`;
  }

  function renderProgress() {
    const bar = body.querySelector(".progress > div");
    const p = S.progress;
    if (bar && p) bar.style.width = `${p.total ? Math.round((100 * p.done) / p.total) : 0}%`;
    const t = body.querySelector(".progress-text");
    if (t && p) {
      if (p.phase === "create") t.textContent = `Creating linked records… ${p.done}/${p.total}`;
      else {
        // Rows per second so far, and what is left at that pace.
        const secs = (performance.now() - p.started) / 1000;
        const eta = p.done && p.done < p.total ? ` · about ${duration(((p.total - p.done) * secs) / p.done)} left` : "";
        t.textContent = `${p.done} / ${p.total} rows${eta}`;
      }
    }
  }

  function skipErrorRows(result) {
    for (const e of result.errors) {
      if (e.row === null || e.row === undefined) continue;
      S.job.decisions.set(`error:${e.row}`, { action: "skip", rows: [e.row] });
    }
    S.analysis = OI.plan.analyze(S.job);
    S.check = null;
    render();
  }

  function downloadErrors(result) {
    const job = S.job;
    const byRow = new Map();
    for (const e of result.errors) {
      if (e.row === null || e.row === undefined) continue;
      byRow.set(e.row, [...(byRow.get(e.row) || []), e.message]);
    }
    const rows = [["Line", ...job.table.headers, "Error"], ...[...byRow].sort((a, b) => a[0] - b[0]).map(([r, msgs]) => [job.table.lines[r], ...job.table.rows[r], msgs.join(" | ")])];
    const blob = new Blob(["﻿" + OI.csv.serialize(rows)], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${(job.file || "import").replace(/\.[^.]+$/, "")}-errors.csv` });
    shadow.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Odoo's messages, explained and grouped: "Customer is empty — lines 3, 5, 9 +12", what to do, details.
  function errorList(errors) {
    const groups = OI.errors.group(errors);
    const lines = (ls) => (ls.length ? `${ls.length > 1 ? "lines" : "line"} ${ls.slice(0, 6).join(", ")}${ls.length > 6 ? ` +${ls.length - 6}` : ""}` : "");
    return h("ul", { class: "errors" }, groups.slice(0, 100).map((g) => h("li", null,
      h("div", { class: "grow" },
        h("div", null, h("b", null, g.title), g.lines.length ? h("span", { class: "ln" }, ` · ${lines(g.lines)}`) : null),
        g.hint ? h("div", { class: "hint" }, g.hint) : null,
        g.original && g.original !== g.title ? h("details", null, h("summary", null, "Details from Odoo"), h("pre", null, g.original)) : null))));
  }

  function renderImport() {
    const a = S.analysis;
    const job = S.job;
    const wrap = h("div");
    const willCreate = OI.plan.toCreate(job);
    wrap.append(h("div", { class: "summary" },
      h("div", { class: "stat good" }, h("b", null, a.stats.create), "to create"),
      h("div", { class: "stat good" }, h("b", null, a.stats.update), "to update"),
      a.stats.skip ? h("div", { class: "stat" }, h("b", null, a.stats.skip), "skipped") : null,
      willCreate.length ? h("div", { class: "stat" }, h("b", null, willCreate.length), "linked records to create first") : null,
      h("span", { class: "spacer" }),
      h("label", { class: "row small muted" }, "Rows per batch", h("input", { type: "number", min: "1", max: "5000", value: S.settings.batchSize, style: "width:80px",
        onchange: (e) => { S.settings.batchSize = Number(e.target.value) || 500; store.set(K.settings, S.settings); } }))));

    if (!S.progress && !S.result) {
      wrap.append(h("label", { class: "row small", style: "margin-bottom:10px" },
        h("input", { type: "checkbox", checked: !!S.settings.fast, onchange: (e) => { S.settings.fast = e.target.checked; store.set(K.settings, S.settings); render(); } }),
        h("span", null, h("b", null, "Fast mode"), " · no chatter messages (“created”, field changes) and no followers on the imported records. Often 5–10× faster for big files.")));
    }

    if (S.progress) {
      wrap.append(h("div", { class: "progress" }, h("div")), h("div", { class: "row small muted" }, h("span", { class: "spinner" }), h("span", { class: "progress-text" }, ""),
        h("span", { class: "spacer" })));
      setTimeout(renderProgress);
      return wrap;
    }

    const r = S.result;
    if (r) {
      const n = r.created.length + r.updated.length;
      if (r.ok) {
        wrap.append(h("div", { class: "notice ok" }, h("span", { class: "big-ok" }, "✓"), h("div", { class: "grow" },
          h("b", null, `Imported: ${r.created.length} created, ${r.updated.length} updated.`),
          r.deps && r.deps.length ? h("div", null, `Also created ${r.deps.reduce((s, d) => s + d.ids.length, 0)} linked records.`) : null,
          h("div", { class: "row", style: "margin-top:8px" },
            h("button", { type: "button", class: "btn small", onclick: () => openRecords(job.model, [...r.created, ...r.updated]) }, r.created.length + r.updated.length === 1 ? "Open the record" : "Open the list"),
            undoButton(S.history[0]),
            h("button", { type: "button", class: "btn small", onclick: () => startOver() }, "Import another file")))));
      } else {
        wrap.append(h("div", { class: "notice err" }, h("span", null, "✕"), h("div", { class: "grow" },
          h("b", null, r.cancelled ? "Stopped." : "The import stopped on an error."),
          n ? h("div", null, `${n} records from earlier batches were saved (${r.created.length} created, ${r.updated.length} updated). You can undo them from History.`) : h("div", null, "Nothing was saved."))));
        wrap.append(errorList(r.errors));
      }
      if (r.warnings && r.warnings.length) wrap.append(h("details", null, h("summary", { class: "muted small" }, `${r.warnings.length} messages from Odoo`), errorList(r.warnings)));
      return wrap;
    }

    const c = S.check;
    if (!c) {
      wrap.append(h("div", { class: "notice info" }, h("span", null, "ℹ"), h("div", { class: "grow" },
        h("b", null, "Check first (recommended). "),
        "Odoo runs the whole import and rolls it back, reporting every row it would refuse. Nothing is saved.")));
      wrap.append(h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: () => runImport(true) }, "Check with Odoo"),
        h("span", { class: "muted small" }, `Then import ${a.stats.create + a.stats.update} records into ${S.modelName} (${S.session.db}).`)));
    } else if (c.noDryRun) {
      wrap.append(h("div", { class: "notice warn" }, h("span", null, "⚠"), h("div", { class: "grow" }, "This database has no import module (base_import), so a check isn't possible. The import runs batch by batch; a batch with an error is not saved.")));
    } else if (c.ok) {
      wrap.append(h("div", { class: "notice ok" }, h("span", { class: "big-ok" }, "✓"), h("div", { class: "grow" },
        h("b", null, "Odoo accepts every row."), h("div", null, `Ready to import ${a.stats.create + a.stats.update} records into ${S.modelName}.`),
        c.ms > 5000 ? h("div", { class: "small" }, `The check took ${duration(c.ms / 1000)}; the import should take about ${duration((c.ms / 1000) * (S.settings.fast ? 1.2 : 2.2))}${S.settings.fast ? "" : " (less in fast mode)"}.`) : null)));
      if (c.warnings.length) wrap.append(h("details", null, h("summary", { class: "muted small" }, `${c.warnings.length} messages from Odoo`), errorList(c.warnings)));
    } else {
      const rowsWithErrors = new Set(c.errors.filter((e) => e.row !== null && e.row !== undefined).map((e) => e.row));
      wrap.append(h("div", { class: "notice err" }, h("span", null, "✕"), h("div", { class: "grow" },
        h("b", null, `Odoo would refuse ${rowsWithErrors.size || c.errors.length} row${(rowsWithErrors.size || c.errors.length) > 1 ? "s" : ""}.`),
        h("div", null, "A batch containing an error isn't saved. Fix the file, go back to the review, or skip those rows."))));
      wrap.append(errorList(c.errors));
      wrap.append(h("div", { class: "row" },
        rowsWithErrors.size ? h("button", { type: "button", class: "btn", onclick: () => skipErrorRows(c) }, `Skip these ${rowsWithErrors.size} rows`) : null,
        rowsWithErrors.size ? h("button", { type: "button", class: "btn", onclick: () => downloadErrors(c) }, "Download them as CSV") : null,
        h("button", { type: "button", class: "btn ghost", onclick: () => runImport(true) }, "Check again")));
    }
    return wrap;
  }

  function startOver() {
    Object.assign(S, { book: null, job: null, analysis: null, check: null, result: null, reviewTab: "conflicts" });
    go("source");
  }

  // One record opens its form, several open the model's list (newest records first there).
  function openRecords(model, ids) {
    hide();
    if (location.pathname.startsWith("/odoo")) {
      location.href = ids.length === 1 ? `/odoo/${model}/${ids[0]}` : `/odoo/${model}?view_type=list`;
    } else {
      location.href = ids.length === 1 ? `/web#model=${model}&id=${ids[0]}&view_type=form` : `/web#model=${model}&view_type=list`;
    }
  }

  // ---------------------------------------------------------------------------
  // history and undo
  async function addHistory(job, result) {
    const entry = {
      id: `${Date.now()}`,
      origin: location.origin,
      db: S.session.db,
      model: job.model,
      modelName: S.modelName,
      file: job.file,
      at: Date.now(),
      created: result.created,
      updated: result.updated.length,
      deps: result.deps || [],
      undone: false,
    };
    S.history = [entry, ...S.history].slice(0, HISTORY_MAX);
    await store.set(K.history, S.history);
  }

  function undoButton(entry) {
    if (!entry || entry.undone || (!entry.created.length && !(entry.deps || []).length)) return null;
    const n = entry.created.length + (entry.deps || []).reduce((s, d) => s + d.ids.length, 0);
    let armed = false;
    let timer;
    const btn = h("button", { type: "button", class: "btn small danger", onclick: async () => {
      if (!armed) {
        armed = true;
        btn.textContent = `Delete ${n} records? Click again`;
        timer = setTimeout(() => { armed = false; btn.textContent = "Undo"; }, 4000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      btn.textContent = "Undoing…";
      const errors = await S.deps.executor.undo(entry);
      entry.undone = !errors.length;
      await store.set(K.history, S.history);
      toast(errors.length ? `Undo failed: ${errors[0]}` : `${n} records deleted`);
      if (!historySheet.hidden) openHistory();
      render();
    } }, "Undo");
    btn.title = entry.updated ? "Deletes the records this import created. Updated records keep their new values." : "Deletes the records this import created";
    return btn;
  }

  function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleString();
  }

  function openHistory() {
    const mine = S.history.filter((e) => e.origin === location.origin && (!S.session || e.db === S.session.db));
    historySheet.replaceChildren(
      h("h3", null, "Past imports", h("span", { class: "spacer" }), h("button", { type: "button", class: "icon-btn big", "aria-label": "Close history", onclick: () => { historySheet.hidden = true; } }, "×")),
      h("div", { class: "body" },
        mine.length
          ? mine.map((e) => h("div", { class: "hist" },
            h("div", { class: "what" }, h("b", null, `${e.modelName || e.model}`), ` · ${e.created.length} created, ${e.updated} updated`,
              h("small", null, `${e.file || ""} · ${timeAgo(e.at)}${e.undone ? " · undone" : ""}`)),
            undoButton(e)))
          : h("div", { class: "empty-state" }, "No imports on this database yet.")));
    historySheet.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // export
  const PURPOSES = {
    data: { title: "Data", icon: "📊", text: "To read, share or analyse. Starts with the columns of the list view; headers are the field labels." },
    reimport: { title: "For re-importing", icon: "✏️", text: "To edit and import back. Keeps the External ID so the same records are updated; headers are technical names." },
  };
  const expKey = (purpose) => `oi.export.${location.origin}|${S.session ? S.session.db : ""}|${S.model}|${purpose}`;

  function setMode(mode) {
    if (S.op || S.mode === mode) return;
    S.mode = mode;
    render();
    if (mode === "export") prepareExport();
    if (mode === "analyze") prepareAnalyze();
    // The page may show ticked records or a search: follow it as soon as the bridge answers.
    if (mode !== "import") followPage(mode);
  }

  async function followPage(mode) {
    let changed = await refreshPage();
    // The page shows other records (ticked or searched): follow its model, unless that would
    // throw away an import in progress (then scopeRow offers the switch).
    const p = S.page;
    if (p && p.model !== S.model && (p.selectedIds.length || p.domain.length) && !S.job && S.mode === mode && !S.op) {
      await setModel(p.model);
      await refreshPage();
      changed = true;
    }
    if (!changed || S.mode !== mode || S.op) return;
    render();
    if (mode === "export") prepareExport();
    else runAnalysis();
  }

  // Model changed or first visit: count the records, forget columns of another model.
  async function prepareExport() {
    const e = S.exp;
    if (!S.model || !S.session) return;
    if (e.model !== S.model) Object.assign(e, { model: S.model, purpose: null, columns: [], count: null, done: null });
    try {
      const schema = await S.deps.schemas.load(S.model);
      e.hasActive = schema.fields.has("active");
      e.count = await OI.export.count(S.client, S.model, { archived: e.archived, domain: domainOf() });
    } catch (err) {
      fail(err);
    }
    if (S.mode === "export") render();
  }

  async function choosePurpose(purpose, { reset = false } = {}) {
    const e = S.exp;
    e.purpose = purpose;
    e.done = null;
    setBusy("Choosing columns…");
    try {
      const saved = reset ? null : await store.get(expKey(purpose), null);
      const paths = saved || (await OI.export.defaultPaths(S.client, S.deps.schemas, S.model, purpose));
      e.columns = await OI.export.describe(S.deps.schemas, S.model, paths, purpose);
      setBusy("");
    } catch (err) {
      fail(err);
    }
    render();
  }

  function saveColumns() {
    store.set(expKey(S.exp.purpose), S.exp.columns.map((c) => c.path));
  }

  function moveColumn(i, d) {
    const cols = S.exp.columns;
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    saveColumns();
    render();
  }

  /* Field search: type to filter a model's fields; › (or →) opens a relation's fields
   * (Customer › Country). opts: {model, cls, placeholder, allow(f, depth), canOpen(f, depth),
   * extra(depth) -> fields shown first, marker(path, f) -> text|null,
   * onpick(path, f, labels)}. labels: the field labels along the path. */
  function fieldSearch(opts) {
    const { model, cls = "", placeholder = "Type to search a field…", allow = () => true, canOpen = (f, depth) => !!f.relation && depth < 2, extra = () => [], marker = () => null, onpick } = opts;
    const wrap = h("div", { class: `picker fieldsearch ${cls}`, "data-key": cls || "fieldsearch" });
    const input = h("input", { type: "search", placeholder, "aria-label": placeholder });
    const crumb = h("div", { class: "crumb", hidden: true });
    const list = h("ul", { class: "dropdown", hidden: true, role: "listbox" });
    let stack = [{ model, prefix: [], labels: [] }];
    let items = [];
    let sel = 0;
    let opened = false;
    const depth = () => stack.length - 1;
    const load = async () => {
      const top = stack[stack.length - 1];
      const schema = await S.deps.schemas.load(top.model);
      const q = norm(input.value);
      const fields = [...extra(depth()), ...[...schema.fields.values()].filter((f) => allow(f, depth()))];
      items = fields
        .filter((f) => !q || norm(f.string).includes(q) || norm(f.name).includes(q) || norm(f.stringEn).includes(q))
        .sort((a, b) => (a.type === "id") - (b.type === "id") || a.string.localeCompare(b.string))
        .slice(0, 80);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      crumb.hidden = stack.length === 1;
      crumb.replaceChildren(h("button", { type: "button", class: "btn small ghost", onmousedown: (ev) => { ev.preventDefault(); stack.pop(); load(); } }, "←"), top.labels.join(" › "));
      draw();
    };
    const draw = () => {
      const top = stack[stack.length - 1];
      list.replaceChildren(...items.map((f, i) => {
        const mark = marker([...top.prefix, f.name], f);
        return h("li", { class: i === sel ? "sel" : "", onmousedown: (ev) => { ev.preventDefault(); pick(f, ev.target.closest(".open") ? "open" : "add"); } },
          h("span", null, f.string), mark ? h("span", { class: "chip auto" }, mark) : null, h("span", { class: "tech" }, f.name),
          canOpen(f, depth()) ? h("span", { class: "open", title: `Fields of ${f.string}` }, "›") : null);
      }));
      list.hidden = !items.length || !opened;
      const cur = list.children[sel];
      if (cur) cur.scrollIntoView({ block: "nearest" });
    };
    const pick = async (f, how) => {
      const top = stack[stack.length - 1];
      if (how === "open" && canOpen(f, depth())) {
        stack.push({ model: f.relation, prefix: [...top.prefix, f.name], labels: [...top.labels, f.string] });
        input.value = "";
        sel = 0;
        await load();
        input.focus();
        return;
      }
      if (!allow(f, depth()) && f.type !== "id") return;
      const path = [...top.prefix, f.name];
      const labels = [...top.labels, f.string];
      stack = [{ model, prefix: [], labels: [] }];
      input.value = "";
      opened = false;
      list.hidden = true;
      await onpick(path, f, labels);
    };
    input.addEventListener("focus", () => { opened = true; load(); });
    input.addEventListener("input", () => { opened = true; sel = 0; load(); });
    input.addEventListener("blur", () => setTimeout(() => { opened = false; list.hidden = true; }, 150));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); ev.preventDefault(); }
      else if (ev.key === "Enter" && items[sel]) { pick(items[sel], "add"); ev.preventDefault(); }
      else if (ev.key === "ArrowRight" && items[sel] && canOpen(items[sel], depth())) { pick(items[sel], "open"); ev.preventDefault(); }
      else if (ev.key === "Backspace" && !input.value && stack.length > 1) { stack.pop(); load(); }
    });
    wrap.append(crumb, input, list);
    return wrap;
  }

  // Export: add a column.
  function fieldAdder() {
    const e = S.exp;
    const reimport = e.purpose === "reimport";
    const taken = () => new Set(e.columns.map((c) => c.path.join("/")));
    return fieldSearch({
      model: S.model,
      cls: "adder",
      placeholder: "Add a field: type to search…",
      allow: (f, depth) => f.type !== "binary" && f.type !== "properties_definition" && (!reimport || f.importable) && !(reimport && depth > 0 && f.type === "one2many"),
      canOpen: (f, depth) => !!f.relation && depth < 2,
      extra: (depth) => (depth === 0 ? [OI.schema.ID_FIELD] : []),
      marker: (path, f) => {
        const has = taken();
        return has.has(path.join("/")) || (f.type === "one2many" && [...has].some((k) => k.startsWith(`${f.name}/`))) ? "added" : null;
      },
      onpick: async (path, f) => {
        if (taken().has(path.join("/"))) return toast("Already in the list");
        if (f.type === "one2many" && e.purpose === "data" && path.length === 1) {
          // A lines field brings its useful columns (Order Lines -> Product, Quantity, Price…),
          // one row per line. Only for data: re-importing lines onto existing records adds them again.
          const has = taken();
          const paths = (await OI.export.linePaths(S.client, S.deps.schemas, S.model, f)).filter((x) => !has.has(x.join("/")));
          const cols = await OI.export.describe(S.deps.schemas, S.model, paths, e.purpose);
          e.columns.push(...cols);
          toast(cols.length ? `Added ${f.string}: ${cols.map((c) => c.fields[c.fields.length - 1].string).join(", ")}` : "Already in the list");
        } else {
          const [col] = await OI.export.describe(S.deps.schemas, S.model, [path], e.purpose);
          if (col) e.columns.push(col);
        }
        saveColumns();
        render();
        const again = body.querySelector(".adder input");
        if (again) again.focus();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // filters (shared by Export and Analyze): conditions on any field, all must match
  const FILTER_SKIP = new Set(["binary", "json", "properties", "properties_definition", "html", "id", "dbid", "reference", "many2one_reference"]);
  // The records Export and Analyze work on: the scope (all, the list's search, the ticked ones) and the filter.
  function scopeDomain() {
    const p = pageScope();
    if (!p || S.scope === "all") return [];
    if (S.scope === "selected" && p.selectedIds.length) return [["id", "in", p.selectedIds]];
    if (S.scope === "search") return p.domain;
    return [];
  }
  const domainOf = (filters = S.filters) => OI.domain.and(scopeDomain(), OI.domain.toDomain(filters));

  // "Records: All · The list's current search · The 3 ticked records" (only what the page offers).
  function scopeRow(onchange) {
    const other = S.page && S.page.model !== S.model && (S.page.selectedIds.length || S.page.domain.length) ? S.page : null;
    if (other) {
      const what = other.selectedIds.length && !other.domainSelected ? `${other.selectedIds.length} ticked record${other.selectedIds.length > 1 ? "s" : ""}` : "a filtered list";
      return h("div", { class: "notice info" }, h("span", null, "ℹ"), h("div", { class: "grow" }, `The page shows ${what} of another model (${other.model}).`),
        h("button", { type: "button", class: "btn small", onclick: async () => { await setModel(other.model); await refreshPage(); render(); onchange(); } }, "Use them"));
    }
    const p = pageScope();
    if (!p) return null;
    const opts = [["all", "All records"]];
    if (p.domain.length) opts.push(["search", "The list's current search"]);
    if (p.selectedIds.length && !p.domainSelected) opts.push(["selected", `The ${p.selectedIds.length} ticked record${p.selectedIds.length > 1 ? "s" : ""}`]);
    if (opts.length === 1) return null;
    return h("div", { class: "field-row scope" }, h("label", null, "Records"),
      h("div", { class: "segmented", role: "radiogroup", "aria-label": "Records" }, opts.map(([k, l]) =>
        h("button", { type: "button", role: "radio", "aria-checked": S.scope === k ? "true" : "false", class: S.scope === k ? "on" : "", onclick: () => { S.scope = k; onchange(); } }, l))));
  }

  const scopeText = () => (S.scope === "selected" && pageScope() ? `${pageScope().selectedIds.length} ticked records` : S.scope === "search" && pageScope() ? "the list's current search" : "");
  let filterTimer;

  function filterBox(onchange) {
    const changed = (now) => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(onchange, now ? 0 : 400);
    };
    const box = h("div", { class: "filters" });
    S.filters.forEach((c, i) => box.append(filterRow(c, i, changed)));
    box.append(fieldSearch({
      model: S.model,
      cls: "filter-add",
      placeholder: S.filters.length ? "+ Add another condition…" : "+ Filter: type a field (Status, Date, Customer › Country…)",
      allow: (f) => f.store && !FILTER_SKIP.has(f.type),
      canOpen: (f, depth) => f.type === "many2one" && depth < 2,
      onpick: (path, f, labels) => {
        const op = OI.domain.operators(f.type)[0][0];
        S.filters.push({ path, type: f.type, op, value: f.type === "selection" || ["many2one", "many2many", "one2many"].includes(f.type) ? [] : "", label: labels.join(" › "),
          relation: f.relation || null, selection: f.selection || null });
        render();
        if (OI.domain.NO_VALUE.has(op)) changed(true);
        const inputs = body.querySelectorAll(".filter-row");
        const last = inputs[inputs.length - 1];
        const focus = last && last.querySelector("input:not([type=checkbox]), select");
        if (focus) focus.focus();
      },
    }));
    if (S.filters.length > 1) box.append(h("button", { type: "button", class: "btn small ghost", onclick: () => { S.filters = []; render(); changed(true); } }, "Clear filters"));
    return box;
  }

  function filterRow(c, i, changed) {
    const ops = OI.domain.operators(c.type);
    const opSel = h("select", { "aria-label": `${c.label}: condition`, onchange: () => {
      c.op = opSel.value;
      if (["between"].includes(c.op)) c.value = ["", ""];
      else if (!Array.isArray(c.value) || ["ilike", "after", "before"].includes(c.op)) c.value = ["in", "not in"].includes(c.op) ? [] : "";
      render();
      changed(true);
    } }, ops.map(([k, l]) => h("option", { value: k, selected: k === c.op }, l)));
    const row = h("div", { class: "filter-row" }, h("span", { class: "label" }, c.label), opSel);
    const val = h("span", { class: "value" });
    const date = c.type === "date" || c.type === "datetime";
    const number = ["integer", "float", "monetary"].includes(c.type);
    const input = (attrs, get, set) => {
      const el = h("input", attrs);
      el.value = get() ?? "";
      el.addEventListener(attrs.type === "date" ? "change" : "input", () => { set(el.value); changed(attrs.type === "date"); });
      return el;
    };
    if (OI.domain.NO_VALUE.has(c.op)) {
      // nothing to type
    } else if (c.op === "between") {
      if (!Array.isArray(c.value)) c.value = ["", ""];
      const type = date ? "date" : "number";
      val.append(input({ type, "aria-label": "From" }, () => c.value[0], (v) => { c.value[0] = v; }), " and ", input({ type, "aria-label": "To" }, () => c.value[1], (v) => { c.value[1] = v; }));
    } else if (date) {
      val.append(input({ type: "date", "aria-label": c.label }, () => c.value, (v) => { c.value = v; }));
    } else if (c.type === "selection" && (c.op === "in" || c.op === "not in")) {
      for (const [k, l] of c.selection || []) {
        const on = (c.value || []).some((x) => x.id === k);
        val.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: on, onchange: (ev) => {
          c.value = (c.value || []).filter((x) => x.id !== k);
          if (ev.target.checked) c.value.push({ id: k, label: l });
          changed(true);
        } }), l));
      }
    } else if (c.relation && (c.op === "in" || c.op === "not in")) {
      for (const r of c.value || []) {
        val.append(h("span", { class: "tag" }, r.label, h("button", { type: "button", "aria-label": `Remove ${r.label}`, onclick: () => { c.value = c.value.filter((x) => x.id !== r.id); render(); changed(true); } }, "×")));
      }
      val.append(searchInline(c.relation, (id, label) => {
        if (!(c.value || []).some((x) => x.id === id)) c.value = [...(c.value || []), { id, label }];
        render();
        changed(true);
      }, "Search…"));
    } else {
      val.append(input({ type: number ? "number" : "text", "aria-label": c.label, step: "any" }, () => c.value, (v) => { c.value = v; }));
    }
    row.append(val, h("button", { type: "button", class: "icon-btn remove", "aria-label": `Remove the ${c.label} condition`, onclick: () => { S.filters.splice(i, 1); render(); changed(true); } }, "×"));
    return row;
  }

  function renderExport() {
    const e = S.exp;
    const wrap = h("div", { class: "export" });
    wrap.append(h("div", { class: "field-row" }, h("label", null, "Export from"), modelPicker(),
      e.count !== null ? h("span", { class: "muted count" }, `${e.count.toLocaleString()} record${e.count === 1 ? "" : "s"}${S.filters.length ? " match" : ""}`) : null,
      e.hasActive ? h("label", { class: "row small" }, h("input", { type: "checkbox", checked: e.archived, onchange: (ev) => { e.archived = ev.target.checked; prepareExport(); } }), "Include archived") : null));
    if (!S.model) return wrap;
    const scope = scopeRow(() => { render(); prepareExport(); });
    if (scope) wrap.append(scope);
    wrap.append(filterBox(() => prepareExport()));

    if (!e.purpose) {
      wrap.append(h("h2", null, "What is the file for?"),
        h("div", { class: "choices" }, Object.entries(PURPOSES).map(([k, p]) =>
          h("button", { type: "button", class: "choice", onclick: () => choosePurpose(k) },
            h("span", { class: "icon" }, p.icon), h("b", null, p.title), h("span", { class: "muted small" }, p.text)))));
      return wrap;
    }

    const p = PURPOSES[e.purpose];
    wrap.append(h("div", { class: "row", style: "margin-bottom:10px" },
      h("span", { class: "chip manual" }, `${p.icon} ${p.title}`),
      h("button", { type: "button", class: "btn small ghost", onclick: () => { e.purpose = null; e.done = null; render(); } }, "Change"),
      h("span", { class: "spacer" }),
      h("span", { class: "muted small" }, `${e.columns.length} column${e.columns.length === 1 ? "" : "s"}`),
      h("button", { type: "button", class: "btn small ghost", onclick: () => choosePurpose(e.purpose, { reset: true }) }, "Reset to default")));

    const list = h("ol", { class: "columns" });
    e.columns.forEach((c, i) => list.append(h("li", null,
      h("span", { class: "grip" }, i + 1),
      h("span", { class: "label" }, c.label),
      h("span", { class: "tech" }, c.path.join("/")),
      h("button", { type: "button", class: "icon-btn", title: "Move up", "aria-label": `Move ${c.label} up`, disabled: i === 0, onclick: () => moveColumn(i, -1) }, "↑"),
      h("button", { type: "button", class: "icon-btn", title: "Move down", "aria-label": `Move ${c.label} down`, disabled: i === e.columns.length - 1, onclick: () => moveColumn(i, 1) }, "↓"),
      h("button", { type: "button", class: "icon-btn remove", title: "Remove", "aria-label": `Remove ${c.label}`, onclick: () => { e.columns.splice(i, 1); saveColumns(); render(); } }, "×"))));
    wrap.append(list, fieldAdder());
    if (e.purpose === "reimport" && !e.columns.some((c) => c.path[0] === "id")) {
      wrap.append(h("div", { class: "notice warn" }, h("span", null, "⚠"), h("div", { class: "grow" }, "Without the External ID column, importing the file back creates new records instead of updating these.")));
    }

    wrap.append(h("div", { class: "field-row", style: "margin-top:14px" }, h("label", null, "Format"),
      ...[["xlsx", "Excel (.xlsx)"], ["csv", "CSV"]].map(([k, l]) => h("label", { class: "row small" },
        h("input", { type: "radio", name: "oi-format", checked: e.format === k, onchange: () => { e.format = k; S.settings.exportFormat = k; store.set(K.settings, S.settings); renderFooter(); } }), l))));

    if (e.done) {
      wrap.append(h("div", { class: "notice ok" }, h("span", { class: "big-ok" }, "✓"), h("div", { class: "grow" },
        h("b", null, `Exported ${e.done.records.toLocaleString()} records`), e.done.rows !== e.done.records ? ` (${e.done.rows.toLocaleString()} rows, with lines)` : "", ".",
        h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "small" }, e.done.name),
          h("button", { type: "button", class: "btn small", onclick: () => download(e.done.url, e.done.name) }, "Download again")))));
    }
    return wrap;
  }

  function download(url, name) {
    const a = h("a", { href: url, download: name });
    shadow.append(a);
    a.click();
    a.remove();
  }

  function runExport() {
    const e = S.exp;
    if (!e.purpose || !e.columns.length) return;
    return task("export", "Exporting…", async (op) => {
      const data = await OI.export.fetchRows(op.client, S.model, e.columns, {
        archived: e.archived,
        domain: domainOf(),
        signal: op.ctrl.signal,
        onProgress: (p) => alive(op) && setBusy(`Exporting… ${p.done.toLocaleString()} / ${p.total.toLocaleString()} records`),
      });
      if (!alive(op)) return;
      setBusy("Writing the file…");
      const blob = await OI.export.toBlob(data, e.format, S.modelName);
      if (!alive(op)) return;
      const day = new Date().toISOString().slice(0, 10);
      const name = `${S.modelName.replace(/[\\/:*?"<>|]+/g, " ")}${e.purpose === "reimport" ? " (for import)" : ""} ${day}.${e.format}`;
      if (e.done) URL.revokeObjectURL(e.done.url);
      e.done = { records: data.records, rows: data.rows.length, name, url: URL.createObjectURL(blob) };
      saveColumns();
      download(e.done.url, name);
      endTask();
      setBusy("");
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // analyze: group records, chart them, save the chart as an image, Excel or PDF
  const GROUPABLE = new Set(["many2one", "selection", "boolean", "char", "date", "datetime", "many2many", "integer"]);
  const NUMERIC = new Set(["integer", "float", "monetary"]);
  const CHART_TYPES = [["auto", "Auto"], ["bar", "Columns"], ["hbar", "Bars"], ["line", "Line"], ["pie", "Pie"], ["donut", "Donut"]];
  const AGGS = [["sum", "Sum"], ["avg", "Average"], ["min", "Minimum"], ["max", "Maximum"]];
  const anKey = () => `oi.analyses.${location.origin}|${S.session ? S.session.db : ""}`;

  const groupBy = (path, f, labels) => ({ path, label: labels.join(" › "), field: { name: f.name, type: f.type, selection: f.selection || null }, granularity: f.type === "date" || f.type === "datetime" ? "month" : null });

  // A sensible first grouping for a model: customer, salesperson, status, stage…
  async function defaultGroup(model) {
    const schema = await S.deps.schemas.load(model);
    const ok = (n) => schema.fields.has(n) && schema.fields.get(n).store && GROUPABLE.has(schema.fields.get(n).type);
    const name = ["partner_id", "user_id", "state", "stage_id", "country_id", "categ_id", "team_id", "company_id"].find(ok)
      || [...schema.fields.values()].find((f) => f.store && ["many2one", "selection"].includes(f.type) && !/^(create_uid|write_uid|currency_id|company_id)$/.test(f.name))?.name
      || (ok("create_date") ? "create_date" : null);
    if (!name) return null;
    const f = schema.fields.get(name);
    return groupBy([name], f, [f.string]);
  }

  async function prepareAnalyze() {
    const a = S.an;
    if (!S.model || !S.session) return render();
    if (a.model !== S.model) {
      Object.assign(a, { model: S.model, groupby: null, split: null, measure: { agg: "count" }, chart: "auto", compare: "none", result: null, count: null });
      a.groupby = await defaultGroup(S.model).catch(() => null);
    }
    try {
      const schema = await S.deps.schemas.load(S.model);
      a.hasActive = schema.fields.has("active");
      a.measures = [...schema.fields.values()].filter((f) => f.store && NUMERIC.has(f.type) && f.name !== "id" && f.name !== "sequence").sort((x, y) => x.string.localeCompare(y.string));
      a.saved = (await store.get(anKey(), [])).filter((x) => x.model === S.model);
    } catch (err) {
      fail(err);
    }
    render();
    runAnalysis();
  }

  function analysisSpec() {
    const a = S.an;
    const measure = a.measure.agg === "count" ? { agg: "count" } : { agg: a.measure.agg, field: { name: a.measure.field } };
    return { model: S.model, domain: domainOf(), archived: a.archived, groupby: [a.groupby, ...(a.split ? [a.split] : [])], measure };
  }

  const measureLabel = () => {
    const a = S.an;
    if (a.measure.agg === "count") return "Count";
    const f = (a.measures || []).find((x) => x.name === a.measure.field);
    return `${Object.fromEntries(AGGS)[a.measure.agg]} of ${f ? f.string : a.measure.field}`;
  };

  /* What a comparison compares: the period of the first date condition of the filter, and the
   * period before it (or a year earlier). null when there is no such condition. */
  function compareInfo(how = S.an.compare) {
    if (!how || how === "none" || S.an.split) return null;
    const i = S.filters.findIndex((c) => OI.domain.rangeOf(c));
    if (i < 0) return null;
    const c = S.filters[i];
    const range = OI.domain.rangeOf(c);
    const other = OI.domain.compareRange(c, how);
    if (!range || !other) return null;
    const filters = S.filters.map((x, k) => (k === i ? { ...x, op: "range", value: other } : x));
    return { index: i, field: c.label, range, other, filters, labels: [OI.domain.rangeLabel(range), OI.domain.rangeLabel(other)] };
  }

  function runAnalysis() {
    const a = S.an;
    if (!a.groupby) return;
    if (S.op) {
      // A newer request wins over an analysis still running; after anything else, run again.
      if (S.op.kind !== "analyze") {
        a.rerun = true;
        return;
      }
      S.op.ctrl.abort();
      endTask();
    }
    a.rerun = false;
    a.loading = true;
    renderAnalyzeChart();
    return task("analyze", "Grouping records…", async (op) => {
      const spec = analysisSpec();
      const cmp = compareInfo();
      const [res, count, prev] = await Promise.all([
        OI.analyze.group(op.client, spec, { signal: op.ctrl.signal }),
        OI.export.count(op.client, S.model, { archived: a.archived, domain: spec.domain }),
        cmp ? OI.analyze.group(op.client, { ...spec, domain: domainOf(cmp.filters) }, { signal: op.ctrl.signal }) : null,
      ]);
      if (!alive(op)) return;
      a.result = { ...res, spec, prev: prev ? prev.groups : null, compareLabels: cmp ? cmp.labels : null };
      a.count = count;
      a.loading = false;
      endTask();
      setBusy(res.via === "browser" ? (res.truncated ? "Grouped in the browser from the first 50,000 records." : "") : "");
      render();
    });
  }

  // The chart's data for the chosen form (pies keep 5 slices + Others).
  function chartData() {
    const a = S.an;
    if (!a.result) return null;
    const chronological = !!a.groupby.granularity;
    if (a.result.prev && !a.split) {
      // Two periods side by side: this one in the series color, the other in gray.
      const [now, before] = a.result.compareLabels;
      const data = OI.analyze.compare(a.result.groups, a.result.prev, { top: a.top, chronological, agg: a.result.spec.measure.agg, labels: [now, before] });
      let type = a.chart === "auto" || a.chart === "pie" || a.chart === "donut" ? null : a.chart;
      if (!type) type = chronological ? "line" : data.categories.length > 8 || data.categories.some((c) => c.label.length > 14) ? "hbar" : "bar";
      const filters = [scopeText(), ...S.filters.filter((_, k) => k !== compareInfo().index).map((c) => OI.domain.describe(c, c.label))].filter(Boolean).join(" · ");
      return {
        data: { ...data, measureLabel: measureLabel() }, type,
        title: `${measureLabel()} by ${a.groupby.label}: ${now} vs ${before}`,
        subtitle: [S.modelName, `${compareInfo().field} ${now} compared with ${before}`, filters].filter(Boolean).join(" · "),
      };
    }
    let type = a.chart === "auto" ? null : a.chart;
    const split = !!a.split;
    if (split && (type === "pie" || type === "donut")) type = null;
    const top = type === "pie" || type === "donut" ? Math.min(a.top, 5) : a.top;
    let data = OI.analyze.pivot(a.result.groups, { top, chronological, agg: a.result.spec.measure.agg });
    if (!type) {
      type = OI.chart.suggest({ categories: data.categories, split, chronological });
      if (type === "pie" && data.categories.length > 6) data = OI.analyze.pivot(a.result.groups, { top: 5, chronological, agg: a.result.spec.measure.agg });
    }
    const title = `${measureLabel()} by ${a.groupby.label}${a.split ? ` and ${a.split.label}` : ""}`;
    const filters = [scopeText(), ...S.filters.map((c) => OI.domain.describe(c, c.label))].filter(Boolean).join(" · ");
    const subtitle = [S.modelName, filters || (a.archived ? "all records, archived included" : "all records"), `${(a.count ?? 0).toLocaleString()} records`].join(" · ");
    return { data: { ...data, measureLabel: measureLabel() }, type, title, subtitle };
  }

  const theme = () => (host.getAttribute("data-theme") === "dark" ? "dark" : "light");

  function renderAnalyzeChart() {
    const box = body.querySelector(".chart-box");
    if (!box) return;
    box.classList.toggle("loading", !!S.an.loading);
  }

  function chartBox() {
    const box = h("div", { class: `chart-box${S.an.loading ? " loading" : ""}` });
    const cd = chartData();
    if (!cd) {
      box.append(h("div", { class: "empty-state" }, S.an.groupby ? "Grouping…" : "Choose how to group the records."));
      return box;
    }
    const width = Math.max(480, (body.clientWidth || 960) - 80);
    const { svg } = OI.chart.render(cd.data, { type: cd.type, width, theme: theme(), title: cd.title, subtitle: cd.subtitle });
    const tip = h("div", { class: "tooltip", hidden: true, role: "tooltip" });
    box.append(svg, tip);
    let cross = null;
    const show = (mark, x, y) => {
      if (!mark || !mark.__tip) return hide();
      tip.replaceChildren(h("div", { class: "t" }, mark.__tip.title),
        ...mark.__tip.rows.map((r) => h("div", { class: "r" }, h("span", { class: "key", style: `background:${r.color}` }), h("b", null, r.value), h("span", null, r.label || ""))));
      tip.hidden = false;
      const bw = box.clientWidth;
      tip.style.left = `${Math.min(x + 14, bw - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
      if (cross) cross.el.setAttribute("visibility", "hidden");
      if (mark.__cross) {
        cross = mark.__cross;
        cross.el.setAttribute("x1", cross.x);
        cross.el.setAttribute("x2", cross.x);
        cross.el.setAttribute("visibility", "visible");
      }
      for (const m of svg.querySelectorAll(".mark.hover")) m.classList.remove("hover");
      mark.classList.add("hover");
    };
    const hide = () => {
      tip.hidden = true;
      if (cross) cross.el.setAttribute("visibility", "hidden");
      for (const m of svg.querySelectorAll(".mark.hover")) m.classList.remove("hover");
    };
    svg.addEventListener("pointermove", (ev) => {
      const r = box.getBoundingClientRect();
      show(ev.target.closest && ev.target.closest(".mark"), ev.clientX - r.left, ev.clientY - r.top);
    });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focusin", (ev) => {
      const r = box.getBoundingClientRect();
      const m = ev.target.getBoundingClientRect();
      show(ev.target.closest(".mark"), m.left - r.left + m.width / 2, m.top - r.top);
    });
    svg.addEventListener("focusout", hide);
    return box;
  }

  // The numbers under the chart (also the accessible view of it).
  function chartTable(cd) {
    const { data } = cd;
    if (data.compare) {
      const [now, before] = [data.series[0], data.series[1]];
      const change = (i) => now.values[i] - before.values[i];
      const pct = (i) => (before.values[i] ? (change(i) / Math.abs(before.values[i])) * 100 : null);
      const arrow = (v) => (v > 0 ? "▲ " : v < 0 ? "▼ " : "");
      const head = h("tr", null, h("th", null, S.an.groupby.label), h("th", { class: "n" }, now.label), h("th", { class: "n" }, before.label), h("th", { class: "n" }, "Change"), h("th", { class: "n" }, "Change %"));
      const rows = data.categories.map((c, i) => h("tr", null, h("td", null, c.label), h("td", { class: "n" }, fmt(now.values[i])), h("td", { class: "n" }, fmt(before.values[i])),
        h("td", { class: "n" }, `${arrow(change(i))}${change(i) > 0 ? "+" : ""}${fmt(change(i))}`),
        h("td", { class: "n" }, pct(i) === null ? "new" : `${pct(i) > 0 ? "+" : ""}${pct(i).toFixed(1)}%`)));
      return h("div", { class: "table-wrap", style: "max-height: 280px; margin-top: 12px" }, h("table", { class: "grid numbers" }, h("thead", null, head), h("tbody", null, rows)));
    }
    const many = data.series.length > 1;
    const total = (i) => data.series.reduce((a, s2) => a + s2.values[i], 0);
    const sum = data.series[0] ? data.series[0].values.reduce((a, b) => a + b, 0) : 0;
    const share = !many && (S.an.measure.agg === "count" || S.an.measure.agg === "sum") && sum > 0;
    const head = h("tr", null, h("th", null, S.an.groupby.label), ...(many ? data.series.map((s2) => h("th", { class: "n" }, s2.label)) : [h("th", { class: "n" }, data.measureLabel)]),
      many && S.an.measure.agg !== "avg" ? h("th", { class: "n" }, "Total") : null, share ? h("th", { class: "n" }, "Share") : null);
    const rows = data.categories.map((c, i) => h("tr", null, h("td", null, c.label),
      ...data.series.map((s2) => h("td", { class: "n" }, fmt(s2.values[i]))),
      many && S.an.measure.agg !== "avg" ? h("td", { class: "n" }, fmt(total(i))) : null,
      share ? h("td", { class: "n" }, `${((data.series[0].values[i] / sum) * 100).toFixed(1)}%`) : null));
    return h("div", { class: "table-wrap", style: "max-height: 280px; margin-top: 12px" }, h("table", { class: "grid numbers" }, h("thead", null, head), h("tbody", null, rows)));
  }

  const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

  // Compare with: the period before, or a year earlier (needs a date filter, one grouping).
  function compareControl() {
    const a = S.an;
    const hasRange = S.filters.some((c) => OI.domain.rangeOf(c));
    const why = a.split ? "Remove “Then by” to compare periods" : !hasRange ? "Add a date filter first (e.g. Order Date › this month): the comparison uses its period" : "";
    const sel = h("select", { "aria-label": "Compare with", disabled: !!why, title: why, onchange: () => { a.compare = sel.value; runAnalysis(); } },
      [["none", "nothing"], ["previous", "the previous period"], ["year", "the same period last year"]].map(([k, l]) => h("option", { value: k, selected: (why ? "none" : a.compare) === k }, l)));
    const info = compareInfo();
    return h("div", { class: "ctl" }, h("label", null, "Compare"), sel,
      info ? h("span", { class: "muted small" }, `${info.labels[0]} vs ${info.labels[1]}`) : why ? h("span", { class: "muted small" }, why) : null);
  }

  function pickerChip(label, onclear) {
    return h("span", { class: "chip manual" }, label, onclear ? h("button", { type: "button", class: "chip-x", "aria-label": `Remove ${label}`, onclick: onclear }, "×") : null);
  }

  function groupField(cls, placeholder, onpick) {
    return fieldSearch({
      model: S.model,
      cls,
      placeholder,
      allow: (f) => f.store && GROUPABLE.has(f.type) && f.name !== "id",
      canOpen: (f, depth) => f.type === "many2one" && depth < 2,
      onpick: (path, f, labels) => onpick(groupBy(path, f, labels)),
    });
  }

  function renderAnalyze() {
    const a = S.an;
    const wrap = h("div", { class: "analyze" });
    wrap.append(h("div", { class: "field-row" }, h("label", null, "Analyze"), modelPicker(),
      a.count !== null && a.count !== undefined ? h("span", { class: "muted count" }, `${a.count.toLocaleString()} record${a.count === 1 ? "" : "s"}${S.filters.length ? " match" : ""}`) : null,
      a.hasActive ? h("label", { class: "row small" }, h("input", { type: "checkbox", checked: !!a.archived, onchange: (ev) => { a.archived = ev.target.checked; runAnalysis(); } }), "Include archived") : null));
    if (!S.model) return wrap;
    if (a.saved && a.saved.length) {
      wrap.append(h("div", { class: "row saved" }, h("span", { class: "muted small" }, "Saved:"), a.saved.map((x) => h("span", { class: "chip memory" },
        h("button", { type: "button", class: "chip-open", onclick: () => loadAnalysis(x) }, x.name),
        h("button", { type: "button", class: "chip-x", "aria-label": `Delete ${x.name}`, onclick: () => deleteAnalysis(x) }, "×")))));
    }
    const scope = scopeRow(() => { render(); runAnalysis(); });
    if (scope) wrap.append(scope);
    wrap.append(filterBox(() => runAnalysis()));

    const controls = h("div", { class: "controls" });
    const gran = a.groupby && a.groupby.granularity
      ? h("select", { "aria-label": "Period", onchange: (ev) => { a.groupby.granularity = ev.target.value; runAnalysis(); } },
        [["day", "by day"], ["week", "by week"], ["month", "by month"], ["quarter", "by quarter"], ["year", "by year"]].map(([k, l]) => h("option", { value: k, selected: a.groupby.granularity === k }, l)))
      : null;
    controls.append(
      h("div", { class: "ctl" }, h("label", null, "Group by"), a.groupby ? pickerChip(a.groupby.label) : null, gran,
        groupField("groupby", a.groupby ? "Change…" : "Type a field: Customer, Status, Customer › Country…", (g) => { a.groupby = g; a.chart = "auto"; runAnalysis(); })),
      h("div", { class: "ctl" }, h("label", null, "Then by"), a.split ? pickerChip(a.split.label, () => { a.split = null; runAnalysis(); }) : null,
        a.split && a.split.granularity ? h("select", { "aria-label": "Period", onchange: (ev) => { a.split.granularity = ev.target.value; runAnalysis(); } },
          [["month", "by month"], ["quarter", "by quarter"], ["year", "by year"]].map(([k, l]) => h("option", { value: k, selected: a.split.granularity === k }, l))) : null,
        groupField("splitby", a.split ? "Change…" : "Optional: a second field (stacked)", (g) => { a.split = g; runAnalysis(); })),
      h("div", { class: "ctl" }, h("label", null, "Measure"),
        h("select", { "aria-label": "Measure", onchange: (ev) => {
          const [agg, field] = ev.target.value.split(":");
          a.measure = agg === "count" ? { agg: "count" } : { agg, field };
          runAnalysis();
        } }, h("option", { value: "count", selected: a.measure.agg === "count" }, "Count of records"),
        (a.measures || []).flatMap((f) => AGGS.slice(0, 2).map(([agg, l]) => h("option", { value: `${agg}:${f.name}`, selected: a.measure.agg === agg && a.measure.field === f.name }, `${l} of ${f.string}`)))),
        h("label", null, "Show"),
        h("select", { "aria-label": "Groups shown", onchange: (ev) => { a.top = Number(ev.target.value); render(); } },
          [[5, "top 5"], [10, "top 10"], [20, "top 20"], [50, "top 50"], [500, "all"]].map(([k, l]) => h("option", { value: k, selected: a.top === k }, l)))),
      compareControl());
    wrap.append(controls);

    const cd = chartData();
    const types = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Chart type" }, CHART_TYPES.map(([k, l]) => {
      const off = (a.split || compareInfo()) && (k === "pie" || k === "donut");
      return h("button", { type: "button", role: "radio", "aria-checked": a.chart === k ? "true" : "false", class: `${a.chart === k ? "on" : ""}${cd && a.chart === "auto" && cd.type === k ? " suggested" : ""}`, disabled: off, title: off ? "Pies show one grouping: remove “Then by”" : "", onclick: () => { a.chart = k; render(); } }, l);
    }));
    const actions = h("div", { class: "row" },
      h("button", { type: "button", class: "btn small", disabled: !cd, onclick: () => saveImage("png") }, "PNG"),
      h("button", { type: "button", class: "btn small", disabled: !cd, onclick: () => saveImage("copy") }, "Copy image"),
      h("button", { type: "button", class: "btn small", disabled: !cd, onclick: () => saveExcel() }, "Excel with chart"),
      h("button", { type: "button", class: "btn small", disabled: !cd, onclick: () => printChart() }, "Print / PDF"),
      h("button", { type: "button", class: "btn small ghost", disabled: !cd, onclick: () => saveAnalysisPrompt() }, "Save analysis"));
    wrap.append(h("div", { class: "row chart-bar" }, types, h("span", { class: "spacer" }), actions));
    wrap.append(chartBox());
    if (cd && cd.data.categories.length) wrap.append(chartTable(cd));
    return wrap;
  }

  // ---- outputs (always drawn in the light theme: images and paper are light)
  function exportSvg() {
    const cd = chartData();
    return { cd, ...OI.chart.render(cd.data, { type: cd.type, width: 900, theme: "light", title: cd.title, subtitle: cd.subtitle }) };
  }

  async function svgToPng(svg, scale = 2) {
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = Number(svg.getAttribute("width"));
      const ht = Number(svg.getAttribute("height"));
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = ht * scale;
      const g = canvas.getContext("2d");
      g.scale(scale, scale);
      g.drawImage(img, 0, 0, w, ht);
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const fileBase = (cd) => `${cd.title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)} ${new Date().toISOString().slice(0, 10)}`;

  async function saveImage(how) {
    try {
      const { svg, cd } = exportSvg();
      const png = await svgToPng(svg);
      if (how === "copy") {
        if (!navigator.clipboard || !globalThis.ClipboardItem) throw new Error("Copying images needs HTTPS: use PNG instead.");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        return toast("Chart copied");
      }
      const url = URL.createObjectURL(png);
      S.an.lastFile = { name: `${fileBase(cd)}.png`, blob: png };
      download(url, `${fileBase(cd)}.png`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      fail(err);
    }
  }

  async function saveExcel() {
    try {
      const cd = chartData();
      const { data } = cd;
      const many = data.series.length > 1;
      const headers = [S.an.groupby.label, ...(many ? data.series.map((x) => x.label) : [data.measureLabel])];
      const rows = data.categories.map((c, i) => [c.label, ...data.series.map((x) => x.values[i])]);
      const pal = OI.chart.THEMES.light;
      const pie = cd.type === "pie" || cd.type === "donut";
      const colors = pie ? data.categories.map((c, i) => (c.others ? pal.others : pal.series[i % 8])) : data.series.map((x, i) => (x.others || x.compare ? pal.others : many ? pal.series[i % 8] : pal.series[0]));
      const type = { bar: "col", hbar: "bar", line: "line", pie: "pie", donut: "doughnut" }[cd.type];
      const blob = await OI.xlsxwriter.workbook({ headers, rows, types: ["text", ...headers.slice(1).map(() => "number")], sheetName: "Data",
        chart: { type, stacked: many && !data.compare && (type === "col" || type === "bar"), title: cd.title, colors } });
      const url = URL.createObjectURL(blob);
      S.an.lastFile = { name: `${fileBase(cd)}.xlsx`, blob };
      download(url, `${fileBase(cd)}.xlsx`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      fail(err);
    }
  }

  function printChart() {
    const { svg, cd } = exportSvg();
    const doc = document.implementation.createHTMLDocument(cd.title);
    const style = doc.createElement("style");
    style.textContent = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b0b0b;margin:0}
      svg{max-width:100%;height:auto} table{border-collapse:collapse;margin-top:18px;font-size:12px;min-width:50%}
      th,td{border-bottom:1px solid #e1e0d9;padding:4px 10px;text-align:left} .n{text-align:right;font-variant-numeric:tabular-nums}
      @page{margin:14mm}`;
    doc.head.append(style);
    doc.body.append(doc.importNode(svg, true));
    const table = chartTable(cd).querySelector("table");
    doc.body.append(doc.importNode(table, true));
    const frame = h("iframe", { class: "print-frame", title: "Print" });
    frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
    frame.addEventListener("load", () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 2000);
    });
    S.an.lastPrint = frame.srcdoc;
    shadow.append(frame);
  }

  // ---- saved analyses (per database, in this browser)
  function saveAnalysisPrompt() {
    const bar = body.querySelector(".chart-bar");
    if (!bar || bar.querySelector(".save-name")) return;
    const cd = chartData();
    const input = h("input", { type: "text", class: "save-name", value: cd.title, "aria-label": "Name of the analysis" });
    const ok = h("button", { type: "button", class: "btn small primary", onclick: () => saveAnalysis(input.value) }, "Save");
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") saveAnalysis(input.value); if (ev.key === "Escape") render(); });
    bar.append(input, ok);
    input.select();
  }

  async function saveAnalysis(name) {
    const a = S.an;
    name = String(name || "").trim();
    if (!name) return;
    const all = (await store.get(anKey(), [])).filter((x) => !(x.model === S.model && x.name === name));
    all.push({ name, model: S.model, groupby: a.groupby, split: a.split, measure: a.measure, top: a.top, chart: a.chart, compare: a.compare, archived: !!a.archived, filters: S.filters });
    await store.set(anKey(), all);
    a.saved = all.filter((x) => x.model === S.model);
    toast("Analysis saved");
    render();
  }

  async function deleteAnalysis(x) {
    const all = (await store.get(anKey(), [])).filter((y) => !(y.model === x.model && y.name === x.name));
    await store.set(anKey(), all);
    S.an.saved = all.filter((y) => y.model === S.model);
    render();
  }

  function loadAnalysis(x) {
    Object.assign(S.an, { groupby: x.groupby, split: x.split, measure: x.measure, top: x.top, chart: x.chart, compare: x.compare || "none", archived: x.archived });
    S.filters = JSON.parse(JSON.stringify(x.filters || []));
    runAnalysis();
  }

  // Shown on Odoo versions outside 16-20: the user may still try.
  function versionBanner() {
    const v = S.version;
    const { min, max } = OI.rpc.SUPPORTED;
    const text = v.support === "new"
      ? `Odoo ${v.label} is newer than the versions Odoo Import Export is tested on (${min} to ${max}). It will probably work; if something fails, please report it.`
      : v.support === "old"
        ? `Odoo ${v.label} isn't supported: Odoo Import Export is built and tested for Odoo ${min} to ${max}. You can try it, but some steps may fail or behave differently. Check the result before relying on it, and use the dry run before importing.`
        : `This Odoo version couldn't be identified. Odoo Import Export supports Odoo ${min} to ${max}; you can try it, but some steps may fail.`;
    return h("div", { class: "notice warn version-warning", role: "alert" }, h("span", null, "⚠"),
      h("div", { class: "grow" }, h("b", null, v.support === "new" ? "Newer Odoo version" : "Unsupported Odoo version"), h("div", null, text),
        h("div", { class: "row", style: "margin-top:8px" },
          h("button", { type: "button", class: "btn small", onclick: async () => {
            const ok = await store.get(K.versionOk, []);
            await store.set(K.versionOk, [...new Set([...ok, `${location.origin}|${S.session.db}|${v.label}`])].slice(-50));
            S.versionWarning = false;
            render();
          } }, "Try anyway"),
          h("button", { type: "button", class: "btn small ghost", onclick: () => hide() }, "Close"))));
  }

  // ---------------------------------------------------------------------------
  // render
  function renderSteps() {
    for (const b of modeSwitch.children) b.classList.toggle("active", b.dataset.mode === S.mode);
    stepNav.hidden = S.mode !== "import" || !!S.versionWarning;
    const conflicts = S.analysis ? S.analysis.conflicts.length : 0;
    stepNav.replaceChildren(...STEPS.map(([k, label], i) => {
      const cur = stepIndex(S.step);
      return h("button", { type: "button", class: `${k === S.step ? "active" : ""}${i < cur ? " done" : ""}`, disabled: !canEnter(k) || !!S.busy, onclick: () => go(k), "aria-current": k === S.step ? "step" : null },
        h("span", { class: "n" }, i < cur ? "✓" : i + 1), label,
        k === "review" && S.analysis ? h("span", { class: `badge ${conflicts ? "" : "ok"}` }, conflicts || "✓") : null);
    }));
  }

  function renderFooter(message, isError) {
    if (S.versionWarning) {
      for (const b of [backBtn, nextBtn, discardBtn, cancelBtn]) b.hidden = true;
      status.replaceChildren(`Odoo ${S.version.label}`);
      return;
    }
    // Header: discard (not while records are being saved).
    const importing = S.op && S.op.kind === "import";
    discardBtn.hidden = !S.book || importing;
    if (!discardArmed) {
      discardBtn.classList.remove("armed");
      discardBtn.textContent = S.result ? "New import" : "Discard";
      discardBtn.title = S.result ? "Start a new import" : "Throw this file, its mapping and your decisions away and start again";
    }
    cancelBtn.hidden = !S.op;
    cancelBtn.textContent = importing ? (S.op.ctrl.signal.aborted ? "Stopping after this batch…" : "Stop after this batch") : "Cancel";
    cancelBtn.disabled = importing && S.op.ctrl.signal.aborted;
    status.replaceChildren();
    if (S.mode === "analyze") {
      discardBtn.hidden = true;
      backBtn.hidden = true;
      nextBtn.hidden = true;
      if (S.busy) status.append(h("span", { class: "spinner" }), " ", S.busy);
      else if (message) status.append(h("span", { style: isError ? "color: var(--danger)" : "" }, message));
      else status.append(S.an.result && S.an.result.via === "browser" ? "Grouped in the browser (this Odoo version can't group by that field on the server)." : "Hover the chart for values; the table below has every number.");
      return;
    }
    if (S.mode === "export") {
      discardBtn.hidden = true;
      if (S.busy) status.append(h("span", { class: "spinner" }), " ", S.busy);
      else if (message) status.append(h("span", { style: isError ? "color: var(--danger)" : "" }, message));
      else status.append(S.exp.purpose ? "Add or remove columns, pick a format, export." : "Choose what the file is for.");
      backBtn.hidden = true;
      const n = S.exp.count || 0;
      nextBtn.hidden = !S.exp.purpose;
      nextBtn.textContent = `Export ${n.toLocaleString()} record${n === 1 ? "" : "s"}`;
      nextBtn.disabled = !!S.busy || !S.exp.columns.length || !n;
      return;
    }
    if (S.busy) status.append(h("span", { class: "spinner" }), " ", S.busy);
    else if (message) status.append(h("span", { style: isError ? "color: var(--danger)" : "" }, message));
    else if (S.step === "source") status.append(S.book ? "Next: match the columns to Odoo fields." : "Choose a model and a file.");
    else if (S.step === "map") status.append("Check the matches, then look the values up in Odoo.");
    else if (S.step === "review") status.append(S.analysis && S.analysis.conflicts.length ? `${S.analysis.conflicts.length} left to decide.` : "All settled.");
    else if (S.step === "import") status.append(`${S.session ? S.session.db : ""} · ${S.modelName}`);

    backBtn.hidden = S.step === "source";
    backBtn.disabled = !!S.busy;
    nextBtn.hidden = false;
    nextBtn.disabled = !!S.busy;
    if (S.step === "source") {
      nextBtn.textContent = "Match columns →";
      nextBtn.disabled = !!S.busy || !S.book || !S.model || !S.session;
    } else if (S.step === "map") {
      nextBtn.textContent = "Look up values →";
    } else if (S.step === "review") {
      nextBtn.textContent = "Continue →";
      nextBtn.disabled = !!S.busy || !S.analysis || S.analysis.conflicts.length > 0;
    } else {
      const n = S.analysis ? S.analysis.stats.create + S.analysis.stats.update : 0;
      nextBtn.textContent = `Import ${n} record${n === 1 ? "" : "s"}`;
      nextBtn.disabled = !!S.busy || !n || !!S.result || !!(S.check && !S.check.ok && !S.check.noDryRun);
      nextBtn.hidden = !!(S.result && S.result.ok);
    }
  }

  function render() {
    closePops();
    renderSteps();
    let content;
    try {
      if (S.mode === "export") content = renderExport();
      else if (S.mode === "analyze") content = renderAnalyze();
      else if (S.step === "source") content = renderSource();
      else if (S.step === "map") content = renderMap();
      else if (S.step === "review") content = renderReview();
      else content = renderImport();
    } catch (e) {
      content = h("div", { class: "notice err" }, String(e && e.stack ? e.stack : e));
    }
    if (S.versionWarning) content = versionBanner(); // the tools appear once the user chooses to try
    // A redraw (an analysis finishing, a count arriving) must not eat what the user is typing.
    const typing = shadow.activeElement;
    let keep = null;
    if (typing && typing.tagName === "INPUT" && body.contains(typing) && typing.type !== "checkbox" && typing.type !== "radio") {
      const box = typing.closest("[data-key]");
      keep = { key: box ? box.getAttribute("data-key") : null, label: typing.getAttribute("aria-label"), value: typing.value, start: typing.selectionStart, end: typing.selectionEnd };
    }
    body.replaceChildren(content);
    if (keep) {
      const scope = keep.key ? body.querySelector(`[data-key="${keep.key}"]`) : body;
      const again = scope && [...scope.querySelectorAll("input")].find((x) => x.getAttribute("aria-label") === keep.label);
      if (again) {
        again.focus();
        if (again.value !== keep.value) {
          again.value = keep.value;
          if (keep.value) again.dispatchEvent(new Event("input"));
        }
        try {
          again.setSelectionRange(keep.start, keep.end);
        } catch {
          // number/date inputs have no selection
        }
      }
    }
    renderFooter();
    if (S.step === "review" && S.reviewTab === "conflicts" && S.analysis && S.analysis.conflicts.length && shadow.activeElement === null) {
      setTimeout(() => body.focus({ preventScroll: true }));
    }
  }

  // Re-render the source step without losing the model input's focus/caret.
  function renderBodyKeepFocus() {
    const active = shadow.activeElement;
    if (active && active.closest && active.closest(".model-picker")) return;
    render();
  }

  // Paste anywhere on the File step (outside text inputs) loads the clipboard as a table.
  panel.addEventListener("paste", (e) => {
    if (S.step !== "source" || (e.target.closest && e.target.closest("input, textarea"))) return;
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (text && text.trim()) {
      e.preventDefault();
      openBook({ name: "Pasted data", ...OI.sheet.readPaste(text) });
    }
  });

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (shadow.querySelector(".pop")) closePops();
      else if (!historySheet.hidden) historySheet.hidden = true;
      else hide();
      e.preventDefault();
    }
  });

  // ---------------------------------------------------------------------------
  // show / hide
  function show() {
    if (!host.isConnected) document.documentElement.append(host);
    host.style.display = "";
    applyTheme();
    panel.focus();
    // Reopened on another list or selection: Export/Analyze follow the page.
    if (S.session && S.mode !== "import" && !S.op) followPage(S.mode);
  }

  function hide() {
    host.style.display = "none";
  }

  function toggle() {
    if (host.isConnected && host.style.display !== "none") hide();
    else show();
  }

  globalThis.__odooImport = { toggle, show, hide, state: S };

  (async () => {
    const [settings, history] = await Promise.all([store.get(K.settings, {}), store.get(K.history, [])]);
    S.settings = { ...S.settings, ...settings };
    if (S.settings.exportFormat) S.exp.format = S.settings.exportFormat;
    S.history = Array.isArray(history) ? history : [];
    panel.tabIndex = -1;
    render();
    show();
    connect();
  })();
})();
