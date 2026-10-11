/* Odoo Import Export: convert cell text to the exact form Odoo's import expects.
 *
 * Output is always a string written into the CSV sent to base_import with fixed
 * options: ISO dates, "." decimals, no thousands separator, "1"/"0" booleans and
 * selection keys. A failed conversion returns {ok: false, reason, candidates?}.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const { parseNumber, parseBool, parseDate } = NS.profile;
  const { norm, similarity } = NS.text;

  const CSV_OPTIONS = {
    date_format: "%Y-%m-%d",
    datetime_format: "%Y-%m-%d %H:%M:%S",
    float_decimal_separator: ".",
    float_thousand_separator: "",
  };

  function selectionMatch(field, raw) {
    const v = norm(raw);
    const pairs = [...(field.selection || []), ...(field.selectionEn || [])];
    for (const [key, label] of pairs) {
      if (norm(key) === v || norm(label) === v) return { ok: true, out: String(key) };
    }
    // Ranked suggestions among the selection's own values.
    const seen = new Set();
    const candidates = [];
    for (const [key, label] of field.selection || []) {
      if (seen.has(key)) continue;
      seen.add(key);
      const en = (field.selectionEn || []).find(([k]) => k === key);
      const score = Math.max(similarity(raw, label), similarity(raw, key), en ? similarity(raw, en[1]) : 0);
      candidates.push({ id: String(key), label, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return { ok: false, reason: "not-in-selection", candidates };
  }

  // Convert one non-empty cell for a scalar field. prof: the column profile (formats).
  function convert(field, raw, prof = {}) {
    const s = String(raw).trim();
    switch (field.type) {
      case "char":
      case "text":
      case "html":
      case "id":
      case "binary":
        return { ok: true, out: s };
      case "integer": {
        const n = parseNumber(s, prof.decimal || ".");
        if (n === null || !Number.isInteger(n)) return { ok: false, reason: "not-an-integer" };
        return { ok: true, out: String(n) };
      }
      case "dbid": {
        if (!/^\d+$/.test(s)) return { ok: false, reason: "not-an-integer" };
        return { ok: true, out: s };
      }
      case "float":
      case "monetary": {
        const n = parseNumber(s, prof.decimal || ".");
        if (n === null) return { ok: false, reason: "not-a-number" };
        return { ok: true, out: String(n) };
      }
      case "boolean": {
        const b = parseBool(s);
        if (b === null) return { ok: false, reason: "not-a-boolean", candidates: [{ id: "1", label: "Yes", score: 0 }, { id: "0", label: "No", score: 0 }] };
        return { ok: true, out: b ? "1" : "0" };
      }
      case "date": {
        const d = parseDate(s, prof.dateOrder === "MDY" ? "MDY" : "DMY");
        if (!d) return { ok: false, reason: "not-a-date" };
        return { ok: true, out: d.date };
      }
      case "datetime": {
        const d = parseDate(s, prof.dateOrder === "MDY" ? "MDY" : "DMY");
        if (!d) return { ok: false, reason: "not-a-date" };
        return { ok: true, out: `${d.date} ${d.time || "00:00:00"}` };
      }
      case "selection":
        return selectionMatch(field, s);
      default:
        return { ok: true, out: s };
    }
  }

  const REASONS = {
    "not-an-integer": "isn't a whole number",
    "not-a-number": "isn't a number",
    "not-a-boolean": "isn't yes/no",
    "not-a-date": "isn't a date",
    "not-in-selection": "isn't one of the allowed values",
  };

  NS.values = { convert, selectionMatch, CSV_OPTIONS, REASONS };
})();
