"""End-to-end test against a real Odoo server.

Opens Odoo in headless Chrome, logs in, injects the extension's scripts into an
isolated world exactly like the background's scripting.executeScript does, and runs
real imports: they are checked in the database and undone at the end.

    python3 tests/e2e.py --url http://127.0.0.1:8020 --db mydb [--login admin --password admin]
"""
import argparse
import base64
import csv
import io
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKGROUND = (ROOT / "src/background.js").read_text()
SCRIPTS = re.findall(r'"(src/[^"]+\.js)"', BACKGROUND.split("\nconst FILES = [", 1)[1].split("];", 1)[0])
ENGINE = [s for s in SCRIPTS if s.startswith("src/shared/")]


class WebSocket:
    """Minimal client WebSocket (text frames only), enough for CDP."""

    def __init__(self, url):
        m = re.match(r"ws://([^:/]+):(\d+)(/.*)?", url)
        host, port, path = m.group(1), int(m.group(2)), m.group(3) or "/"
        self.sock = socket.create_connection((host, port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += self.sock.recv(1)
        assert b" 101 " in response.split(b"\r\n")[0], response

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = bytes([0x81, 0x80 | n])
        elif n < 65536:
            header = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        else:
            header = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("browser connection closed")
            buf += chunk
        return buf

    def recv(self):
        message = b""
        while True:
            b1, b2 = self._exact(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(8))[0]
            message += self._exact(n)
            if b1 & 0x80:
                return message.decode()


class Chrome:
    def __init__(self, binary, profile):
        self.proc = subprocess.Popen(
            [binary, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}", "--no-first-run",
             "--no-default-browser-check", "--disable-gpu", "--window-size=1400,900", "about:blank"],
            stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
        for line in self.proc.stderr:
            if m := re.search(r"DevTools listening on (ws://\S+)", line):
                break
        else:
            raise SystemExit("Chrome failed to start")
        self.ws = WebSocket(m.group(1))
        self.next_id = 0
        target = self.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.session = self.send("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        self.send("Page.enable", session=self.session)

    def send(self, method, params=None, session=None):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == self.next_id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply["result"]

    def page(self, method, params=None):
        return self.send(method, params, self.session)

    def navigate(self, url):
        self.page("Page.navigate", {"url": url})
        origin = "/".join(url.split("/")[:3])
        self.wait(f"document.readyState === 'complete' && location.origin === {json.dumps(origin)}")

    def evaluate(self, expression, context=None):
        params = {"expression": expression, "awaitPromise": True, "returnByValue": True}
        if context:
            params["contextId"] = context
        res = self.page("Runtime.evaluate", params)
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"].get("exception", {}).get("description") or res["exceptionDetails"])
        return res["result"].get("value")

    def wait(self, expression, context=None, timeout=30):
        deadline = time.time() + timeout
        error = None
        while time.time() < deadline:
            try:
                value = self.evaluate(expression, context)
                if value:
                    return value
            except RuntimeError as e:
                error = e
            time.sleep(0.2)
        raise TimeoutError(f"Timed out waiting for: {expression} ({error})")

    def close(self):
        self.proc.terminate()
        self.proc.wait(10)



# Runs in the isolated world before the scripts: a storage stub standing in for
# browser.storage, and a hook that keeps a handle on the (closed) shadow root.
PRELUDE = """
(() => {
  const data = {};
  globalThis.browser = { storage: { local: {
    async get(k) { return k in data ? { [k]: JSON.parse(JSON.stringify(data[k])) } : {}; },
    async set(o) { Object.assign(data, JSON.parse(JSON.stringify(o))); },
    async remove(k) { delete data[k]; },
  } } };
  globalThis.__store = data;
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return (globalThis.__root = attach.call(this, o)); };
})();
"""

# Engine driver: the same pipeline the panel runs, without the UI.
ENGINE_HELPERS = """
globalThis.E = {
  OI: globalThis.OdooImport,
  async ensure() {
    if (!E.client) {
      E.client = E.OI.rpc.createClient();
      await E.client.connect();
      E.deps = E.OI.pipeline.makeDeps(E.client);
    }
  },
  async start(model, csvText) {
    const OI = E.OI;
    await E.ensure();
    const table = OI.sheet.buildTable(OI.csv.parse(csvText).rows);
    E.job = await OI.pipeline.prepare(E.deps, model, table);
    await OI.pipeline.resolve(E.deps, E.job);
    return E.summary();
  },
  summary() {
    const a = E.OI.plan.analyze(E.job);
    return {
      mapping: E.job.mapping.map((m) => [m.path && m.path.join('/'), m.status]),
      conflicts: a.conflicts.map((c) => ({ key: c.key, status: c.status || null, cands: (c.candidates || []).map((x) => x.label) })),
      warnings: a.warnings.map((w) => w.key),
      stats: a.stats,
      key: E.job.key && [E.job.key.field, E.job.key.mode],
      required: E.job.requiredMissing.map((f) => f.name),
    };
  },
  decide(key, d) { E.job.decisions.set(key, d); return E.summary(); },
  confirm(col) { E.job.mapping[col].confirmed = true; return E.summary(); },
  async run(dryrun) {
    const r = await E.deps.executor.run(E.job, E.OI.plan.analyze(E.job), { dryrun });
    if (!dryrun) E.last = { model: E.job.model, created: r.created, deps: r.deps };
    return r;
  },
  undo(entry) { return E.deps.executor.undo(entry || E.last); },
  async call(...a) { await E.ensure(); return E.client.call(...a); },
};
"""


UI_HELPERS = """
globalThis.U = {
  q: (s) => __root.querySelector(s),
  qa: (s) => [...__root.querySelectorAll(s)],
  text: (s) => (__root.querySelector(s) || {}).textContent || '',
  button: (label) => [...__root.querySelectorAll('button')].find((b) => b.textContent.includes(label)),
  next() { __root.querySelector('footer .btn.primary').click(); },
  paste(text) {
    const ta = __root.querySelector('textarea.paste');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  },
  type(sel, value) {
    const i = __root.querySelector(sel);
    i.focus();
    i.value = value;
    i.dispatchEvent(new Event('input'));
  },
  setBatch(n) {
    const i = __root.querySelector('input[type=number]');
    i.value = String(n);
    i.dispatchEvent(new Event('change'));
  },
  key(key) {
    __root.querySelector('main.body').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  },
};
"""

PARTNERS = """Customer Name,E-mail,Country,State,Tags,Company?,Credit Limit
OI Test Alpha,alpha@oi.test,Belgium,,"Prospects, Vendor",yes,"1,500.50"
OI Test Beta,beta@oi.test,United States,Georgia,Services,no,200
OI Test Gamma,gamma@oi.test,Belgum,,Prospectz,yes,
OI Test Delta,delta@oi.test,Narnia,,,no,10
"""

# What a copy from a spreadsheet puts on the clipboard: tab-separated, no quotes.
PARTNERS_TSV = "\n".join("\t".join(r) for r in csv.reader(io.StringIO(PARTNERS)))

PARTNERS_UPDATE = """E-mail,Credit Limit,Customer Name
ALPHA@oi.test,999,OI Test Alpha
new@oi.test,5,OI Test New
"""

# Products and customers present in the demo data of Odoo 16 to 19.
ORDERS = """Customer,Order Lines/Product,Order Lines/Quantity,Order Lines/Unit Price
Azure Interior,Large Cabinet,2,10
,FURN_8855,1,
Ready Mat,Customizable Desk,3,99.5
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8069")
    ap.add_argument("--db", required=True)
    ap.add_argument("--login", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--binary", default=shutil.which("google-chrome") or shutil.which("chromium"))
    ap.add_argument("--screenshot", help="save PNGs of the panel with this path prefix")
    opts = ap.parse_args()

    profile = tempfile.mkdtemp(prefix="odoo-import-e2e-")
    chrome = Chrome(opts.binary, profile)
    results = []

    def check(name, fn):
        try:
            fn()
            results.append((name, None))
        except Exception as e:  # noqa: BLE001 - report every failure
            results.append((name, f"{type(e).__name__}: {e}"))

    try:
        chrome.navigate(f"{opts.url}/web/login?db={opts.db}")
        auth = chrome.evaluate(f"""fetch('/web/session/authenticate', {{method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{jsonrpc: '2.0', method: 'call', params: {json.dumps(
                {"db": opts.db, "login": opts.login, "password": opts.password})}}})}})
            .then(r => r.json()).then(r => r.result ? r.result.uid : JSON.stringify(r.error))""")
        assert isinstance(auth, int), f"login failed: {auth}"
        # Odoo 17.2+ has /odoo/<app> URLs; 16 and 17.0 use /web#action=...
        info = chrome.evaluate("""fetch('/web/webclient/version_info', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {}})}).then((r) => r.json()).then((r) => r.result.server_version_info)""")
        version = (info[0], info[1]) if isinstance(info[0], int) else (int(str(info[0]).split("~")[-1].split("-")[-1] or 0), info[1])
        print(f"Odoo {'.'.join(map(str, info[:2]))}")
        modern = version >= (17, 2)
        chrome.navigate(f"{opts.url}/odoo/contacts" if modern else f"{opts.url}/web#action=contacts.action_contacts")
        chrome.wait("!!document.querySelector('.o_main_navbar')", timeout=60)
        if not modern:
            chrome.wait("location.hash.includes('model=res.partner')", timeout=60)

        frame = chrome.page("Page.getFrameTree")["frameTree"]["frame"]["id"]
        ctx = chrome.page("Page.createIsolatedWorld", {"frameId": frame, "worldName": "odoo-import-e2e"})["executionContextId"]
        ev = lambda js: chrome.evaluate(js, ctx)  # noqa: E731
        wait = lambda js, timeout=30: chrome.wait(js, ctx, timeout)  # noqa: E731
        ev(PRELUDE)
        for path in ENGINE:
            ev((ROOT / path).read_text())
        ev(ENGINE_HELPERS)
        call = lambda model, method, *args, **kw: ev(f"E.call({json.dumps(model)}, {json.dumps(method)}, {json.dumps(list(args))}, {json.dumps(kw)})")  # noqa: E731

        # leftovers of an interrupted run
        old = call("res.partner", "search", ["|", ["email", "=like", "%@oi.test"], ["email", "=like", "drop%@oi.test"]], context={"active_test": False})
        if old:
            call("res.partner", "unlink", old)
        old = call("res.partner.category", "search", ["|", ["name", "=", "Prospectz"], ["name", "=like", "OI Bulk Tag %"]])
        if old:
            call("res.partner.category", "unlink", old)

        state = {}

        def partners_map():
            s = ev(f"E.start('res.partner', {json.dumps(PARTNERS)})")
            state["s"] = s
            got = [m[0] for m in s["mapping"]]
            # is_company is readonly since Odoo 19 (computed from the company type): left unmapped there
            assert got[:5] == ["name", "email", "country_id", "state_id", "category_id"] and got[6] == "credit_limit", s["mapping"]
            assert got[5] in (None, "is_company"), s["mapping"]
            assert all(m[1] == "auto" for m in s["mapping"] if m[0]), s["mapping"]
        check("partners: every column mapped automatically", partners_map)

        def partners_conflicts():
            s = state["s"]
            by = {c["key"]: c for c in s["conflicts"]}
            assert set(by) == {"m2o:2:belgum", "m2o:2:narnia", "m2o:4:prospectz"}, list(by)
            assert by["m2o:2:belgum"]["status"] == "probable" and by["m2o:2:belgum"]["cands"][0] == "Belgium", by["m2o:2:belgum"]
            assert by["m2o:4:prospectz"]["status"] == "probable" and by["m2o:4:prospectz"]["cands"][0] == "Prospects", by["m2o:4:prospectz"]
            assert by["m2o:2:narnia"]["status"] == "missing", by["m2o:2:narnia"]
            assert s["stats"]["create"] == 4, s["stats"]
        check("partners: typos are probable matches, unknown values missing", partners_conflicts)

        def partners_decide_and_dry_run():
            ev("E.decide('m2o:2:belgum', {action: 'pick', id: E.job.resolutions.get(2).get('Belgum').candidates[0].id}); true")
            ev("E.decide('m2o:2:narnia', {action: 'empty'}); true")
            s = ev("E.decide('m2o:4:prospectz', {action: 'create', value: 'Prospectz'})")
            assert s["conflicts"] == [], s["conflicts"]
            r = ev("E.run(true)")
            assert r["ok"] and not r["errors"], r
            assert call("res.partner", "search_count", [["email", "=like", "%@oi.test"]]) == 0, "dry run must not write"
            assert call("res.partner.category", "search_count", [["name", "=", "Prospectz"]]) == 0, "dry run must not create tags"
        check("partners: decisions settle every conflict; dry run writes nothing", partners_decide_and_dry_run)

        def partners_import():
            r = ev("E.run(false)")
            assert r["ok"], r
            assert len(r["created"]) == 4 and not r["updated"], r
            assert len(r["deps"]) == 1 and r["deps"][0]["relation"] == "res.partner.category", r["deps"]
            recs = call("res.partner", "search_read", [["email", "=like", "%@oi.test"]], ["name", "country_id", "state_id", "category_id", "is_company", "credit_limit"], order="name")
            by = {x["name"]: x for x in recs}
            a, b, g, d = by["OI Test Alpha"], by["OI Test Beta"], by["OI Test Gamma"], by["OI Test Delta"]
            assert a["country_id"][1] == "Belgium" and a["credit_limit"] == 1500.5 and len(a["category_id"]) == 2, a
            assert b["state_id"] and "Georgia" in b["state_id"][1] and b["country_id"][1] == "United States", b
            assert g["country_id"][1] == "Belgium" and len(g["category_id"]) == 1, g
            assert d["country_id"] is False, d
            state["first"] = ev("E.last")
        check("partners: import creates the records with resolved relations", partners_import)

        def update_by_key():
            s = ev(f"E.start('res.partner', {json.dumps(PARTNERS_UPDATE)})")
            assert s["key"] == ["email", "update"], s["key"]
            assert s["stats"]["update"] == 1 and s["stats"]["create"] == 1, s["stats"]
            r = ev("E.run(false)")
            assert r["ok"] and len(r["updated"]) == 1 and len(r["created"]) == 1, r
            assert call("res.partner", "search_count", [["email", "=ilike", "alpha@oi.test"]]) == 1, "no duplicate"
            alpha = call("res.partner", "search_read", [["email", "=ilike", "alpha@oi.test"]], ["credit_limit"])[0]
            assert alpha["credit_limit"] == 999, alpha
            state["second"] = ev("E.last")
        check("partners: re-import updates by e-mail instead of duplicating", update_by_key)

        def undo():
            for key in ("second", "first"):
                errors = ev(f"E.undo({json.dumps(state[key])})")
                assert not errors, errors
            assert call("res.partner", "search_count", [["email", "=like", "%@oi.test"]], context={"active_test": False}) == 0
            assert call("res.partner.category", "search_count", [["name", "=", "Prospectz"]]) == 0
        check("undo deletes the created records and the created tag", undo)

        def orders():
            s = ev(f"E.start('sale.order', {json.dumps(ORDERS)})")
            got = [m[0] for m in s["mapping"]]
            assert got == ["partner_id", "order_line/product_id", "order_line/product_uom_qty", "order_line/price_unit"], s["mapping"]
            assert "requiredcol:partner_invoice_id" in s["warnings"], s["warnings"]
            keys = {c["key"]: c for c in s["conflicts"]}
            assert list(keys) == ["m2o:1:customizable desk"], keys
            assert keys["m2o:1:customizable desk"]["status"] == "ambiguous" and len(keys["m2o:1:customizable desk"]["cands"]) > 1, keys
            assert s["stats"]["records"] == 2, s["stats"]
            ev("E.decide('m2o:1:customizable desk', {action: 'pick', id: E.job.resolutions.get(1).get('Customizable Desk').candidates[0].id}); true")
            r = ev("E.run(true)")
            assert r["ok"], r
            r = ev("E.run(false)")
            assert r["ok"] and len(r["created"]) == 2, r
            lines = call("sale.order.line", "search_read", [["order_id", "in", r["created"]]], ["product_id", "product_uom_qty", "price_unit", "order_id"], order="id")
            assert len(lines) == 3, lines
            assert lines[0]["product_uom_qty"] == 2 and lines[0]["price_unit"] == 10 and "Large Cabinet" in lines[0]["product_id"][1], lines[0]
            assert "FURN_8855" in lines[1]["product_id"][1] and lines[1]["order_id"] == lines[0]["order_id"], lines[1]
            assert lines[2]["price_unit"] == 99.5, lines[2]
            errors = ev("E.undo()")
            assert not errors, errors
        check("sale orders with lines: grouped rows, ambiguous product, import, undo", orders)

        def errors_mapped_to_rows():
            bad = "Name,Color\nOI Tag,1\n,2\n"
            ev(f"E.start('res.partner.category', {json.dumps(bad)}).then(() => true)")
            ev("E.decide('requiredempty:0', {action: 'skip'}); true")
            s = ev("E.summary()")
            assert s["stats"]["skip"] == 1 and s["stats"]["create"] == 1, s["stats"]
        check("required empty name: rows can be skipped", errors_mapped_to_rows)

        def errors_explained():
            # Straight to Odoo's import (dry run), bypassing the panel's own matching: a country that
            # doesn't exist and a number that isn't one. Odoo's messages differ per version.
            r = ev("""(async () => {
                const f = await E.call('base_import.import', 'fields_get', [['file']], { attributes: ['help'] });
                const csv = 'name,country_id,credit_limit\\nOI Err,Narnia,12x\\n';
                const raw = /not base64/i.test(f.file.help || '');
                const id = await E.call('base_import.import', 'create', [{ res_model: 'res.partner', file: raw ? csv : btoa(csv), file_name: 'e.csv', file_type: 'text/csv' }]);
                const opts = { has_headers: true, quoting: '"', separator: ',', encoding: 'utf-8', date_format: '%Y-%m-%d', datetime_format: '%Y-%m-%d %H:%M:%S', float_decimal_separator: '.', float_thousand_separator: '' };
                return E.call('base_import.import', 'execute_import', [[Array.isArray(id) ? id[0] : id], ['name', 'country_id', 'credit_limit'], ['name', 'country_id', 'credit_limit'], opts], { dryrun: true });
            })()""")
            msgs = [{"row": 0, "line": 2, "message": m["message"]} for m in r["messages"]]
            assert msgs, r
            groups = ev(f"OdooImport.errors.group({json.dumps(msgs)})")
            titles = [g["title"] for g in groups]
            assert any(("Narnia" in t and "Country" in t) or ("12x" in t and ("number" in t or "valid value" in t)) for t in titles), (titles, msgs)
            assert all(g["hint"] for g in groups if g["title"] != g["original"]), groups
        check("Odoo's errors are explained in plain language with a fix", errors_explained)

        def dropped_connection():
            # Wrap fetch so the first real execute_import loses its connection, then reload the engine.
            def drop(mode):
                ev(f"""(() => {{
                    if (!globalThis.__realFetch) globalThis.__realFetch = globalThis.fetch;
                    let armed = true;
                    globalThis.fetch = async (url, opts) => {{
                        const real = String(url).includes('execute_import') && opts && opts.body && opts.body.includes('"dryrun":false');
                        if (armed && real) {{
                            armed = false;
                            if ('{mode}' === 'after') await __realFetch(url, opts); // Odoo saves it, the answer is lost
                            throw new TypeError('Failed to fetch');
                        }}
                        return __realFetch(url, opts);
                    }};
                }})(); true""")
                for path in ENGINE:
                    ev((ROOT / path).read_text())
                ev("E.OI = globalThis.OdooImport; E.client = null; true")
            data = "Name,Email\nOI Drop A,dropa@oi.test\nOI Drop B,dropb@oi.test\n"
            try:
                for mode in ("after", "before"):
                    drop(mode)
                    ev(f"E.start('res.partner', {json.dumps(data)}).then(() => {{ E.job.key = null; E.job.keyChosen = true; }})")
                    r = ev("E.run(false)")
                    n = call("res.partner", "search_count", [["email", "=like", "drop%@oi.test"]])
                    assert n == 2, (mode, n, r)
                    assert len(r["created"]) == 2 and r["ok"], (mode, r)
                    if mode == "after":
                        assert any("connection dropped" in w["message"] for w in r["warnings"]), r["warnings"]
                    errors = ev("E.undo()")
                    assert not errors, errors
                    assert call("res.partner", "search_count", [["email", "=like", "drop%@oi.test"]], context={"active_test": False}) == 0
            finally:
                ev("if (globalThis.__realFetch) globalThis.fetch = globalThis.__realFetch; true")
                for path in ENGINE:
                    ev((ROOT / path).read_text())
                ev("E.OI = globalThis.OdooImport; E.client = null; true")
        check("dropped connection during an import: nothing lost, nothing imported twice", dropped_connection)



        # ------------------------------------------------------------------
        # the panel
        for path in SCRIPTS:
            if not path.startswith("src/shared/"):
                ev((ROOT / path).read_text())
        ev(UI_HELPERS)

        def shot(name):
            if opts.screenshot:
                png = chrome.page("Page.captureScreenshot", {"format": "png"})["data"]
                Path(f"{opts.screenshot}-{name}.png").write_bytes(base64.b64decode(png))

        check("panel opens and connects", lambda: wait(f"U.q('.panel') && U.q('.conn').classList.contains('ok') && U.text('.conn').includes({json.dumps(opts.db)})"))
        check("model detected from the page URL (Contacts app)", lambda: wait("U.q('.model-picker input').value.includes('res.partner')"))

        def ui_paste():
            ev(f"U.paste({json.dumps(PARTNERS_TSV)}); true")
            wait("U.text('.file-info').includes('4 rows')")
            shot("1-file")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            chips = ev("U.qa('.map-table tbody tr').map(tr => tr.querySelector('.chip').textContent)")
            assert chips.count("✓ auto") >= 6, chips
            shot("2-columns")
        check("paste from a spreadsheet, columns mapped", ui_paste)

        def ui_review():
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            assert ev("U.qa('.card').length") == 3, ev("U.qa('.card').map(c => c.textContent)")
            shot("3-review")
            ev("U.button('Accept all').click(); true")
            wait("U.qa('.card').length === 1")
            assert "Narnia" in ev("U.text('.card')")
            ev("U.key('e'); true")
            wait("!!U.q('.notice.ok')")
            assert ev("!U.q('footer .btn.primary').disabled")
        check("review: bulk-accept close matches, keyboard for the rest", ui_review)

        def ui_preview():
            ev("U.button('Preview data').click(); true")
            wait("U.qa('table.grid tbody tr').length === 4")
            assert ev("U.qa('td.c-fix').length") >= 2, "decided cells are tinted"
            shot("4-preview")
        check("preview grid shows decided cells", ui_preview)

        def ui_import():
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Import')")
            ev("U.button('Check with Odoo').click(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('accepts every row')", timeout=60)
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Imported')", timeout=60)
            shot("5-done")
            assert call("res.partner", "search_count", [["email", "=like", "%@oi.test"]]) == 4
            mem = ev("Object.entries(__store).find(([k]) => k.startsWith('oi.memory.'))[1]")
            assert mem["headers"]["res.partner"]["e mail"] == ["email"], mem["headers"]
            assert "belgum" in mem["values"]["res.country"], mem["values"]
        check("check with Odoo, import, remember mapping and choices", ui_import)

        def ui_undo():
            ev("U.button('Undo').click(); true")
            ev("U.button('Delete').click(); true")
            wait("!!U.q('.toast.show') && U.text('.toast').includes('deleted')")
            assert call("res.partner", "search_count", [["email", "=like", "%@oi.test"]], context={"active_test": False}) == 0
            hist = ev("__store['oi.history']")
            assert hist[0]["undone"] is True, hist[0]
        check("undo from the result", ui_undo)

        def ui_memory():
            # Same file again: the typo is now resolved from memory, nothing left to decide but Narnia.
            ev("U.button('File').click(); true")
            ev("U.button('Choose another file').click(); true")
            ev(f"U.paste({json.dumps(PARTNERS_TSV)}); true")
            wait("U.text('.file-info').includes('4 rows')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            cards = ev("U.qa('.card').map(c => c.textContent)")
            assert len(cards) == 1 and "Narnia" in cards[0], cards
        check("remembered choices apply to the next import", ui_memory)

        def ui_toggle():
            ev("__odooImport.toggle(); true")
            assert ev("document.querySelector('odoo-import-root').style.display") == "none"
            for path in SCRIPTS:
                ev((ROOT / path).read_text())
            assert ev("document.querySelector('odoo-import-root').style.display") != "none"
            assert ev("document.querySelectorAll('odoo-import-root').length") == 1
            assert ev("U.q('nav.steps button.active').textContent.includes('Review')"), "state kept"
        check("re-injecting toggles the same panel and keeps the work", ui_toggle)

        def ui_discard():
            ev("U.q('header .icon-btn:not([hidden])').click(); true")  # first click arms it
            assert "Click again" in ev("U.text('header')"), ev("U.text('header')")
            ev("U.button('Discard everything').click(); true")
            wait("!!U.q('.drop') && U.q('nav.steps button.active').textContent.includes('File')")
            assert ev("U.q('nav.steps button:nth-child(2)').disabled"), "Columns step must be unreachable"
        check("discard throws the work away and goes back to the file", ui_discard)

        def ui_cancel_lookup():
            ev(f"U.paste({json.dumps(PARTNERS_TSV)}); true")
            wait("U.text('.file-info').includes('4 rows')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            # Start the lookup and cancel it at once.
            ev("U.next(); U.button('Cancel').click(); true")
            wait("U.button('Cancel').hidden")
            assert ev("U.q('nav.steps button.active').textContent.includes('Columns')"), "stays on Columns"
            st = ev("({a: !!__odooImport.state.analysis, busy: __odooImport.state.busy, op: !!__odooImport.state.op, step: __odooImport.state.step, status: U.text('footer .status')})")
            assert not st["a"] and not st["busy"] and not st["op"], st
            time.sleep(1.5)  # a cancelled lookup must not come back and change the panel
            assert not ev("U.q('footer .btn.primary').disabled") and not ev("__odooImport.state.busy"), ev("U.text('footer')")
        check("cancel stops the lookup and keeps the mapping", ui_cancel_lookup)

        def ui_stop_import():
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            # Close matches were remembered from the first import: only Narnia is left.
            assert ev("U.qa('.card').length") == 1 and "Narnia" in ev("U.text('.card')")
            ev("U.key('e'); true")
            wait("!!U.q('.notice.ok')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Import')")
            ev("U.setBatch(1); true")
            # One row per batch; ask to stop right away: the batch in flight is saved, the rest isn't.
            ev("U.next(); U.button('Stop after this batch').click(); true")
            wait("!!U.q('.notice.err') && U.text('.notice.err').includes('Stopped')", timeout=60)
            n = call("res.partner", "search_count", [["email", "=like", "%@oi.test"]])
            assert 1 <= n < 4, n
            hist = ev("__store['oi.history']")
            assert len(hist[0]["created"]) == n, hist[0]
            errors = ev("E.undo({model: 'res.partner', created: __store['oi.history'][0].created, deps: []})")
            assert not errors, errors
            assert call("res.partner", "search_count", [["email", "=like", "%@oi.test"]]) == 0
        check("stop during the import: finished batches are kept and can be undone", ui_stop_import)

        def ui_fast_mode():
            ev("U.q('header .icon-btn:not([hidden])').click(); true")  # "New import": no confirmation after a result
            wait("!!U.q('.drop')")
            ev("U.paste('Name,Email\\nOI Fast,fast@oi.test'); true")
            wait("U.text('.file-info').includes('1 rows')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Import')")
            ev("U.qa('input[type=checkbox]').find((x) => x.closest('label').textContent.includes('Fast mode')).click(); true")
            ev("U.setBatch(500); true")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Imported')", timeout=60)
            pid = call("res.partner", "search", [["email", "=", "fast@oi.test"]])
            assert len(pid) == 1, pid
            msgs = call("mail.message", "search_count", [["model", "=", "res.partner"], ["res_id", "=", pid[0]]])
            assert msgs == 0, f"{msgs} chatter messages in fast mode"
            call("res.partner", "unlink", pid)
        check("fast mode imports without chatter messages", ui_fast_mode)

        def ui_bulk_missing():
            ev("U.q('header .icon-btn:not([hidden])').click(); true")  # New import
            wait("!!U.q('.drop')")
            rows = ["Name\tEmail\tCountry\tTags"] + [f"OI Bulk {i}\tbulk{i}@oi.test\tNowhereland {i}\tOI Bulk Tag {i}" for i in range(40)]
            ev(f"U.paste({json.dumps(chr(10).join(rows))}); true")
            wait("U.text('.file-info').includes('40 rows')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            heads = ev("U.qa('.group-head .title').map((t) => t.textContent)")
            assert any("Country: 40 not found" in x for x in heads) and any("Tags: 40 not found" in x for x in heads), heads
            assert ev("U.qa('.card').length") == 0, "40-value groups are folded"
            country = "U.qa('.group').find((g) => g.textContent.includes('Country: 40'))"
            tags = "U.qa('.group').find((g) => g.textContent.includes('Tags: 40'))"
            create_country = ev(f"(() => {{ const b = [...{country}.querySelectorAll('button')].find((b) => b.textContent === 'Create all 40'); return [b.disabled, b.title]; }})()")
            # Odoo 17+ require a country code, so countries can't be created from a name there.
            code_required = call("res.country", "fields_get", ["code"], attributes=["required"])["code"]["required"]
            if code_required:
                assert create_country[0] and "Country Code" in create_country[1], create_country
            else:
                assert not create_country[0], create_country
            shot("6-bulk")
            ev(f"[...{tags}.querySelectorAll('button')].find((b) => b.textContent === 'Create all 40').click(); true")
            wait("U.qa('.group').length === 1")
            # One country for all of them, picked through the search box.
            ev(f"(() => {{ const i = {country}.querySelector('input[type=search]'); i.value = 'Belgium'; i.dispatchEvent(new Event('input')); }})(); true")
            wait(f"!!{country}.querySelector('.dropdown li')")
            ev(f"{country}.querySelector('.dropdown li').dispatchEvent(new MouseEvent('mousedown', {{bubbles: true}})); true")
            wait("!!U.q('.notice.ok')")
            assert "40 values → created" in ev("U.text('.done-list')") and "40 values → Belgium" in ev("U.text('.done-list')"), ev("U.text('.done-list')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Import')")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Imported')", timeout=90)
            recs = call("res.partner", "search_read", [["email", "=like", "bulk%@oi.test"]], ["country_id", "category_id"])
            assert len(recs) == 40 and all(r["country_id"] and r["country_id"][1] == "Belgium" and len(r["category_id"]) == 1 for r in recs), recs[:2]
            assert call("res.partner.category", "search_count", [["name", "=like", "OI Bulk Tag %"]]) == 40
            ev("U.button('Undo').click(); true")
            ev("U.button('Delete').click(); true")
            wait("!!U.q('.toast.show') && U.text('.toast').includes('deleted')", timeout=60)
            assert call("res.partner", "search_count", [["email", "=like", "bulk%@oi.test"]], context={"active_test": False}) == 0
            assert call("res.partner.category", "search_count", [["name", "=like", "OI Bulk Tag %"]]) == 0
        check("40 unknown countries and tags: bulk create, one-for-all, undo", ui_bulk_missing)

        # ------------------------------------------------------------------
        # export
        ev("""(() => { const orig = URL.createObjectURL; URL.createObjectURL = (b) => { globalThis.__lastBlob = b; return orig(b); }; })(); true""")

        def export_data():
            ev("U.q('.modes [data-mode=export]').click(); true")
            wait("!!U.q('.choice')")
            assert "Contact" in ev("U.q('.model-picker input').value")
            shot("7-export-purpose")
            ev("U.qa('.choice')[0].click(); true")
            wait("U.qa('ol.columns li').length >= 3")
            cols = ev("U.qa('ol.columns .tech').map((x) => x.textContent)")
            assert "email" in cols and "id" not in cols, cols
            # remove the first column, add Country › Country Code with the keyboard
            first = cols[0]
            ev("U.qa('ol.columns .remove')[0].click(); true")
            assert first not in ev("U.qa('ol.columns .tech').map((x) => x.textContent)")
            ev("U.type('.adder input', 'Country'); true")
            wait("U.qa('.adder li').some((li) => li.textContent.startsWith('Country') && li.querySelector('.open'))")
            ev("""(() => { const a = U.q('.adder input'); const i = U.qa('.adder li').findIndex((li) => li.querySelector('.tech').textContent === 'country_id');
                   for (let k = 0; k < i; k++) a.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
                   a.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})); })(); true""")
            wait("!U.q('.adder .crumb').hidden")
            ev("U.type('.adder input', 'country code'); true")
            wait("U.qa('.adder li').length >= 1 && U.q('.adder li .tech').textContent === 'code'")
            ev("U.q('.adder input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); true")
            wait("U.qa('ol.columns .tech').some((x) => x.textContent === 'country_id/code')")
            shot("8-export-columns")
            n = call("res.partner", "search_count", [])
            assert f"Export {n} records" in ev("U.text('footer .btn.primary')"), ev("U.text('footer .btn.primary')")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Exported')", timeout=60)
            rows = ev("""(async () => { const b = await OdooImport.sheet.readFile('x.xlsx', await __lastBlob.arrayBuffer()); return b.sheets[0].load(); })()""")
            headers = rows[0]
            assert "Email" in headers and "Country / Country Code" in headers, headers
            assert len(rows) - 1 == n, (len(rows), n)
            bel = call("res.partner", "search_read", [["country_id.code", "=", "BE"]], ["email"], limit=1)
            if bel:
                ci, ei = headers.index("Country / Country Code"), headers.index("Email")
                assert any(r[ei] == bel[0]["email"] and r[ci] == "BE" for r in rows[1:] if bel[0]["email"]), "linked field exported"
        check("export data: list-view columns, remove/add (Country › Code), xlsx", export_data)

        def export_reimport_round_trip():
            ev("U.button('Change').click(); true")
            wait("!!U.q('.choice')")
            ev("U.qa('.choice')[1].click(); true")
            wait("U.qa('ol.columns li').length >= 2")
            cols = ev("U.qa('ol.columns .tech').map((x) => x.textContent)")
            assert cols[0] == "id" and "name" in cols, cols
            ev("U.qa('input[name=oi-format]')[1].click(); true")  # CSV
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Exported')", timeout=60)
            csv_text = ev("__lastBlob.text()")
            n = call("res.partner", "search_count", [])
            # The exported file goes straight back in: every row updates its record.
            s = ev(f"E.start('res.partner', {json.dumps(csv_text)})")
            assert s["key"] == ["id", "update"], s["key"]
            assert s["stats"]["update"] == n and s["stats"]["create"] == 0, s["stats"]
            assert all(m[1] in ("auto", "memory") for m in s["mapping"] if m[0]), s["mapping"]
            r = ev("E.run(true)")
            assert r["ok"], r["errors"][:3]
            ev("U.q('.modes [data-mode=import]').click(); true")
        check("export for re-import goes back in as updates (round trip)", export_reimport_round_trip)

        def export_lines():
            ev("U.q('.modes [data-mode=export]').click(); true")
            ev("U.type('.model-picker input', 'sale.order'); true")
            wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'sale.order')")
            ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'sale.order').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            wait("!!U.q('.choice') && U.text('.export').includes('records')")
            ev("U.qa('.choice')[0].click(); true")
            wait("U.qa('ol.columns li').length >= 2")
            before = ev("U.qa('ol.columns .tech').map((x) => x.textContent)")
            assert not any(c.startswith("order_line") for c in before), before
            ev("U.type('.adder input', 'Order Lines'); true")
            wait("U.qa('.adder li').some((li) => li.querySelector('.tech').textContent === 'order_line')")
            ev("""(() => { const a = U.q('.adder input'); const i = U.qa('.adder li').findIndex((li) => li.querySelector('.tech').textContent === 'order_line');
                   for (let k = 0; k < i; k++) a.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
                   a.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })(); true""")
            wait("U.qa('ol.columns .tech').some((x) => x.textContent.startsWith('order_line/'))")
            cols = ev("U.qa('ol.columns .tech').map((x) => x.textContent)")
            lines = [c for c in cols if c.startswith("order_line/")]
            assert lines[0] == "order_line/product_id" or "order_line/product_id" in lines[:2], lines
            assert "order_line/label" not in lines, "screen-only computed fields are left out"
            assert "order_line/product_uom_qty" in lines and "order_line/price_unit" in lines, lines
            assert "order_line/order_id" not in lines and len(lines) <= 10, lines
            shot("9-export-lines")
            ev("U.qa('input[name=oi-format]')[0].click(); true")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Exported')", timeout=60)
            rows = ev("""(async () => { const b = await OdooImport.sheet.readFile('x.xlsx', await __lastBlob.arrayBuffer()); return b.sheets[0].load(); })()""")
            n_orders = call("sale.order", "search_count", [])
            n_lines = call("sale.order.line", "search_count", [])
            assert len(rows) - 1 >= max(n_orders, n_lines * 0.9), (len(rows) - 1, n_orders, n_lines)
            assert "with lines" in ev("U.text('.notice.ok')")
            ev("U.q('.modes [data-mode=import]').click(); true")
        check("data export: adding Order Lines brings the line columns, one row per line", export_lines)

        # ------------------------------------------------------------------
        # analyze (+ the export filter)
        def pick_field(cls, text, tech=None, open_rel=False):
            cond = f"U.qa('.{cls} li').some((li) => li.querySelector('.tech').textContent === {json.dumps(tech)})" if tech else f"U.qa('.{cls} li').length > 0"
            # A headless background window may not keep focus in the box across a redraw: retype.
            for attempt in range(3):
                ev(f"U.type('.{cls} input', {json.dumps(text)}); true")
                try:
                    wait(cond, timeout=8)
                    break
                except TimeoutError:
                    continue
            try:
                wait(cond, timeout=5)
            except TimeoutError:
                state = ev(f"""({{ input: (U.q('.{cls} input') || {{}}).value, focused: __root.activeElement && __root.activeElement.outerHTML.slice(0, 120),
                    items: U.qa('.{cls} li').map((li) => li.textContent).slice(0, 8), listHidden: (U.q('.{cls} ul') || {{}}).hidden,
                    model: __odooImport.state.model, op: __odooImport.state.op && __odooImport.state.op.kind, busy: __odooImport.state.busy }})""")
                raise TimeoutError(f"{cls}: {state}")
            ev(f"""(() => {{ const a = U.q('.{cls} input'); const lis = U.qa('.{cls} li');
                   const i = {json.dumps(tech)} ? lis.findIndex((li) => li.querySelector('.tech').textContent === {json.dumps(tech)}) : 0;
                   for (let k = 0; k < i; k++) a.dispatchEvent(new KeyboardEvent('keydown', {{key: 'ArrowDown', bubbles: true}}));
                   a.dispatchEvent(new KeyboardEvent('keydown', {{key: {json.dumps('ArrowRight' if open_rel else 'Enter')}, bubbles: true}})); }})(); true""")

        def chart_ready():
            wait("!!U.q('.chart-box svg') && !U.q('.chart-box').classList.contains('loading') && !__odooImport.state.op", timeout=60)

        def analyze_contacts():
            ev("U.q('.modes [data-mode=analyze]').click(); true")
            wait("U.q('.model-picker input').value.includes('res.partner') || true")
            ev("U.type('.model-picker input', 'res.partner'); true")
            wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'res.partner')")
            ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'res.partner').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            chart_ready()
            pick_field("groupby", "Country", "country_id")
            wait("U.q('.ctl .chip').textContent === 'Country'")
            chart_ready()
            counts = {}
            for r in call("res.partner", "search_read", [], ["country_id"]):
                k = r["country_id"][1] if r["country_id"] else "None"
                counts[k] = counts.get(k, 0) + 1
            rows = ev("U.qa('.analyze table.grid tbody tr').map((tr) => [...tr.children].map((td) => td.textContent))")
            expected = sorted(counts.items())
            if len(expected) <= 10:
                got = sorted((r[0], int(r[1].replace(",", ""))) for r in rows)
                assert got == expected, (got, expected)
            total = sum(c for _, c in expected)
            assert f"{total} records" in ev("U.text('.analyze .count')"), ev("U.text('.analyze .count')")
            shot("10-analyze-bars")
            ev("U.qa('.segmented button').find((b) => b.textContent === 'Pie').click(); true")
            wait("U.qa('.chart-box .mark').length >= 1 && U.qa('.chart-box .mark').length <= 6")
            shot("11-analyze-pie")
        check("analyze contacts by country: numbers match Odoo, pie keeps 6 slices", analyze_contacts)

        def analyze_filter():
            pick_field("filter-add", "Country", "country_id")
            wait("U.qa('.filter-row').length === 1")
            ev("U.type('.filter-row .search-inline input', 'United States'); true")
            wait("!!U.q('.filter-row .search-inline li')")
            ev("U.q('.filter-row .search-inline li').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            wait("U.qa('.filter-row .tag').length === 1")
            time.sleep(0.8)
            chart_ready()
            us = call("res.partner", "search_count", [["country_id.name", "=", "United States"]])
            wait(f"U.text('.analyze .count').startsWith('{us} record')")
            # The same filter scopes the export.
            ev("U.q('.modes [data-mode=export]').click(); true")
            wait(f"U.text('.export .count').startsWith('{us} record') && U.text('.export .count').includes('match')", timeout=30)
            assert ev("U.qa('.export .filter-row').length") == 1
            ev("U.qa('.choice')[0].click(); true")
            wait("U.qa('ol.columns li').length >= 2")
            ev("U.qa('input[name=oi-format]')[1].click(); true")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Exported')", timeout=60)
            assert f"Exported {us} records" in ev("U.text('.notice.ok')"), ev("U.text('.notice.ok')")
            ev("U.q('.modes [data-mode=analyze]').click(); true")
            chart_ready()
            ev("U.q('.filter-row .remove').click(); true")
            wait("U.qa('.filter-row').length === 0")
        check("filter: Country is United States scopes the chart and the export", analyze_filter)

        def analyze_orders():
            ev("U.type('.model-picker input', 'sale.order'); true")
            wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'sale.order')")
            ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'sale.order').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            chart_ready()
            # Customer › Country, then by Status, measured by the sum of Total
            pick_field("groupby", "Customer", "partner_id", open_rel=True)
            wait("!U.q('.groupby .crumb').hidden")
            pick_field("groupby", "Country", "country_id")
            wait("U.q('.ctl .chip').textContent === 'Customer › Country'")
            chart_ready()
            pick_field("splitby", "Status", "state")
            chart_ready()
            ev("""(() => { const s = U.qa('.ctl select').find((x) => x.getAttribute('aria-label') === 'Measure');
                   s.value = 'sum:amount_total'; s.dispatchEvent(new Event('change')); })(); true""")
            chart_ready()
            title = ev("U.text('.chart-box svg text')")
            assert title == "Sum of Total by Customer › Country and Status", title
            assert ev("U.qa('.segmented button').find((b) => b.textContent === 'Pie').disabled")
            total = round(sum(r["amount_total"] for r in call("sale.order", "search_read", [], ["amount_total"])), 2)
            cells = ev("U.qa('.analyze table.grid tbody tr').map((tr) => tr.lastElementChild.textContent)")
            got = round(sum(float(c.replace(",", "")) for c in cells), 2)
            assert abs(got - total) < 0.05, (got, total)
            shot("12-analyze-stacked")
            # dates: by month -> line
            ev("U.q('.ctl .chip-x').click(); true")  # remove "Then by"
            chart_ready()
            pick_field("groupby", "Order Date", "date_order")
            chart_ready()
            assert ev("U.qa('.segmented button.suggested').map((b) => b.textContent)") == ["Line"]
            assert ev("U.qa('.chart-box .band').length") >= 1
            shot("13-analyze-line")
        check("sale orders: Customer › Country then Status, sum of Total; dates make a line", analyze_orders)

        def analyze_outputs():
            ev("U.button('PNG').click(); true")
            wait("__odooImport.state.an.lastFile && __odooImport.state.an.lastFile.name.endsWith('.png')")
            size = ev("__odooImport.state.an.lastFile.blob.size")
            assert size > 5000, size
            assert ev("__odooImport.state.an.lastFile.blob.arrayBuffer().then((b) => new Uint8Array(b).slice(1, 4).join())") == "80,78,71", "PNG signature"
            ev("U.button('Excel with chart').click(); true")
            wait("__odooImport.state.an.lastFile.name.endsWith('.xlsx')")
            names = ev("__odooImport.state.an.lastFile.blob.arrayBuffer().then((b) => OdooImport.xlsx.unzip(b)).then((z) => z.names)")
            assert "xl/charts/chart1.xml" in names, names
            chart = ev("__odooImport.state.an.lastFile.blob.arrayBuffer().then((b) => OdooImport.xlsx.unzip(b)).then((z) => z.read('xl/charts/chart1.xml'))")
            assert "<c:lineChart>" in chart, chart[:300]
            ev("U.button('Print / PDF').click(); true")
            wait("!!__odooImport.state.an.lastPrint")
            assert "<svg" in ev("__odooImport.state.an.lastPrint") and "<table" in ev("__odooImport.state.an.lastPrint")
            # save and load an analysis
            ev("U.button('Save analysis').click(); true")
            ev("const n = U.q('.save-name'); n.value = 'Orders per month'; n.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); true")
            wait("U.qa('.saved .chip-open').some((b) => b.textContent === 'Orders per month')")
            pick_field("groupby", "Salesperson", "user_id")
            chart_ready()
            ev("U.qa('.saved .chip-open').find((b) => b.textContent === 'Orders per month').click(); true")
            wait("U.q('.ctl .chip').textContent === 'Order Date'")
            chart_ready()
            ev("U.q('.modes [data-mode=import]').click(); true")
        check("outputs: PNG, Excel with a native chart, print page; saved analyses", analyze_outputs)

        def import_template():
            ev("U.q('.modes [data-mode=import]').click(); true")
            ev("U.qa('nav.steps button')[0].click(); true")
            if ev("!!U.q('.file-info')"):
                ev("U.button('Choose another file').click(); true")
            ev("U.type('.model-picker input', 'sale.order'); true")
            wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'sale.order')")
            ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'sale.order').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            wait("!!U.button('Download a template')")
            ev("U.button('Download a template').click(); true")
            wait("!!__odooImport.state.lastTemplate", timeout=60)
            info = ev("""(async () => { const t = __odooImport.state.lastTemplate; const buf = await t.blob.arrayBuffer();
                const z = await OdooImport.xlsx.unzip(buf); const b = await OdooImport.sheet.readFile(t.name, buf);
                return { name: t.name, sheets: b.sheets.map((x) => x.name), headers: (await b.sheets[0].load())[0],
                         help: (await b.sheets[1].load()).slice(0, 4), wb: await z.read('xl/workbook.xml'), s1: await z.read('xl/worksheets/sheet1.xml') }; })()""")
            assert info["name"] == "Sales Order import template.xlsx", info["name"]
            assert info["sheets"] == ["Data", "Help"] and 'state="hidden"' in info["wb"], info["sheets"]
            headers = info["headers"]
            assert "Customer" in headers and any(h.startswith("Order Lines / Product") for h in headers), headers
            assert "<dataValidations" in info["s1"], "dropdowns"
            # Fill it like a user would: a customer and two lines.
            col = {h: i for i, h in enumerate(headers)}
            prod = next(h for h in headers if h.startswith("Order Lines / Product"))
            qty = next((h for h in headers if h.startswith("Order Lines / Quantity")), None)
            rows = [[""] * len(headers) for _ in range(2)]
            rows[0][col["Customer"]] = "Azure Interior"
            rows[0][col[prod]] = "Large Cabinet"
            rows[1][col[prod]] = "FURN_8855"
            if qty:
                rows[0][col[qty]] = "2"
                rows[1][col[qty]] = "1"
            csv_text = "\n".join(",".join(f'"{v}"' for v in r) for r in [headers] + rows) + "\n"
            s2 = ev(f"E.start('sale.order', {json.dumps(csv_text)})")
            assert all(m[1] in ("auto", "memory") for m in s2["mapping"] if m[0]), s2["mapping"]
            assert not [c for c in s2["conflicts"] if c["key"].startswith("column:")], s2["conflicts"]
            assert s2["stats"]["records"] == 1, s2["stats"]
            r = ev("E.run(true)")
            assert r["ok"], r["errors"][:3]
        check("import template: Data + Help + dropdowns; filled in, it maps by itself and passes the check", import_template)


        def from_the_page():
            # The page: Contacts as a list, 2 rows ticked, then a search typed in Odoo's search bar.
            chrome.evaluate("""(() => { const b = document.querySelector('.o_switch_view.o_list, button.o_list'); if (b) b.click(); })()""")
            chrome.wait("document.querySelectorAll('.o_data_row').length >= 3", timeout=30)
            for path in ["src/page/bridge.js"]:
                chrome.evaluate((ROOT / path).read_text())  # MAIN world, as the background does
            chrome.evaluate("""(() => { const boxes = [...document.querySelectorAll('.o_data_row .o_list_record_selector input')]; boxes[0].click(); boxes[1].click(); })()""")
            chrome.wait("document.querySelectorAll('.o_data_row .o_list_record_selector input:checked').length === 2", timeout=15)
            ev("U.q('.modes [data-mode=export]').click(); true")
            wait("!!U.q('.scope') && U.text('.scope').includes('2 ticked records')", timeout=30)
            assert ev("U.q('.scope .on').textContent") == "The 2 ticked records", "ticked records chosen by default"
            wait("U.text('.export .count').startsWith('2 records')", timeout=30)
            # Untick, search "Azure" in Odoo: the export follows the list's search.
            chrome.evaluate("""(() => { document.querySelectorAll('.o_data_row .o_list_record_selector input:checked').forEach((b) => b.click()); })()""")
            chrome.evaluate("""(() => { const i = document.querySelector('.o_searchview_input'); i.focus(); i.value = 'Azure'; i.dispatchEvent(new Event('input', {bubbles: true})); })()""")
            chrome.wait("!!document.querySelector('.o_searchview_autocomplete li, .o_searchview_autocomplete .o-dropdown-item, .o_searchview_autocomplete a')", timeout=15)
            chrome.evaluate("""document.querySelector('.o_searchview_input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))""")
            chrome.wait("document.querySelector('.o_facet_values, .o_searchview_facet') !== null", timeout=15)
            azure = call("res.partner", "search_count", ["|", ["display_name", "ilike", "Azure"], ["email", "ilike", "Azure"]])
            ev("__odooImport.hide(); true")
            ev("__odooImport.show(); true")
            wait("!!U.q('.scope .on') && U.q('.scope .on').textContent === \"The list's current search\"", timeout=30)
            wait("!__odooImport.state.op && !!U.q('.export .count')", timeout=30)
            got = ev("parseInt(U.text('.export .count'))")
            assert 1 <= got <= azure + 5 and got < call("res.partner", "search_count", []), (got, azure)
            ev("U.qa('.scope button').find((b) => b.textContent === 'All records').click(); true")
            wait(f"U.text('.export .count').startsWith('{call('res.partner', 'search_count', [])} record')", timeout=30)
            ev("U.q('.modes [data-mode=import]').click(); true")
        check("start from the page: ticked records, then the list's search", from_the_page)


        def analyze_compare():
            ev("U.q('.modes [data-mode=analyze]').click(); true")
            ev("U.type('.model-picker input', 'sale.order'); true")
            wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'sale.order')")
            ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'sale.order').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
            chart_ready()
            for c in range(ev("U.qa('.filter-row').length")):
                ev("U.q('.filter-row .remove').click(); true")
            if ev("!!U.q('.ctl .chip-x')"):
                ev("U.q('.ctl .chip-x').click(); true")
            chart_ready()
            assert ev("U.qa('.ctl select').find((x) => x.getAttribute('aria-label') === 'Compare with').disabled"), "needs a date filter"
            pick_field("filter-add", "Order Date", "date_order")
            wait("U.qa('.filter-row').length === 1")
            ev("""(() => { const s = U.q('.filter-row select'); s.value = 'this_month'; s.dispatchEvent(new Event('change')); })(); true""")
            time.sleep(0.6)
            chart_ready()
            pick_field("groupby", "Customer", "partner_id")
            chart_ready()
            ev("""(() => { const s = U.qa('.ctl select').find((x) => x.getAttribute('aria-label') === 'Compare with'); s.value = 'previous'; s.dispatchEvent(new Event('change')); })(); true""")
            chart_ready()
            wait("U.qa('.analyze table.grid thead th').length === 5")
            heads = ev("U.qa('.analyze table.grid thead th').map((x) => x.textContent)")
            assert heads[3:] == ["Change", "Change %"], heads
            rows = ev("U.qa('.analyze table.grid tbody tr').map((tr) => [...tr.children].map((td) => td.textContent))")
            now_total = sum(float(r[1].replace(",", "")) for r in rows)
            before_total = sum(float(r[2].replace(",", "")) for r in rows)
            expected_now = ev("E.call('sale.order', 'search_count', [OdooImport.domain.toDomain([{path: ['date_order'], type: 'datetime', op: 'this_month'}])])")
            expected_before = ev("""(() => { const r = OdooImport.domain.compareRange({type: 'datetime', op: 'this_month'}, 'previous');
                return E.call('sale.order', 'search_count', [OdooImport.domain.toDomain([{path: ['date_order'], type: 'datetime', op: 'range', value: r}])]); })()""")
            assert (now_total, before_total) == (expected_now, expected_before), (now_total, before_total, expected_now, expected_before)
            title = ev("U.text('.chart-box svg text')")
            assert " vs " in title and "Count by Customer" in title, title
            assert ev("U.qa('.segmented button').find((b) => b.textContent === 'Pie').disabled")
            shot("15-compare")
            ev("U.button('Excel with chart').click(); true")
            wait("__odooImport.state.an.lastFile && __odooImport.state.an.lastFile.name.endsWith('.xlsx') && __odooImport.state.an.lastFile.name.includes(' vs ')")
            chart = ev("__odooImport.state.an.lastFile.blob.arrayBuffer().then((b) => OdooImport.xlsx.unzip(b)).then((z) => z.read('xl/charts/chart1.xml'))")
            assert 'grouping val="clustered"' in chart and chart.count("<c:ser>") == 2, chart[:400]
            ev("""(() => { const s = U.qa('.ctl select').find((x) => x.getAttribute('aria-label') === 'Compare with'); s.value = 'none'; s.dispatchEvent(new Event('change')); })(); true""")
            chart_ready()
            ev("U.q('.filter-row .remove').click(); true")
            chart_ready()
            ev("U.q('.modes [data-mode=import]').click(); true")
        check("compare: this month vs the previous one, totals match Odoo; Excel has both periods", analyze_compare)

        # ------------------------------------------------------------------
        # unsupported versions: the server is made to report 15.0, then 21.0
        def fake_version(major):
            ev(f"""(() => {{
                const host = document.querySelector('odoo-import-root'); if (host) host.remove();
                delete globalThis.__odooImport;
                if (!globalThis.__realFetch) globalThis.__realFetch = globalThis.fetch;
                globalThis.fetch = async (url, opts) => {{
                    const r = await __realFetch(url, opts);
                    if (!String(url).includes('get_session_info')) return r;
                    const j = await r.json();
                    j.result.server_version_info = [{major}, 0, 0, 'final', 0, ''];
                    j.result.server_version = '{major}.0';
                    return new Response(JSON.stringify(j), {{ headers: {{ 'Content-Type': 'application/json' }} }});
                }};
            }})(); true""")
            for path in SCRIPTS:
                ev((ROOT / path).read_text())

        def unsupported_old():
            fake_version(15)
            wait("!!U.q('.version-warning')")
            text = ev("U.text('.version-warning')")
            assert "Odoo 15.0 isn't supported" in text and "16 to 20" in text, text
            assert ev("!U.q('.drop') && !U.q('.model-picker')"), "tools stay hidden until the user chooses"
            shot("14-unsupported")
            ev("U.button('Try anyway').click(); true")
            wait("!U.q('.version-warning') && !!U.q('.model-picker')")
            assert "|15.0" in ev("__store['oi.versionOk'].join()")
            # remembered for this database and version
            fake_version(15)
            wait("!!U.q('.model-picker')")
            assert ev("!U.q('.version-warning')")
        check("Odoo 15: warning first, 'Try anyway' opens the tools and is remembered", unsupported_old)

        def unsupported_new():
            fake_version(21)
            wait("!!U.q('.version-warning')")
            text = ev("U.text('.version-warning')")
            assert "Newer Odoo version" in text and "21.0" in text, text
            ev("U.button('Close').click(); true")
            assert ev("document.querySelector('odoo-import-root').style.display") == "none"
            ev("globalThis.fetch = globalThis.__realFetch; true")
        check("Odoo 21: 'newer than tested' warning; Close hides the panel", unsupported_new)

    finally:
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)

    for name, error in results:
        print(("PASS " if not error else "FAIL ") + name + (f"\n     {error}" if error else ""))
    failed = sum(1 for _, e in results if e)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
