/* Odoo Import Export: turn a dropped file or a paste into a clean table.
 *
 *   table = { headers: string[], rows: string[][], lines: number[] }
 *
 * `lines` keeps the 1-based row number of each data row in the source sheet, so every
 * message can point at the row the user sees in their spreadsheet.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  // UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252 (what Excel writes as "CSV").
  function decode(buffer) {
    const b = new Uint8Array(buffer);
    if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), encoding: "utf-16le" };
    if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), encoding: "utf-16be" };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b), encoding: "utf-8" };
    } catch {
      return { text: new TextDecoder("windows-1252").decode(b), encoding: "windows-1252" };
    }
  }

  // Returns {kind, sheets: [{name, load()}], encoding?, separator?}.
  async function readFile(name, buffer) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (ext === "xlsx" || ext === "xlsm" || ext === "ods") {
      return { kind: ext, sheets: await NS.xlsx.readWorkbook(buffer) };
    }
    if (ext === "xls") throw new NS.xlsx.SheetError("Old .xls files aren't supported: save it as .xlsx or .csv first.");
    const { text, encoding } = decode(buffer);
    const { rows, separator } = NS.csv.parse(text);
    return { kind: "csv", encoding, separator, sheets: [{ name, load: async () => rows }] };
  }

  function readPaste(text) {
    const { rows, separator } = NS.csv.parse(text, text.includes("\t") ? "\t" : undefined);
    return { kind: "paste", separator, sheets: [{ name: "Pasted data", load: async () => rows }] };
  }

  const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";
  const looksLikeData = (v) => /^[-+]?[\d\s.,%$€£¥]+$/.test(v) || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(v) || /^(true|false)$/i.test(v);

  // The header is the first row, among the first ten, that is mostly filled; it must be
  // made of labels (no numbers, dates or booleans), else the sheet has no header (-1).
  // Sparse rows above it (report titles, blank lines) are skipped.
  function detectHeader(rows) {
    const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.filter((v) => !isEmpty(v)).length));
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const cells = rows[i].map((v) => String(v ?? "").trim()).filter(Boolean);
      if (cells.length < Math.max(1, Math.ceil(width * 0.5))) continue;
      return cells.every((v) => !looksLikeData(v)) ? i : -1;
    }
    return -1;
  }

  function columnName(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // Build the table: trims cells, drops empty rows and columns that are empty in every
  // row including the header, and names header-less columns "Column A", "Column B"...
  function buildTable(rows, headerRow = detectHeader(rows)) {
    const width = Math.max(0, ...rows.map((r) => r.length));
    const keep = [];
    for (let c = 0; c < width; c++) {
      if (rows.some((r, i) => i >= Math.max(headerRow, 0) && !isEmpty(r[c]))) keep.push(c);
    }
    const headers = keep.map((c, k) => {
      const h = headerRow >= 0 ? String(rows[headerRow][c] ?? "").trim() : "";
      return h || `Column ${columnName(k)}`;
    });
    // Repeated headers get a suffix so every column has a distinct name.
    const seen = new Map();
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i].toLowerCase();
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) headers[i] = `${headers[i]} (${n})`;
    }
    const data = [];
    const lines = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = keep.map((c) => String(rows[i][c] ?? "").trim());
      if (row.every((v) => v === "")) continue;
      data.push(row);
      lines.push(i + 1);
    }
    return { headers, rows: data, lines, headerRow };
  }

  NS.sheet = { decode, readFile, readPaste, detectHeader, buildTable, columnName };
})();
