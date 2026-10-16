/* Odoo Import Export panel styles, injected into the panel's shadow root so the host page can't touch them. */
globalThis.ODOO_IMPORT_CSS = `
:host {
  all: initial;
  --accent: #714b67;
  --accent-2: #8f6a86;
  --accent-soft: #f3edf2;
  --accent-fg: #fff;
  --teal: #017e84;
  --bg: #ffffff;
  --bg-2: #f6f5f8;
  --bg-3: #ecebf0;
  --fg: #1f1d24;
  --fg-2: #5d5a66;
  --fg-3: #8b8894;
  --border: #dcdae2;
  --danger: #c0392b;
  --danger-bg: #fdecea;
  --warn: #8a5d00;
  --warn-bg: #fff4d6;
  --ok: #1a7f37;
  --ok-bg: #e7f6ec;
  --info-bg: #eaf2fd;
  --shadow: 0 16px 48px rgba(20, 10, 30, .25), 0 2px 8px rgba(20, 10, 30, .12);
  --mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
}
:host([data-theme="dark"]) {
  --accent: #c79bbd;
  --accent-2: #b07fa5;
  --accent-soft: #33283a;
  --accent-fg: #1b1420;
  --teal: #4fc3c8;
  --bg: #1c1b21;
  --bg-2: #24232a;
  --bg-3: #2e2d35;
  --fg: #ebe9f0;
  --fg-2: #b4b1bd;
  --fg-3: #85828e;
  --border: #3a3842;
  --danger: #ff7b72;
  --danger-bg: #3a1d1d;
  --warn: #e3b341;
  --warn-bg: #3a2f12;
  --ok: #56d364;
  --ok-bg: #16301e;
  --info-bg: #1d2a3d;
  --shadow: 0 16px 48px rgba(0, 0, 0, .6), 0 2px 8px rgba(0, 0, 0, .4);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.backdrop { position: fixed; inset: 0; background: rgba(20, 10, 30, .35); z-index: 2147483645; }
.panel {
  position: fixed; z-index: 2147483646;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(1080px, calc(100vw - 32px)); height: min(760px, calc(100vh - 32px));
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg);
  font: 13px/1.45 var(--sans);
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
  overflow: hidden;
}
button, input, select, textarea { font: inherit; color: inherit; }
header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-2);
}
.logo { font-weight: 600; font-size: 15px; letter-spacing: -.01em; white-space: nowrap; }
.logo b { color: var(--accent); }
.conn { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); flex: none; }
.conn.ok .dot { background: var(--ok); }
.conn.err .dot { background: var(--danger); }
.conn.err { color: var(--danger); }
.spacer { flex: 1; }
.icon-btn {
  border: 1px solid transparent; background: none; cursor: pointer; border-radius: 6px;
  padding: 3px 8px; color: var(--fg-2); font-size: 13px;
}
.icon-btn:hover { background: var(--bg-3); color: var(--fg); }
.btn.reset { color: var(--fg-2); }
.btn.reset.armed { color: var(--danger); background: var(--danger-bg); border-color: var(--danger); font-weight: 600; }
.icon-btn.armed { color: var(--danger); background: var(--danger-bg); font-weight: 600; }
.icon-btn.big { font-size: 18px; line-height: 1; padding: 2px 8px; }
nav.steps { display: flex; gap: 4px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
nav.steps button {
  display: inline-flex; align-items: center; gap: 8px;
  border: 0; background: none; padding: 6px 12px; border-radius: 999px; cursor: pointer; color: var(--fg-2);
}
nav.steps button .n {
  display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  background: var(--bg-3); color: var(--fg-2); font-size: 11px; font-weight: 600;
}
nav.steps button.done .n { background: var(--ok-bg); color: var(--ok); }
nav.steps button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
nav.steps button.active .n { background: var(--accent); color: var(--accent-fg); }
nav.steps button:disabled { opacity: .45; cursor: default; }
.badge { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--danger); color: #fff; font-size: 11px; font-weight: 600; text-align: center; }
.badge.warn { background: var(--warn); }
.badge.ok { background: var(--ok); }
main.body { flex: 1; overflow: auto; padding: 16px 18px; position: relative; }
footer {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-top: 1px solid var(--border); background: var(--bg-2);
}
footer .status { color: var(--fg-2); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--bg); padding: 6px 12px; border-radius: 6px; cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) { border-color: var(--accent-2); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.btn.primary:hover:not(:disabled) { background: var(--accent-2); }
.btn.danger { color: var(--danger); }
.btn.small { padding: 3px 8px; font-size: 12px; }
.btn.ghost { border-color: transparent; background: none; color: var(--fg-2); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-3); color: var(--fg); }
kbd { font: 11px var(--mono); padding: 0 4px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; color: var(--fg-2); background: var(--bg); }
h2 { font-size: 15px; margin: 0 0 4px; }
.muted { color: var(--fg-2); }
.small { font-size: 12px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.field-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.field-row > label { color: var(--fg-2); min-width: 90px; }
input[type="text"], input[type="search"], input[type="number"], select, textarea {
  border: 1px solid var(--border); background: var(--bg); border-radius: 6px; padding: 6px 8px; outline: none;
}
input:focus, select:focus, textarea:focus, .btn:focus-visible, .icon-btn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.model-picker { position: relative; flex: 1; max-width: 460px; }
.model-picker input { width: 100%; }
.dropdown {
  position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px);
  max-height: 320px; overflow: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
  list-style: none; margin: 0; padding: 4px;
}
.dropdown li { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.dropdown li .tech { color: var(--fg-3); font: 11px var(--mono); margin-left: auto; white-space: nowrap; }
.dropdown li.sel, .dropdown li:hover { background: var(--accent-soft); }
.dropdown li.head { cursor: default; color: var(--fg-3); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: none; }
.drop {
  border: 2px dashed var(--border); border-radius: 12px; padding: 34px 20px; text-align: center; color: var(--fg-2);
  background: var(--bg-2); cursor: pointer; transition: border-color .15s, background .15s;
}
.drop:hover, .drop.over, .drop:focus { border-color: var(--accent-2); background: var(--accent-soft); outline: none; }
.drop .big { font-size: 15px; color: var(--fg); font-weight: 600; margin-bottom: 4px; }
.drop .formats { font-size: 12px; margin-top: 8px; }
.sample-card { display: flex; gap: 14px; align-items: center; margin-top: 14px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-2); }
.sample-card.off { opacity: .75; }
.sample-card .icon { font-size: 26px; }
.sample-card.highlight { border-color: var(--accent-2); background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); }
.sample-guide { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; margin-bottom: 14px; border-radius: 10px; background: var(--info-bg); border: 1px solid var(--border); font-size: 13px; }
.sample-guide .tag-label { font-weight: 600; white-space: nowrap; }
.sample-guide .grow > div + div { margin-top: 2px; }
.template-row { margin-top: 12px; gap: 8px; }
.paste { width: 100%; min-height: 120px; font: 12px var(--mono); margin-top: 10px; }
.file-info { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 10px 12px; background: var(--bg-2); border-radius: 8px; margin: 14px 0 10px; }
.file-info .name { font-weight: 600; }
.table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 8px; max-height: 360px; }
table.grid { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
table.grid th, table.grid td { padding: 5px 8px; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); text-align: left; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
table.grid th { position: sticky; top: 0; background: var(--bg-2); font-weight: 600; z-index: 1; }
table.grid td.ln, table.grid th.ln { color: var(--fg-3); text-align: right; width: 1%; font: 11px var(--mono); }
table.grid td.c-ok { background: var(--ok-bg); }
table.grid td.c-fix { background: var(--info-bg); }
table.grid td.c-bad { background: var(--danger-bg); color: var(--danger); font-weight: 600; }
table.grid td.c-warn { background: var(--warn-bg); }
table.grid tr.skipped td { text-decoration: line-through; color: var(--fg-3); background: none; }
table.grid td .arrow { color: var(--fg-3); }
.map-table { width: 100%; border-collapse: collapse; }
.map-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-3); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.map-table td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.map-table tr.ignored .colname, .map-table tr.ignored .samples { opacity: .5; }
.colname { font-weight: 600; }
.samples { color: var(--fg-3); font-size: 12px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type { display: inline-block; font: 10px var(--mono); padding: 0 5px; border-radius: 4px; background: var(--bg-3); color: var(--fg-2); margin-left: 6px; vertical-align: 1px; }
.fieldbtn {
  display: flex; align-items: center; gap: 8px; width: 100%; max-width: 380px; text-align: left;
  border: 1px solid var(--border); background: var(--bg); border-radius: 6px; padding: 6px 10px; cursor: pointer;
}
.fieldbtn:hover { border-color: var(--accent-2); }
.fieldbtn .tech { color: var(--fg-3); font: 11px var(--mono); margin-left: auto; }
.fieldbtn.none { color: var(--fg-3); font-style: italic; }
.picker { position: relative; }
.picker .pop {
  position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; width: 420px; max-width: 70vw;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); padding: 6px;
}
.picker .pop input { width: 100%; margin-bottom: 6px; }
.picker .pop ul { list-style: none; margin: 0; padding: 0; max-height: 300px; overflow: auto; }
.picker .pop li { padding: 5px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.picker .pop li.sel, .picker .pop li:hover { background: var(--accent-soft); }
.picker .pop li .tech { color: var(--fg-3); font: 11px var(--mono); margin-left: auto; white-space: nowrap; }
.picker .pop li .req { color: var(--danger); }
.picker .pop .crumb { font-size: 12px; color: var(--fg-2); padding: 2px 6px 6px; display: flex; gap: 6px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; font-weight: 600; }
.chip.auto { background: var(--ok-bg); color: var(--ok); }
.chip.memory { background: var(--info-bg); color: var(--teal); }
.chip.suggest { background: var(--warn-bg); color: var(--warn); }
.chip.manual { background: var(--accent-soft); color: var(--accent); }
.chip.none, .chip.ignored { background: var(--bg-3); color: var(--fg-3); }
.notice { padding: 10px 12px; border-radius: 8px; margin: 10px 0; display: flex; gap: 10px; align-items: flex-start; }
.notice.warn { background: var(--warn-bg); color: var(--warn); }
.notice.err { background: var(--danger-bg); color: var(--danger); }
.notice.info { background: var(--info-bg); }
.notice.ok { background: var(--ok-bg); color: var(--ok); }
.notice .grow { flex: 1; }
.key-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 12px; background: var(--bg-2); border-radius: 8px; margin-bottom: 12px; }
.summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
.stat { padding: 6px 12px; border-radius: 8px; background: var(--bg-2); font-size: 12px; }
.stat b { font-size: 15px; display: block; color: var(--fg); }
.stat.bad b { color: var(--danger); }
.stat.good b { color: var(--ok); }
.stat.warn b { color: var(--warn); }
.tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.tabs button { border: 0; background: none; padding: 5px 10px; border-radius: 6px; cursor: pointer; color: var(--fg-2); }
.tabs button.active { background: var(--bg-3); color: var(--fg); font-weight: 600; }
.cards { display: flex; flex-direction: column; gap: 8px; }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg); }
.card:focus { outline: 2px solid var(--accent-2); outline-offset: 0; }
.card.focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px var(--accent-soft); }
.card .title { font-weight: 600; display: flex; gap: 8px; align-items: center; }
.card .title .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: var(--bg-3); color: var(--fg-2); }
.card .title .kind.missing, .card .title .kind.value { background: var(--danger-bg); color: var(--danger); }
.card .title .kind.ambiguous, .card .title .kind.column, .card .title .kind.dateorder, .card .title .kind.existing, .card .title .kind.requiredempty { background: var(--warn-bg); color: var(--warn); }
.card .title .kind.probable { background: var(--info-bg); color: var(--teal); }
.card .msg { color: var(--fg-2); font-size: 12px; margin: 2px 0 8px; }
.card .rows { color: var(--fg-3); font-size: 11px; margin-left: auto; font-weight: normal; white-space: nowrap; }
.modes { display: inline-flex; background: var(--bg-3); border-radius: 999px; padding: 2px; }
.modes button { border: 0; background: none; padding: 3px 12px; border-radius: 999px; cursor: pointer; color: var(--fg-2); font-size: 12px; }
.modes button.active { background: var(--bg); color: var(--accent); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 10px; }
.choice { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; text-align: left; padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); cursor: pointer; }
.choice:hover, .choice:focus-visible { border-color: var(--accent-2); background: var(--accent-soft); }
.choice b { font-size: 15px; }
.choice .icon { font-size: 26px; }
ol.columns { list-style: none; margin: 0 0 8px; padding: 0; border: 1px solid var(--border); border-radius: 8px; max-height: 360px; overflow: auto; }
ol.columns li { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--border); }
ol.columns li:last-child { border-bottom: 0; }
ol.columns .grip { color: var(--fg-3); font: 11px var(--mono); min-width: 22px; text-align: right; }
ol.columns .label { font-weight: 600; }
ol.columns .tech { color: var(--fg-3); font: 11px var(--mono); margin-left: auto; margin-right: 6px; }
ol.columns .icon-btn:disabled { opacity: .3; cursor: default; }
ol.columns input[type=checkbox] { margin: 0; cursor: pointer; }
ol.columns li.off .label, ol.columns li.off .grip { color: var(--fg-3); font-weight: 400; }
.adder { max-width: 460px; }
.adder input { width: 100%; }
.adder .crumb { font-size: 12px; color: var(--fg-2); padding: 2px 0 6px; display: flex; gap: 6px; align-items: center; }
.adder .open { margin-left: 6px; color: var(--accent); font-weight: 700; padding: 0 6px; border-radius: 4px; }
.adder .open:hover { background: var(--bg-3); }
.filters { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 14px; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; background: var(--bg-2); border-radius: 8px; }
.filter-row .label { font-weight: 600; min-width: 120px; }
.filter-row .value { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; flex: 1; }
.filter-row .remove { color: var(--danger); font-size: 16px; margin-left: auto; }
.filter-row .check { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); }
.filter-row .tag { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; padding: 2px 4px 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.filter-row .tag button { border: 0; background: none; cursor: pointer; color: inherit; }
.fieldsearch { position: relative; max-width: 460px; }
.fieldsearch input { width: 100%; }
.fieldsearch .crumb { font-size: 12px; color: var(--fg-2); padding: 2px 0 6px; display: flex; gap: 6px; align-items: center; }
.fieldsearch .open { margin-left: 6px; color: var(--accent); font-weight: 700; padding: 0 6px; border-radius: 4px; }
.fieldsearch .open:hover { background: var(--bg-3); }
.controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px 18px; margin-bottom: 12px; }
.ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ctl > label { color: var(--fg-2); font-size: 12px; min-width: 62px; }
.ctl .fieldsearch { flex: 1; min-width: 160px; }
.chip-x, .chip-open { border: 0; background: none; cursor: pointer; color: inherit; font: inherit; padding: 0 2px; }
.saved { margin-bottom: 8px; }
.segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.segmented button { border: 0; border-right: 1px solid var(--border); background: var(--bg); padding: 5px 12px; cursor: pointer; color: var(--fg-2); font-size: 12px; }
.segmented button:last-child { border-right: 0; }
.segmented button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.segmented button.suggested:not(.on) { color: var(--accent); }
.segmented button:disabled { opacity: .4; cursor: default; }
.chart-bar { margin-bottom: 8px; gap: 8px; }
.chart-bar .save-name { width: 260px; }
.chart-box { position: relative; border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--bg); overflow-x: auto; transition: opacity .2s; }
.chart-box.loading { opacity: .5; }
.chart-box svg { display: block; max-width: 100%; height: auto; }
.chart-box .mark { cursor: default; outline: none; }
.chart-box .mark.hover, .chart-box .mark:focus { opacity: .82; }
.chart-box .band.hover, .chart-box .band:focus { opacity: 1; }
.tooltip { position: absolute; z-index: 3; pointer-events: none; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); padding: 6px 10px; font-size: 12px; min-width: 120px; }
.tooltip .t { color: var(--fg-2); margin-bottom: 2px; }
.tooltip .r { display: flex; align-items: center; gap: 6px; }
.tooltip .key { width: 10px; height: 2px; border-radius: 1px; display: inline-block; }
.tooltip b { font-variant-numeric: tabular-nums; }
table.grid.numbers td.n, table.grid.numbers th.n { text-align: right; font-variant-numeric: tabular-nums; }
.print-frame { position: fixed; width: 0; height: 0; border: 0; visibility: hidden; }
.count { white-space: nowrap; }
.group { border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: var(--bg-2); display: flex; flex-direction: column; gap: 8px; }
.group-head { padding: 2px 4px; }
.group-head .title { font-weight: 600; display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.group-head .rows { color: var(--fg-3); font-size: 11px; margin-left: auto; font-weight: normal; }
.cands { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.cand {
  display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left;
  border: 1px solid var(--border); background: var(--bg-2); border-radius: 8px; padding: 5px 10px; cursor: pointer; max-width: 320px;
}
.cand:hover { border-color: var(--accent-2); background: var(--accent-soft); }
.cand .l { font-weight: 600; }
.cand .d { font-size: 11px; color: var(--fg-3); }
.cand .k { font: 10px var(--mono); color: var(--fg-3); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.search-inline { position: relative; display: inline-block; }
.search-inline input { width: 220px; }
.search-inline .dropdown { width: 320px; right: auto; }
.done-list { margin-top: 18px; }
.done-list summary { cursor: pointer; color: var(--fg-2); }
.decided { display: flex; gap: 8px; align-items: center; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--border); }
.decided .what { flex: 1; }
.progress { height: 8px; border-radius: 999px; background: var(--bg-3); overflow: hidden; margin: 12px 0; }
.progress > div { height: 100%; background: var(--accent); width: 0; transition: width .2s; }
.errors { list-style: none; margin: 8px 0; padding: 0; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.errors li { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; display: flex; gap: 10px; }
.errors li:last-child { border-bottom: 0; }
.errors li .hint { color: var(--fg-2); margin-top: 2px; }
.errors li details { margin-top: 4px; }
.errors li summary { cursor: pointer; color: var(--fg-3); font-size: 11px; }
.errors li pre { white-space: pre-wrap; font: 11px var(--mono); color: var(--fg-2); margin: 4px 0 0; max-height: 120px; overflow: auto; }
.errors li .ln { font: 11px var(--mono); color: var(--fg-3); white-space: nowrap; min-width: 56px; }
.big-ok { font-size: 28px; }
.sheet {
  position: absolute; inset: 0; z-index: 20; background: var(--bg); display: flex; flex-direction: column;
}
.sheet h3 { margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; font-size: 15px; }
.sheet .body { flex: 1; overflow: auto; padding: 12px 16px; }
.hist { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
.hist .what { flex: 1; min-width: 0; }
.hist .what small { display: block; color: var(--fg-3); }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--bg-3); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }
.toast {
  position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%); z-index: 30;
  background: var(--fg); color: var(--bg); padding: 6px 14px; border-radius: 999px; font-size: 12px;
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
.toast.show { opacity: .92; }
.empty-state { text-align: center; color: var(--fg-2); padding: 40px 0; }
.kbd-help { color: var(--fg-3); font-size: 11px; margin-left: auto; }
.count-modes { display: flex; flex-direction: column; gap: 8px; margin: 0 0 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-2); }
.count-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.count-mode { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; background: var(--bg); }
.count-mode.on { border-color: var(--accent-2); background: var(--accent-soft); }
.count-mode input { margin-top: 3px; }
.count-mode small { display: block; color: var(--fg-2); font-size: 11.5px; line-height: 1.35; margin-top: 2px; }
.count-table td.num, .count-table th:nth-child(n+5):nth-child(-n+7) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.count-table td.up { color: var(--ok); }
.count-table td.down { color: var(--danger); }
.count-table tr.muted td { color: var(--fg-3); }
.count-table .tag { margin-left: 6px; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.count-warnings { margin-bottom: 10px; }
.apply-form { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; gap: 8px; }
`;
