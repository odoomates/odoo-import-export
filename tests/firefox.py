"""Firefox checks: unit tests, the packaged add-on, and a smoke test against Odoo.

    python3 tests/firefox.py [--url http://127.0.0.1:8069 --db mydb --login admin --password admin]

Drives Firefox (headless) with geckodriver over WebDriver:
  1. the unit tests (tests/index.html) run in Firefox's engine;
  2. dist/firefox is installed as a temporary add-on (Firefox refuses an invalid manifest);
  3. with --url/--db: the scripts run in an Odoo page as the panel would, and a real import
     (check, import, undo), an Excel export and a chart (PNG) are done there.
"""
import argparse
import functools
import http.server
import json
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import e2e  # noqa: E402  (scripts list, prelude and helpers shared with the Chrome test)


class WebDriver:
    def __init__(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        binary = shutil.which("geckodriver") or "/snap/bin/geckodriver"
        self.proc = subprocess.Popen([binary, "--port", str(self.port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/status", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        caps = {"capabilities": {"alwaysMatch": {"browserName": "firefox", "moz:firefoxOptions": {"args": ["-headless"]}}}}
        self.session = self.post("/session", caps)["sessionId"]

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["value"]
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.load(e).get("value", {}).get("message", str(e))) from None

    def post(self, path, body):
        return self.request("POST", path, body)

    def s(self, path):
        return f"/session/{self.session}{path}"

    def get(self, url):
        self.post(self.s("/url"), {"url": url})

    def js(self, script, *args):
        return self.post(self.s("/execute/sync"), {"script": script, "args": list(args)})

    # Firefox runs WebDriver scripts in a sandbox per call: code that must share the page's
    # globals (the extension's scripts, the test helpers) runs in the page through <script>
    # elements, and answers through the DOM, which both sides see.
    def inject(self, code):
        self.js("const s = document.createElement('script'); s.textContent = arguments[0]; document.documentElement.appendChild(s); s.remove();", code)

    def page(self, expression, timeout=120):
        self._seq = getattr(self, "_seq", 0) + 1
        out = f"__fx_out_{self._seq}"
        self.inject(f"""(async () => {{
            const el = document.createElement('template'); el.id = {json.dumps(out)}; document.documentElement.appendChild(el);
            try {{ const v = await ({expression}); el.dataset.res = JSON.stringify({{ ok: v === undefined ? null : v }}); }}
            catch (e) {{ el.dataset.res = JSON.stringify({{ error: String(e && e.stack || e) }}); }}
        }})();""")
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.js(f"const el = document.getElementById({json.dumps(out)}); return el && el.dataset.res ? el.dataset.res : null;")
            if raw:
                self.js(f"document.getElementById({json.dumps(out)}).remove()")
                res = json.loads(raw)
                if "error" in res:
                    raise RuntimeError(res["error"])
                return res["ok"]
            time.sleep(0.15)
        raise TimeoutError(expression)

    def page_wait(self, expression, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.page(f"!!({expression})", timeout=10):
                    return True
            except RuntimeError:
                pass
            time.sleep(0.2)
        raise TimeoutError(expression)

    def wait(self, expression, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.js(f"return !!({expression})"):
                    return True
            except RuntimeError:
                pass
            time.sleep(0.2)
        raise TimeoutError(expression)

    def close(self):
        try:
            self.request("DELETE", f"/session/{self.session}")
        finally:
            self.proc.terminate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--db")
    ap.add_argument("--login", default="admin")
    ap.add_argument("--password", default="admin")
    opts = ap.parse_args()
    results = []

    def check(name, fn):
        try:
            fn()
            results.append((name, None))
        except Exception as e:  # noqa: BLE001 - report every failure
            results.append((name, f"{type(e).__name__}: {e}"))

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(e2e_quiet_handler(), directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    wd = WebDriver()
    try:
        print("Firefox", wd.js("return navigator.userAgent.match(/Firefox\\/[\\d.]+/)[0]"))

        def unit():
            wd.get(f"http://127.0.0.1:{server.server_port}/tests/index.html")
            wd.wait("document.getElementById('results')", timeout=90)
            res = json.loads(wd.js("return document.getElementById('results').textContent"))
            failed = [r for r in res if not r["ok"]]
            assert not failed, [(r["name"], r["error"]) for r in failed]
            print(f"     {len(res)} unit tests")
        check("unit tests pass in Firefox", unit)

        def addon():
            subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], check=True, capture_output=True)
            addon_id = wd.post(wd.s("/moz/addon/install"), {"path": str(ROOT / "dist" / "firefox"), "temporary": True})
            manifest = json.loads((ROOT / "dist" / "firefox" / "manifest.json").read_text())
            assert addon_id == manifest["browser_specific_settings"]["gecko"]["id"], addon_id
        check("the Firefox build installs as an add-on", addon)

        if opts.url and opts.db:
            def login():
                wd.get(f"{opts.url}/web/login?db={opts.db}")
                uid = wd.page(f"""fetch('/web/session/authenticate', {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
                    body: JSON.stringify({{jsonrpc: '2.0', method: 'call', params: {json.dumps({"db": opts.db, "login": opts.login, "password": opts.password})}}})}})
                    .then((r) => r.json()).then((r) => r.result && r.result.uid)""")
                assert isinstance(uid, int), uid
                wd.get(f"{opts.url}/odoo/contacts")
                wd.wait("document.querySelector('.o_main_navbar')", timeout=60)
                for script in (e2e.PRELUDE, *[(ROOT / p).read_text() for p in e2e.ENGINE], e2e.ENGINE_HELPERS):
                    wd.inject(script)
                assert wd.page("!!(globalThis.OdooImport && globalThis.OdooImport.text && globalThis.E)")
            check("Odoo page: log in and load the scripts", login)

            def engine_import():
                csv_text = "Name,E-mail,Country,Tags\nOI Fox One,fox1@oi.test,Belgium,Vendor\nOI Fox Two,fox2@oi.test,Frnace,Prospects\n"
                s = wd.page(f"E.start('res.partner', {json.dumps(csv_text)})")
                assert [m[0] for m in s["mapping"]] == ["name", "email", "country_id", "category_id"], s["mapping"]
                assert [c["key"] for c in s["conflicts"]] == ["m2o:2:frnace"], s["conflicts"]
                wd.page("E.decide('m2o:2:frnace', {action: 'pick', id: E.job.resolutions.get(2).get('Frnace').candidates[0].id})")
                assert wd.page("E.run(true)")["ok"]
                r = wd.page("E.run(false)")
                assert r["ok"] and len(r["created"]) == 2, r
                n = wd.page("E.call('res.partner', 'search_count', [[['email', '=like', 'fox%@oi.test'], ['country_id.code', 'in', ['BE', 'FR']]]])")
                assert n == 2, n
                assert not wd.page("E.undo()")
                assert wd.page("E.call('res.partner', 'search_count', [[['email', '=like', 'fox%@oi.test']]], {}, {active_test: false})") == 0
            check("import in Firefox: mapping, a close match, check, import, undo", engine_import)

            def panel():
                for p in e2e.SCRIPTS:
                    if not p.startswith("src/shared/"):
                        wd.inject((ROOT / p).read_text())
                wd.inject(e2e.UI_HELPERS)
                wd.page_wait("U.q('.conn') && U.q('.conn').classList.contains('ok')", timeout=30)
                # Export: data, Excel
                wd.page("U.q('.modes [data-mode=export]').click()")
                wd.page_wait("U.q('.choice')", timeout=30)
                wd.page("(() => { const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__lastBlob = b; return o(b); }; })()")
                wd.page("U.qa('.choice')[0].click()")
                wd.page_wait("U.qa('ol.columns li').length >= 2", timeout=30)
                wd.page("(U.qa('input[name=oi-format]')[0].click(), U.next())")
                wd.page_wait("U.q('.notice.ok') && U.text('.notice.ok').includes('Exported')", timeout=60)
                rows = wd.page("window.__lastBlob.arrayBuffer().then((b) => OdooImport.sheet.readFile('x.xlsx', b)).then((b) => b.sheets[0].load())")
                assert len(rows) > 2 and rows[0], rows[:2]
                # Analyze: a chart, then its PNG
                wd.page("U.q('.modes [data-mode=analyze]').click()")
                wd.page_wait("U.q('.chart-box svg') && !__odooImport.state.op", timeout=60)
                assert wd.page("U.qa('.chart-box .mark').length") >= 1
                wd.page("U.button('PNG').click()")
                wd.page_wait("__odooImport.state.an.lastFile && __odooImport.state.an.lastFile.name.endsWith('.png')", timeout=30)
                sig = wd.page("__odooImport.state.an.lastFile.blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b).slice(1, 4)).join())")
                assert sig == "80,78,71", sig
            check("panel in Firefox: Export to Excel, Analyze chart and PNG", panel)
    finally:
        wd.close()
        server.shutdown()

    for name, error in results:
        print(("PASS " if not error else "FAIL ") + name + (f"\n     {error}" if error else ""))
    failed = sum(1 for _, e in results if e)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


def e2e_quiet_handler():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    return Quiet


if __name__ == "__main__":
    sys.exit(main())
