// Tiny test harness: results are written into the page as JSON so
// tools/run_tests.py can read them from headless Chrome.
const results = [];

export function test(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
    }
}

export function eq(actual, expected, label = "") {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(`${label ? label + ": " : ""}expected ${b}, got ${a}`);
    }
}

export function finish() {
    const el = document.createElement("pre");
    el.id = "results";
    el.textContent = JSON.stringify(results);
    document.body.append(el);
}

export async function atest(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
    }
}
