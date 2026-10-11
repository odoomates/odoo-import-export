"""Capture the store screenshots (1280x800) into store/screenshots/ from a real Odoo.

    python3 tools/make_screenshots.py --url http://127.0.0.1:8069 --db mydb [--login admin --password admin]

Uses the headless-Chrome harness of tests/e2e.py. Best on a database with demo data and the
Sales app. The import shots use the sample contacts; they are removed again at the end.
"""
import argparse
import base64
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from e2e import PRELUDE, SCRIPTS, UI_HELPERS, Chrome  # noqa: E402

OUT = ROOT / "store" / "screenshots"
W, H = 1280, 800


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8069")
    ap.add_argument("--db", required=True)
    ap.add_argument("--login", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--binary", default=shutil.which("google-chrome") or shutil.which("chromium"))
    opts = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="oie-shots-")
    chrome = Chrome(opts.binary, profile)
    try:
        chrome.page("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
        chrome.navigate(f"{opts.url}/web/login?db={opts.db}")
        uid = chrome.evaluate(f"""fetch('/web/session/authenticate', {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{jsonrpc: '2.0', method: 'call', params: {json.dumps({"db": opts.db, "login": opts.login, "password": opts.password})}}})}})
            .then(r => r.json()).then(r => r.result && r.result.uid)""")
        assert isinstance(uid, int), "login failed"
        info = chrome.evaluate("""fetch('/web/webclient/version_info', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {}})}).then((r) => r.json()).then((r) => r.result.server_version_info)""")
        modern = isinstance(info[0], int) and (info[0], info[1]) >= (17, 2)
        chrome.navigate(f"{opts.url}/odoo/contacts" if modern else f"{opts.url}/web#action=contacts.action_contacts")
        chrome.wait("!!document.querySelector('.o_main_navbar') && !!document.querySelector('.o_kanban_record, .o_data_row')", timeout=60)

        frame = chrome.page("Page.getFrameTree")["frameTree"]["frame"]["id"]
        ctx = chrome.page("Page.createIsolatedWorld", {"frameId": frame, "worldName": "oie-shots"})["executionContextId"]
        chrome.evaluate(PRELUDE, ctx)
        chrome.evaluate("__store['oi.triedSample'] = false; true", ctx)
        for path in SCRIPTS:
            chrome.evaluate((ROOT / path).read_text(), ctx)
        chrome.evaluate(UI_HELPERS, ctx)
        ev = lambda js: chrome.evaluate(js, ctx)  # noqa: E731
        wait = lambda js, timeout=60: chrome.wait(js, ctx, timeout)  # noqa: E731
        wait("U.q('.conn').classList.contains('ok') && U.q('.model-picker input').value.includes('res.partner')")

        def shot(name):
            ev("U.q('.toast').classList.remove('show'); (document.activeElement || {}).blur && document.activeElement.blur(); true")
            time.sleep(0.6)
            png = chrome.page("Page.captureScreenshot", {"format": "png"})["data"]
            (OUT / f"{name}.png").write_bytes(base64.b64decode(png))
            print(f"store/screenshots/{name}.png")

        # 1. Import: the sample contacts, columns matched by themselves
        wait("!!U.button('Try it') && !U.button('Try it').disabled")
        ev("U.button('Try it').click(); true")
        wait("!!U.q('.file-info') && !!U.q('.sample-guide')")
        ev("U.next(); true")
        wait("U.q('nav.steps button.active').textContent.includes('Columns')")
        shot("1-import-columns")

        # 2. Review: close matches, a tag to create, an unknown country
        ev("U.next(); true")
        wait("U.q('nav.steps button.active').textContent.includes('Review') && !__odooImport.state.op")
        shot("2-import-review")

        # 3. Settled, checked and imported, with the undo
        ev("U.button('Accept all') && U.button('Accept all').click(); true")
        wait("!U.qa('.card').some((c) => c.textContent.includes('close match'))")
        ev("[...U.qa('.card').find((c) => c.textContent.includes('Sample tag')).querySelectorAll('button')].find((b) => b.textContent.startsWith('Create')).click(); true")
        ev("[...U.qa('.card').find((c) => c.textContent.includes('Atlantis')).querySelectorAll('button')].find((b) => b.textContent === 'Leave empty').click(); true")
        wait("!!U.q('.notice.ok')")
        ev("U.next(); true")
        wait("U.q('nav.steps button.active').textContent.includes('Import')")
        ev("U.button('Check with Odoo').click(); true")
        wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('accepts every row')")
        ev("U.next(); true")
        wait("U.text('.sample-guide').includes('Done:')")
        shot("3-import-done")

        # 4. Export: sales orders with their lines
        ev("U.q('.modes [data-mode=export]').click(); true")
        ev("U.type('.model-picker input', 'sale.order'); true")
        wait("U.qa('.model-picker li').some((li) => li.querySelector('.tech').textContent === 'sale.order')")
        ev("U.qa('.model-picker li').find((li) => li.querySelector('.tech').textContent === 'sale.order').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); true")
        wait("!!U.q('.choice') && !__odooImport.state.op && U.q('.model-picker input').value.includes('sale.order') && !!U.q('.export .count')")
        time.sleep(1)  # the record count and the page check redraw the tab once
        for _ in range(3):
            ev("U.q('.choice') && U.qa('.choice')[0].click(); true")
            try:
                wait("U.qa('ol.columns li').length >= 2", timeout=15)
                break
            except TimeoutError:
                continue
        if not ev("U.qa('ol.columns .tech').some((x) => x.textContent.startsWith('order_line/'))"):
            ev("U.type('.adder input', 'Order Lines'); true")
            wait("U.qa('.adder li').some((li) => li.querySelector('.tech').textContent === 'order_line')")
            ev("""(() => { const a = U.q('.adder input'); const i = U.qa('.adder li').findIndex((li) => li.querySelector('.tech').textContent === 'order_line');
                   for (let k = 0; k < i; k++) a.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
                   a.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })(); true""")
            wait("U.qa('ol.columns .tech').some((x) => x.textContent.startsWith('order_line/'))")
        ev("U.q('.export ol.columns').scrollTop = 0; true")
        shot("4-export")

        # 5. Analyze: sales by customer, sum of the total
        ev("U.q('.modes [data-mode=analyze]').click(); true")
        wait("!!U.q('.chart-box svg') && !__odooImport.state.op")
        ev("""(() => { const s = U.qa('.ctl select').find((x) => x.getAttribute('aria-label') === 'Measure'); s.value = 'sum:amount_total'; s.dispatchEvent(new Event('change')); })(); true""")
        time.sleep(0.5)
        wait("!!U.q('.chart-box svg') && !__odooImport.state.op && !U.q('.chart-box').classList.contains('loading')")
        ev("U.qa('.segmented button').find((b) => b.textContent === 'Bars').click(); true")
        time.sleep(0.5)
        shot("5-analyze")

    finally:
        # Remove the sample contacts and tag, even if a shot failed.
        try:
            ev("""(async () => {
                const c = OdooImport.rpc.createClient(); await c.connect();
                const ids = await c.call('res.partner', 'search', [[['email', '=like', 'sample+%@example.com']]], {}, {active_test: false});
                if (ids.length) await c.call('res.partner', 'unlink', [ids]);
                const tags = await c.call('res.partner.category', 'search', [[['name', '=like', 'Sample tag %']]]);
                if (tags.length) await c.call('res.partner.category', 'unlink', [tags]);
                return true; })()""")
        except Exception as e:  # noqa: BLE001
            print("cleanup failed:", e)
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
