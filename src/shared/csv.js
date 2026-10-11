/* Odoo Import Export: CSV / TSV reading and writing.
 *
 * parse() handles quoted fields with embedded separators, quotes ("") and line breaks,
 * \r\n / \n / \r line ends and a leading BOM. sniff() picks the separator by which one
 * splits the first lines into the most consistent number of columns.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const SEPARATORS = [",", ";", "\t", "|"];

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function parse(text, separator) {
    text = stripBom(String(text));
    const sep = separator || sniff(text);
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          quoted = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"' && field === "") {
        quoted = true;
        i++;
      } else if (c === sep) {
        row.push(field);
        field = "";
        i++;
      } else if (c === "\n" || c === "\r") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      } else {
        field += c;
        i++;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return { rows, separator: sep };
  }

  // Count fields per line for the first lines (quotes respected) and keep the separator
  // giving the most lines with the same, greater-than-one field count.
  function sniff(text) {
    const sample = stripBom(text).slice(0, 20000);
    let best = ",";
    let bestScore = -1;
    for (const sep of SEPARATORS) {
      const counts = [];
      let count = 1;
      let quoted = false;
      for (let i = 0; i < sample.length && counts.length < 20; i++) {
        const c = sample[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === sep) count++;
        else if (!quoted && (c === "\n" || c === "\r")) {
          if (c === "\r" && sample[i + 1] === "\n") i++;
          counts.push(count);
          count = 1;
        }
      }
      if (count > 1 || !counts.length) counts.push(count);
      const freq = new Map();
      for (const k of counts) if (k > 1) freq.set(k, (freq.get(k) || 0) + 1);
      let score = 0;
      for (const [k, f] of freq) score = Math.max(score, f * 100 + k);
      if (score > bestScore) {
        bestScore = score;
        best = sep;
      }
    }
    return best;
  }

  function quote(value, sep) {
    const s = value === null || value === undefined ? "" : String(value);
    return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function serialize(rows, sep = ",") {
    return rows.map((r) => r.map((v) => quote(v, sep)).join(sep)).join("\r\n") + "\r\n";
  }

  NS.csv = { parse, sniff, serialize };
})();
