"""End-to-end test of the menu's context against a real Odoo 18+ server with Accounting.

A bill imported from Vendor Bills must be a vendor bill: the menu's default_move_type has to reach
Odoo, as it does with Odoo's own Import. Drives the real panel on the real menus and checks the
records in the database, then deletes them.

    python3 tests/e2e_menu.py --url http://127.0.0.1:8099 --db mydb [--login admin --password admin]
"""
import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("e2e", ROOT / "tests" / "e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8069")
    ap.add_argument("--db", required=True)
    ap.add_argument("--login", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--binary", default=shutil.which("google-chrome") or shutil.which("chromium"))
    opts = ap.parse_args()

    profile = tempfile.mkdtemp(prefix="odoo-import-menu-")
    chrome = e2e.Chrome(opts.binary, profile)
    failed = 0
    try:
        chrome.navigate(f"{opts.url}/web/login?db={opts.db}")
        auth = chrome.evaluate(f"""fetch('/web/session/authenticate', {{method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{jsonrpc: '2.0', method: 'call', params: {json.dumps(
                {"db": opts.db, "login": opts.login, "password": opts.password})}}})}})
            .then(r => r.json()).then(r => r.result ? r.result.uid : JSON.stringify(r.error))""")
        assert isinstance(auth, int), f"login failed: {auth}"

        def open_panel(action):
            """A fresh page on the menu, with the extension injected as the background does."""
            chrome.navigate(f"{opts.url}/odoo/action-{action}")
            chrome.wait("!!document.querySelector('.o_list_view, .o_list_renderer, .o_view_nocontent')", timeout=60)
            chrome.evaluate((ROOT / "src/page/bridge.js").read_text())
            frame = chrome.page("Page.getFrameTree")["frameTree"]["frame"]["id"]
            ctx = chrome.page("Page.createIsolatedWorld", {"frameId": frame, "worldName": "odoo-import-e2e"})["executionContextId"]
            ev = lambda js: chrome.evaluate(js, ctx)  # noqa: E731
            wait = lambda js, timeout=30: chrome.wait(js, ctx, timeout)  # noqa: E731
            ev(e2e.PRELUDE)
            for path in e2e.ENGINE:
                ev((ROOT / path).read_text())
            ev(e2e.ENGINE_HELPERS)
            for path in e2e.SCRIPTS:
                if not path.startswith("src/shared/"):
                    ev((ROOT / path).read_text())
            ev(e2e.UI_HELPERS)
            wait("U.q('.panel') && U.q('.conn').classList.contains('ok')")
            wait("U.q('.model-picker input').value.includes('account.move')")
            return ev, wait

        def import_rows(action, tsv, notice):
            """Paste, check the Columns notice, check with Odoo, import; -> the new records."""
            ev, wait = open_panel(action)
            ev(f"U.paste({json.dumps(tsv)}); true")
            wait("U.text('.file-info').includes('row')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')", timeout=60)
            shown = ev("U.text('.notice.info')")
            assert (notice in shown) if notice else ("From this menu" not in shown), shown
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Review')", timeout=60)
            wait("!__odooImport.state.op", timeout=60)
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Import')")
            ev("U.button('Check with Odoo').click(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('accepts every row')", timeout=60)
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Imported')", timeout=60)
            result = json.loads(ev("JSON.stringify({ok: __odooImport.state.result.ok, created: __odooImport.state.result.created, errors: __odooImport.state.result.errors})"))
            assert result["ok"] and result["created"], result
            call = lambda method, *args: ev(f"E.call('account.move', {json.dumps(method)}, {json.dumps(list(args))}, {{}})")  # noqa: E731
            rows = call("read", result["created"], ["move_type", "journal_id", "ref"])
            call("unlink", result["created"])
            return rows

        def types(rows):
            return sorted({r["move_type"] for r in rows})

        cases = [
            ("Vendor Bills: a vendor bill, in the purchase journal", "account.action_move_in_invoice_type", "Reference\nOI-BILL-1\nOI-BILL-2\n", "Vendor Bill", ["in_invoice"]),
            ("Customer Invoices: a customer invoice", "account.action_move_out_invoice_type", "Reference\nOI-INV-1\n", "Customer Invoice", ["out_invoice"]),
            ("Journal Entries: still an entry", "account.action_move_journal_line", "Reference\nOI-JE-1\n", "Journal Entry", ["entry"]),
            ("a column in the file beats the menu", "account.action_move_in_invoice_type", "Reference\tType\nOI-REFUND-1\tVendor Credit Note\n", None, ["in_refund"]),
        ]
        for name, action, tsv, notice, want in cases:
            try:
                rows = import_rows(action, tsv, notice)
                assert types(rows) == want, rows
                if want == ["in_invoice"]:
                    assert all("Bill" in r["journal_id"][1] or "Purchase" in r["journal_id"][1] for r in rows), rows
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}\n     {e}")
    finally:
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)
    print(f"{len(cases) - failed}/{len(cases)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
