"""Run the Odoo Import Export unit tests in headless Chrome.

    python3 tools/run_tests.py

The page is driven over the DevTools protocol (tests/e2e.py's small client) and the
results are read once the page has written them, so slow async tests (compression)
can't be cut short.
"""
import functools
import http.server
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("e2e", ROOT / "tests" / "e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="odoo-import-unit-")
    chrome = e2e.Chrome(shutil.which("google-chrome") or shutil.which("chromium"), profile)
    try:
        # Report uncaught errors (a syntax error in a test file would otherwise just time out).
        chrome.page("Runtime.enable")
        chrome.navigate(f"http://127.0.0.1:{server.server_port}/tests/index.html")
        try:
            raw = chrome.wait("document.getElementById('results') && document.getElementById('results').textContent", timeout=60)
        except TimeoutError:
            print("No test results after 60 s. Page errors:", chrome.evaluate("JSON.stringify(window.__errors || [])"))
            return 1
    finally:
        chrome.close()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    results = json.loads(raw)
    failed = [r for r in results if not r["ok"]]
    for r in results:
        print(("PASS " if r["ok"] else "FAIL ") + r["name"] + ("" if r["ok"] else f"\n     {r['error']}"))
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
