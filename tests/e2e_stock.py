"""End-to-end test of stock counts (stock.quant) against a real Odoo 18+ server with Inventory.

Same browser driver as tests/e2e.py. An administrator (over JSON-RPC, outside the browser) makes
products, lots, locations and their stock (named with a stamp, so runs don't meet) and a user
who is only an Inventory User (not an administrator, not an Inventory Administrator). That user
counts the stock through the engine and through the panel, as a stock clerk would; the quants are
checked in the database: one quant per product/lot/location, counted quantities set and nothing
applied, undo putting the counts back. Applying is checked both ways: by the administrator in
Odoo, and from the extension ("Apply now"), which leaves stock moved since the count for review.

    python3 tests/e2e_stock.py --url http://127.0.0.1:8020 --db mydb [--admin-login admin --admin-password admin]
    python3 tests/e2e_stock.py ... --as-admin          # count as the administrator instead
"""
import argparse
import http.cookiejar
import importlib.util
import json
import secrets
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("e2e", ROOT / "tests" / "e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


class Admin:
    """JSON-RPC as the administrator, outside the browser (the browser is the counting user's)."""

    def __init__(self, url, db, login, password):
        self.url = url
        self.company = None  # the company everything is made in (allowed_company_ids)
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        res = self._post("/web/session/authenticate", {"db": db, "login": login, "password": password})
        assert res.get("uid"), f"admin login failed: {res}"

    def _post(self, path, params):
        req = urllib.request.Request(self.url + path, json.dumps({"jsonrpc": "2.0", "method": "call", "params": params}).encode(), {"Content-Type": "application/json"})
        out = json.loads(self.opener.open(req, timeout=120).read())
        if out.get("error"):
            raise RuntimeError(out["error"]["data"].get("message") or out["error"]["message"])
        return out.get("result")  # left out when the method returns nothing (Odoo 18, 19)

    def __call__(self, model, method, *args, **kw):
        if self.company:
            kw["context"] = {"allowed_company_ids": [self.company], **kw.get("context", {})}
        return self._post(f"/web/dataset/call_kw/{model}/{method}", {"model": model, "method": method, "args": list(args), "kwargs": kw})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8069")
    ap.add_argument("--db", required=True)
    ap.add_argument("--admin-login", default="admin")
    ap.add_argument("--admin-password", default="admin")
    ap.add_argument("--as-admin", action="store_true", help="count as the administrator, not as an Inventory User")
    ap.add_argument("--binary", default=shutil.which("google-chrome") or shutil.which("chromium"))
    opts = ap.parse_args()
    admin = Admin(opts.url, opts.db, opts.admin_login, opts.admin_password)
    # Odoo's runbot refuses the import wizard (base_import) to outside addresses (HTTP 403), while
    # plain load() works: there the extension is made to take its path for databases without
    # base_import (load(), no "Check with Odoo").
    try:
        admin("base_import.import", "create", [{"res_model": "res.partner", "file": "", "file_name": "x.csv", "file_type": "text/csv"}])
        no_base_import = False
    except urllib.error.HTTPError as e:
        no_base_import = e.code == 403
    if no_base_import:
        print("base_import is refused here (runbot): imports go through load(), without a check")
    stamp = time.strftime("%H%M%S")
    # a company with a warehouse (a shared runbot may have the administrator in another one)
    wh = admin("stock.warehouse", "search_read", [], ["lot_stock_id", "company_id"], order="company_id, id", limit=1)[0]
    admin.company = wh["company_id"][0]
    xmlid = lambda ref: admin("ir.model.data", "search_read", [["module", "=", ref.split(".")[0]], ["name", "=", ref.split(".")[1]]], ["res_id"])[0]["res_id"]  # noqa: E731
    if opts.as_admin:
        login, password = opts.admin_login, opts.admin_password
    else:
        # an Inventory User only: internal user + stock.group_stock_user (Odoo 19 renamed groups_id)
        login, password = f"oic_counter_{stamp}", secrets.token_hex(8)
        groups = "group_ids" if "group_ids" in admin("res.users", "fields_get", ["group_ids"]) else "groups_id"
        user = admin("res.users", "create", [{"name": f"OIC Counter {stamp}", "login": login, "password": password,
                                               "company_id": admin.company, "company_ids": [(6, 0, [admin.company])],
                                               groups: [(6, 0, [xmlid("base.group_user"), xmlid("stock.group_stock_user")])]}])[0]
        for group, want in (("stock.group_stock_user", True), ("stock.group_stock_manager", False), ("base.group_system", False), ("base.group_erp_manager", False)):
            assert admin("res.users", "has_group", [user], group) == want, f"counting user: {group} should be {want}"

    profile = tempfile.mkdtemp(prefix="odoo-import-e2e-stock-")
    chrome = e2e.Chrome(opts.binary, profile)
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
                {"db": opts.db, "login": login, "password": password})}}})}})
            .then(r => r.json()).then(r => r.result ? r.result.uid : JSON.stringify(r.error))""")
        assert isinstance(auth, int), f"login failed: {auth}"
        info = chrome.evaluate("""fetch('/web/webclient/version_info', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {}})}).then((r) => r.json()).then((r) => r.result.server_version_info)""")
        print(f"Odoo {'.'.join(map(str, info[:2]))}, counting as {login}")
        chrome.navigate(f"{opts.url}/odoo/physical-inventory")
        chrome.wait("!!document.querySelector('.o_main_navbar')", timeout=180)

        frame = chrome.page("Page.getFrameTree")["frameTree"]["frame"]["id"]
        ctx = chrome.page("Page.createIsolatedWorld", {"frameId": frame, "worldName": "odoo-import-e2e"})["executionContextId"]
        ev = lambda js: chrome.evaluate(js, ctx)  # noqa: E731
        wait = lambda js, timeout=30: chrome.wait(js, ctx, timeout)  # noqa: E731
        ev(e2e.PRELUDE)
        if no_base_import:
            ev("""(() => { const real = globalThis.fetch;
              globalThis.fetch = (u, o) => String(u).includes('/base_import.import/')
                ? Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 200, message: 'Odoo Server Error',
                    data: { name: 'odoo.exceptions.AccessError', message: 'base_import refused (runbot)' } } }), { headers: { 'Content-Type': 'application/json' } }))
                : real(u, o); })(); true""")
        for path in e2e.ENGINE:
            ev((ROOT / path).read_text())
        ev(e2e.ENGINE_HELPERS)
        call = lambda model, method, *args, **kw: ev(f"E.call({json.dumps(model)}, {json.dumps(method)}, {json.dumps(list(args))}, {json.dumps(kw)})")  # noqa: E731
        ctx_inv = {"inventory_mode": True}

        # ------------------------------------------------------------------
        # stock of our own (made by the administrator): Desk (no lots), Chair (lots), Lamp; a zone with a shelf under it
        zone = admin("stock.location", "create", [{"name": f"OIC Zone {stamp}", "location_id": wh["lot_stock_id"][0], "usage": "internal"}])[0]
        shelf = admin("stock.location", "create", [{"name": "Shelf", "location_id": zone, "usage": "internal"}])[0]
        zone_name = admin("stock.location", "read", [zone], ["display_name"])[0]["display_name"]
        shelf_name = admin("stock.location", "read", [shelf], ["display_name"])[0]["display_name"]
        storable = {"is_storable": True, "type": "consu"}
        desk, chair, lamp = admin("product.product", "create", [
            {"name": f"OIC Desk {stamp}", "default_code": f"OIC-DESK-{stamp}", **storable},
            {"name": f"OIC Chair {stamp}", "default_code": f"OIC-CHAIR-{stamp}", "tracking": "lot", **storable},
            {"name": f"OIC Lamp {stamp}", "default_code": f"OIC-LAMP-{stamp}", **storable},
        ])
        lot1 = admin("stock.lot", "create", [{"name": f"L1-{stamp}", "product_id": chair}])[0]

        def put(product, location, qty, lot=False):
            """Set the stock the way the Physical Inventory screen does: count and apply."""
            ids = admin("stock.quant", "create", [{"product_id": product, "location_id": location, "lot_id": lot, "inventory_quantity": qty}], context=ctx_inv)
            admin("stock.quant", "action_apply_inventory", ids, context=ctx_inv)

        put(desk, zone, 10)
        put(chair, zone, 5, lot1)
        put(lamp, zone, 7)
        put(lamp, shelf, 3)

        def quants(product, location=None):
            dom = [["product_id", "=", product]] + ([["location_id", "=", location]] if location else [])
            return admin("stock.quant", "search_read", dom, ["location_id", "lot_id", "quantity", "inventory_quantity", "inventory_quantity_set"], order="id")

        def counting(csv_text, mode, sublocations=False):
            """Map, look up and plan a count; returns the plan's summary."""
            ev(f"E.start('stock.quant', {json.dumps(csv_text)})")
            return ev(f"""(async () => {{
                const inv = E.OI.inventory;
                inv.ensure(E.job);
                E.job.count.sublocations = {json.dumps(sublocations)};
                inv.setMode(E.job, {json.dumps(mode)});
                E.analysis = E.OI.plan.analyze(E.job);
                E.plan = await inv.prepare(E.deps, E.job, E.analysis);
                const p = E.plan;
                return {{ mapping: E.job.mapping.map((m) => m.path && m.path.join('/')), conflicts: E.analysis.conflicts.map((c) => c.key),
                  errors: p.errors.map((e) => e.message), stats: p.stats, warnings: p.warnings.map((w) => w.title),
                  lines: [...p.lines, ...p.zeros].map((l) => [(/Desk|Chair|Lamp/.exec(l.productLabel) || [l.productLabel])[0], l.lotLabel, l.locationLabel.split('/').pop(), l.onHand, l.counted, l.action]) }};
            }})()""")

        def run(dryrun=False):
            return ev(f"""(async () => {{
                const r = await E.OI.inventory.run(E.client, E.deps.executor, E.plan, {{ dryrun: {json.dumps(dryrun)}, uid: {auth} }});
                if (!{json.dumps(dryrun)}) E.last = {{ model: 'stock.quant', created: r.created, deps: r.deps, count: r.count }};
                return r;
            }})()""")

        rows = lambda *r: "Product,Lot/Serial Number,Location,Counted Quantity\n" + "\n".join(",".join(map(str, x)) for x in r) + "\n"  # noqa: E731

        def listed():
            s = counting(rows(
                (f"OIC-DESK-{stamp}", "", zone_name, 12),
                (f"OIC-CHAIR-{stamp}", f"L1-{stamp}", zone_name, 4),
                (f"OIC-CHAIR-{stamp}", f"L2-{stamp}", zone_name, 2),
                (f"OIC-DESK-{stamp}", "", zone_name, 1),
            ), "listed")
            assert s["mapping"] == ["product_id", "lot_id", "location_id", "inventory_quantity"], s["mapping"]
            assert not s["conflicts"] and not s["errors"], s
            assert s["stats"]["update"] == 2 and s["stats"]["create"] == 1 and s["stats"]["newLots"] == 1, s["stats"]
            assert sorted(s["lines"]) == sorted([["Desk", "", f"OIC Zone {stamp}", 10, 13, "update"], ["Chair", f"L1-{stamp}", f"OIC Zone {stamp}", 5, 4, "update"],
                                                 ["Chair", f"L2-{stamp}", f"OIC Zone {stamp}", 0, 2, "create"]]), s["lines"]
            dry = run(dryrun=True)
            assert dry["ok"], dry["errors"]
            assert dry["noDryRun"] == no_base_import, dry
            assert not any(q["inventory_quantity_set"] for q in quants(desk) + quants(chair)), "a check saves nothing"
            assert admin("stock.lot", "search_count", [["name", "=", f"L2-{stamp}"]]) == 0, "nor lots"
            r = run()
            assert r["ok"], r["errors"]
            d = quants(desk, zone)
            assert len(d) == 1 and d[0]["quantity"] == 10 and d[0]["inventory_quantity"] == 13 and d[0]["inventory_quantity_set"], d
            c = quants(chair, zone)
            assert len(c) == 2, c
            by_lot = {q["lot_id"][1]: q for q in c}
            assert by_lot[f"L1-{stamp}"]["inventory_quantity"] == 4 and by_lot[f"L1-{stamp}"]["quantity"] == 5, by_lot
            assert by_lot[f"L2-{stamp}"]["inventory_quantity"] == 2 and by_lot[f"L2-{stamp}"]["quantity"] == 0, by_lot
            assert not any(q["inventory_quantity_set"] for q in quants(lamp)), "listed: other products untouched"
        check("listed: rows find their quants (no duplicates), summed, new lot; nothing applied", listed)

        def undo_listed():
            errors = ev("E.undo()")
            assert not errors, errors
            assert not any(q["inventory_quantity_set"] for q in quants(desk) + quants(chair)), quants(chair)
            assert len(quants(chair, zone)) == 1, "the new empty quant is gone"
            assert admin("stock.lot", "search_count", [["name", "=", f"L2-{stamp}"]]) == 0, "and its new lot"
        check("undo: counts cleared, new quant and lot removed", undo_listed)

        def overwrite():
            s = counting(rows((f"OIC-DESK-{stamp}", "", zone_name, 9)), "overwrite")
            got = sorted(s["lines"])
            assert got == sorted([["Desk", "", f"OIC Zone {stamp}", 10, 9, "update"], ["Chair", f"L1-{stamp}", f"OIC Zone {stamp}", 5, 0, "zero"],
                                  ["Lamp", "", f"OIC Zone {stamp}", 7, 0, "zero"]]), got
            s2 = counting(rows((f"OIC-DESK-{stamp}", "", zone_name, 9)), "overwrite", sublocations=True)
            assert ["Lamp", "", "Shelf", 3, 0, "zero"] in s2["lines"], s2["lines"]
            assert s2["stats"]["net"] == -16, s2["stats"]
            r = run()
            assert r["ok"], r["errors"]
            assert quants(lamp, shelf)[0]["inventory_quantity_set"] and quants(lamp, shelf)[0]["inventory_quantity"] == 0
            assert quants(desk, zone)[0]["inventory_quantity"] == 9
            assert not ev("E.undo()")
            assert not any(q["inventory_quantity_set"] for q in quants(desk) + quants(chair) + quants(lamp))
        check("overwrite: the rest of the location counted 0, sublocations on demand", overwrite)

        def add():
            s = counting(rows((f"OIC-LAMP-{stamp}", "", zone_name, 3)), "add")
            assert s["lines"] == [["Lamp", "", f"OIC Zone {stamp}", 7, 10, "update"]], s["lines"]
        check("add to on hand: counted = on hand + sheet", add)

        def repairs_duplicates():
            # Odoo's own import of a row without id: a second quant next to the one in stock
            call("stock.quant", "load", ["product_id/.id", "location_id/.id", "inventory_quantity"], [[str(desk), str(zone), "4"]], context={"import_file": True})
            assert len(quants(desk, zone)) == 2, quants(desk, zone)
            s = counting(rows((f"OIC-DESK-{stamp}", "", zone_name, 8)), "listed")
            assert s["stats"]["zero"] == 1 and any("split over 2 quants" in w for w in s["warnings"]), s
            r = run()
            assert r["ok"], r["errors"]
            q = quants(desk, zone)
            assert [x["inventory_quantity"] for x in q] == [8, 0] and all(x["inventory_quantity_set"] for x in q), q
            admin("stock.quant", "action_apply_inventory", [x["id"] for x in q], context=ctx_inv)  # an Inventory Administrator applies
            assert sum(x["quantity"] for x in quants(desk, zone)) == 8, quants(desk, zone)
            errors = ev("E.undo()")
            assert errors and "already applied" in errors[0], errors
        check("an earlier duplicate quant is counted 0; applied counts stay on undo", repairs_duplicates)

        def apply_now():
            # its own locations: the zone's stock is what the later tests count
            zone = admin("stock.location", "create", [{"name": f"OIC Apply {stamp}", "location_id": wh["lot_stock_id"][0], "usage": "internal"}])[0]
            shelf = admin("stock.location", "create", [{"name": "Shelf", "location_id": zone, "usage": "internal"}])[0]
            names = {loc["id"]: loc["display_name"] for loc in admin("stock.location", "read", [zone, shelf], ["display_name"])}
            vase = admin("product.product", "create", [{"name": f"OIC Vase {stamp}", "default_code": f"OIC-VASE-{stamp}", **storable}])[0]
            put(vase, zone, 4)
            put(vase, shelf, 6)
            counting(rows((f"OIC-VASE-{stamp}", "", names[zone], 2), (f"OIC-VASE-{stamp}", "", names[shelf], 8)), "listed")
            r = run()
            assert r["ok"], r["errors"]
            on_zone, on_shelf = quants(vase, zone)[0], quants(vase, shelf)[0]
            # stock moved in between on the shelf: Odoo would ask what to do (conflict wizard)
            admin("stock.quant", "write", [on_shelf["id"]], {"quantity": 7})
            reason = f"OIC count {stamp}"
            a = ev(f"E.OI.inventory.apply(E.client, E.last, {{ reason: {json.dumps(reason)} }})")
            assert not a["errors"], a["errors"]
            assert a["applied"] == [on_zone["id"]] and a["outdated"] == [on_shelf["id"]], a
            z = quants(vase, zone)[0]
            assert z["quantity"] == 2 and not z["inventory_quantity_set"], z
            assert quants(vase, shelf)[0]["inventory_quantity_set"], "the moved one still waits"
            moves = admin("stock.move", "search_read", [["product_id", "=", vase], ["is_inventory", "=", True], ["state", "=", "done"]], ["reference", "product_uom_qty"])
            assert any(reason in (m["reference"] or "") and m["product_uom_qty"] == 2 for m in moves), moves
            again = ev(f"E.OI.inventory.apply(E.client, E.last, {{ reason: {json.dumps(reason)} }})")
            assert again["applied"] == [] and again["gone"] == 1, ("nothing applied twice", again)
            admin("stock.quant", "action_clear_inventory_quantity", [on_shelf["id"]])
        check("apply now: waiting counts applied with the reason, moved stock left for review", apply_now)

        def errors_and_blanks():
            service = admin("product.product", "create", [{"name": f"OIC Service {stamp}", "type": "service"}])[0]
            customers = admin("stock.location", "search_read", [["usage", "=", "customer"]], ["display_name"], limit=1)[0]["display_name"]
            s = counting(rows((f"OIC Service {stamp}", "", zone_name, 1), (f"OIC-LAMP-{stamp}", "", zone_name, ""), (f"OIC-DESK-{stamp}", "", customers, 1)), "listed")
            assert not s["conflicts"], s["conflicts"]
            errors = " | ".join(sorted(s["errors"]))
            assert len(s["errors"]) == 2 and "consumable or a service" in errors and "internal location" in errors, s["errors"]
            assert s["stats"]["blank"] == 1, s["stats"]
            admin("product.product", "unlink", [service])
        check("services and non-internal locations refused, empty counts left out", errors_and_blanks)

        def lots_rules():
            s = counting(rows(
                (f"OIC-CHAIR-{stamp}", "", zone_name, 3),  # tracked, no lot: refused
                (f"OIC-CHAIR-{stamp}", "", zone_name, 0),  # tracked, counted 0 without a lot: fine
                (f"OIC-DESK-{stamp}", f"L1-{stamp}", zone_name, 2),  # not tracked, with a lot: refused
                (f"OIC-DESK-{stamp}", "", zone_name, 2),  # fine
            ), "listed")
            assert len(s["errors"]) == 2, s["errors"]
            assert any(f"OIC Chair {stamp}" in e and "tracked by lots" in e for e in s["errors"]), s["errors"]
            assert any(f"OIC Desk {stamp}" in e and "no lots or serial numbers" in e for e in s["errors"]), s["errors"]
            assert sorted(l[0] for l in s["lines"]) == ["Chair", "Desk"], s["lines"]
        check("lots: refused without a lot on a tracked product, or with one on an untracked product", lots_rules)

        def sole_location():
            many = admin("stock.location", "search_count", [["usage", "=", "internal"]]) > 1
            multi = call("res.users", "has_group", [auth], "stock.group_stock_multi_locations")
            assert isinstance(multi, bool), multi  # callable by an Inventory User, on every version
            got = ev(f"E.OI.inventory.soleLocation(E.client, {auth})")
            if many and multi:
                assert got is None, got
            elif not many:
                assert got and got["why"] == "the only stock location", got
            # without the location column, the count takes it (when there is one)
            s = counting("Product,Counted Quantity\n" + f"OIC-DESK-{stamp},2\n", "listed")
            if got is None:
                assert any("No location" in e for e in s["errors"]) or not s["lines"], s
        check("one location: found (or not) the way Odoo would, by an Inventory User", sole_location)

        def count_sheet():
            t = ev(f"E.OI.inventory.countSheet(E.client, {{ locations: [{zone}], sublocations: true, label: 'zone' }})")
            sheet = t["sheets"][0]
            assert sheet["headers"][-2:] == ["On Hand (not imported)", "Counted Quantity"], sheet["headers"]
            products = sorted(r[0] for r in sheet["rows"])
            assert products == sorted([f"OIC-CHAIR-{stamp}", f"OIC-DESK-{stamp}", f"OIC-LAMP-{stamp}", f"OIC-LAMP-{stamp}"]), products
            # filled in and imported back, it maps by itself
            filled = "\n".join([",".join(sheet["headers"])] + [",".join(str(c if c is not None else "") for c in r[:-1]) + ",1" for r in sheet["rows"]])
            s = counting(filled, "listed")
            assert s["mapping"] == ["product_id", "lot_id", "location_id", None, "inventory_quantity"], s["mapping"]
            assert not s["conflicts"] and not s["errors"] and s["stats"]["update"] == 4, s
        check("count sheet: the location's stock, and it maps back by itself", count_sheet)

        # ------------------------------------------------------------------
        # the panel, with the page bridge in the page's own world, as the extension injects them
        chrome.evaluate((ROOT / "src/page/bridge.js").read_text() + "; true")
        for path in e2e.SCRIPTS:
            if not path.startswith("src/shared/"):
                ev((ROOT / path).read_text())
        ev(e2e.UI_HELPERS)

        def ui():
            wait(f"U.q('.panel') && U.q('.conn').classList.contains('ok') && U.text('.conn').includes({json.dumps(opts.db)})", timeout=60)
            try:
                wait("U.q('.model-picker input').value.includes('stock.quant')", timeout=60)
            except TimeoutError:
                bridge = ev("""new Promise((res) => { document.addEventListener('odoo-import-export:res', (ev) => res(ev.detail));
                  document.dispatchEvent(new CustomEvent('odoo-import-export:req', { detail: JSON.stringify({ id: 999, cmd: 'context' }) }));
                  setTimeout(() => res('no answer'), 3000); })""")
                raise AssertionError(("model not detected", ev("U.q('.model-picker input').value"), chrome.evaluate("location.href"), str(bridge)[:300]))
            assert ev("U.qa('.template-row').some((r) => r.textContent.includes('Counting a location'))"), "count sheet offered"
            tsv = "\n".join(["Item\tSerial\tBin\tQty", f"OIC-DESK-{stamp}\t\t{zone_name}\t11", f"OIC-LAMP-{stamp}\t\t{zone_name}\t6"])
            ev(f"U.paste({json.dumps(tsv)}); true")
            wait("U.text('.file-info').includes('2 rows')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            ev("U.next(); true")
            wait("!!U.q('.count-modes')", timeout=60)
            assert ev("U.q('.count-mode.on input').value") == "listed"
            ev("U.qa('.count-mode input').find((i) => i.value === 'overwrite').click(); true")
            wait("U.q('.count-mode.on input').value === 'overwrite' && U.text('.count-modes').includes('Include sublocations')")
            ev("U.next(); true")
            wait("!!U.q('table.count-table')", timeout=60)
            text = ev("U.text('table.count-table')")
            assert "counted 0" in text and "Chair" in text, text
            ev("U.button('Check with Odoo').click(); true")
            if no_base_import:
                wait("!!U.q('.notice.warn') && U.text('.notice.warn').includes('no import module')", timeout=60)
            else:
                wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('accepts every count')", timeout=60)
            assert ev("U.q('footer .btn.primary').textContent") == "Set 3 counts", ev("U.q('footer .btn.primary').textContent")
            ev("U.next(); true")
            wait("!!U.q('.notice.ok') && U.text('.notice.ok').includes('Counts set on 3 stock lines, 1 counted 0')", timeout=60)
            assert ev("!!U.button('Review & apply in Odoo')") and ev("!!U.button('Apply now')"), "both ways to apply offered"
            assert "isn't changed yet" in ev("U.text('.notice.ok')"), ev("U.text('.notice.ok')")
            ev("U.button('Apply now').click(); true")
            wait("!!U.q('.apply-form') && !!U.button('Apply 3 counts')")
            ev("U.qa('.apply-form button').find((b) => b.textContent === 'Cancel').click(); true")
            wait("!U.q('.apply-form') && !!U.button('Apply now')")
            counted = [q for q in quants(desk, zone) if q["inventory_quantity_set"]]
            assert [q["inventory_quantity"] for q in counted] == [11], ("one counted Desk quant, no new one", quants(desk, zone))
            assert quants(chair, zone)[0]["inventory_quantity_set"], ("Chair counted 0", quants(chair, zone))
            ev("U.button('Undo').click(); true")
            ev("U.button('Take back').click(); true")
            wait("!U.button('Take back') && !U.button('Undoing')", timeout=30)
            assert not any(q["inventory_quantity_set"] for q in quants(desk) + quants(chair) + quants(lamp)), quants(desk)
            # Review: Physical Inventory opened in the web client, on the To Apply filter
            ev("U.button('Review & apply in Odoo').click(); true")
            chrome.wait("[...document.querySelectorAll('.o_searchview_facet')].some((f) => f.textContent.includes('To Apply'))", timeout=30)
            ev("__odooImport.show(); true")
            # Apply now, from the panel: the stock moves, and the Odoo list behind is reloaded in place
            ev("U.button('Import another file').click(); true")
            wait("!!U.q('textarea.paste')")
            ev(f"U.paste({json.dumps(chr(10).join(['Item' + chr(9) + 'Bin' + chr(9) + 'Qty', f'OIC-LAMP-{stamp}' + chr(9) + shelf_name + chr(9) + '4']))}); true")
            wait("U.text('.file-info').includes('1 row')")
            ev("U.next(); true")
            wait("U.q('nav.steps button.active').textContent.includes('Columns')")
            ev("U.next(); true")
            wait("!!U.q('.count-modes')", timeout=60)
            ev("U.next(); true")
            wait("!!U.q('table.count-table')", timeout=60)
            ev("U.next(); true")
            wait("!!U.button('Apply now')", timeout=60)
            ev("U.button('Apply now').click(); true")
            wait("!!U.button('Apply 1 count')")
            chrome.evaluate("document.querySelector('.o_action_manager .o_content').dataset.oie = 'old'; true")
            ev("U.button('Apply 1 count').click(); true")
            wait("U.text('.notice.ok').includes('Applied 1 count')", timeout=60)
            assert [q["quantity"] for q in quants(lamp, shelf)] == [4] and not quants(lamp, shelf)[0]["inventory_quantity_set"], quants(lamp, shelf)
            chrome.wait("!!document.querySelector('.o_action_manager .o_content') && !document.querySelector('.o_action_manager .o_content').dataset.oie", timeout=30)
            assert chrome.evaluate("[...document.querySelectorAll('.o_searchview_facet')].some((f) => f.textContent.includes('To Apply'))"), "the reload keeps the filter"
        check("panel: paste, overwrite mode, check, set counts, undo, apply now, review", ui)

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
