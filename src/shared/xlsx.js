/* Odoo Import Export: read .xlsx and .ods workbooks without any library.
 *
 * Both are ZIP archives of XML: the archive is read from its central directory and
 * deflated entries are inflated with the browser's DecompressionStream('deflate-raw').
 * Every cell comes back as a string; dates become ISO ("2024-03-01" or
 * "2024-03-01 14:30:00") so the profiler and Odoo don't have to guess their format.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  class SheetError extends Error {}

  // ---------------------------------------------------------------------------
  // ZIP
  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new SheetError("This file isn't a valid .xlsx/.ods archive.");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const entries = new Map();
    const decoder = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nameLen = view.getUint16(e.offset + 26, true);
      const extraLen = view.getUint16(e.offset + 28, true);
      const start = e.offset + 30 + nameLen + extraLen;
      const data = bytes.subarray(start, start + e.size);
      if (e.method === 0) return decoder.decode(data);
      if (e.method !== 8) throw new SheetError(`Unsupported compression in ${name}.`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    return { names: [...entries.keys()], read };
  }

  function xml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new SheetError("The workbook contains invalid XML.");
    return doc;
  }

  // Children / descendants by local name, ignoring namespace prefixes.
  function kids(el, name) {
    return [...el.children].filter((c) => c.localName === name);
  }
  function all(el, name) {
    return [...el.getElementsByTagName("*")].filter((c) => c.localName === name);
  }
  function attr(el, name) {
    for (const a of el.attributes) if (a.localName === name) return a.value;
    return null;
  }

  const pad = (n) => String(n).padStart(2, "0");

  // Excel serial date -> ISO string (date only when there is no time part).
  function serialToIso(serial, date1904) {
    const ms = Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86400000);
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    return secs ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
  }

  const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

  function isDateFormat(code) {
    const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
    return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare) && !/general/i.test(bare);
  }

  function colIndex(ref) {
    const letters = ref.replace(/\d+$/, "");
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function numberText(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    // Round away binary noise such as 0.30000000000000004.
    return String(Number.isInteger(n) ? n : parseFloat(n.toPrecision(15)));
  }

  // ---------------------------------------------------------------------------
  // XLSX
  async function readXlsx(zip) {
    const wb = xml(await zip.read("xl/workbook.xml"));
    const date1904 = all(wb, "workbookPr").some((e) => /^(1|true)$/.test(attr(e, "date1904") || ""));
    const relsText = await zip.read("xl/_rels/workbook.xml.rels");
    const rels = new Map();
    if (relsText) for (const r of all(xml(relsText), "Relationship")) rels.set(attr(r, "Id"), attr(r, "Target"));

    const shared = [];
    const sst = await zip.read("xl/sharedStrings.xml");
    if (sst) {
      for (const si of all(xml(sst), "si")) {
        // Rich text runs: concatenate every <t>, skipping phonetic <rPh> hints.
        shared.push(all(si, "t").filter((t) => t.parentElement.localName !== "rPh").map((t) => t.textContent).join(""));
      }
    }

    const dateStyles = new Set();
    const stylesText = await zip.read("xl/styles.xml");
    if (stylesText) {
      const styles = xml(stylesText);
      const custom = new Map();
      for (const f of all(styles, "numFmt")) custom.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") || "");
      const cellXfs = all(styles, "cellXfs")[0];
      if (cellXfs) {
        kids(cellXfs, "xf").forEach((xf, i) => {
          const id = Number(attr(xf, "numFmtId") || 0);
          if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
        });
      }
    }

    const sheets = [];
    for (const s of all(wb, "sheet")) {
      // Hidden sheets hold helpers (dropdown lists of a template…), not data.
      if (/hidden/i.test(attr(s, "state") || "")) continue;
      const name = attr(s, "name");
      let target = rels.get(attr(s, "id")) || "";
      target = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      sheets.push({
        name,
        load: async () => {
          const text = await zip.read(target);
          if (!text) return [];
          const rows = [];
          for (const r of all(xml(text), "row")) {
            const rowIndex = Number(attr(r, "r") || rows.length + 1) - 1;
            const row = [];
            let next = 0;
            for (const c of kids(r, "c")) {
              const ref = attr(c, "r");
              const ci = ref ? colIndex(ref) : next;
              next = ci + 1;
              const t = attr(c, "t");
              const v = kids(c, "v")[0];
              let value = "";
              if (t === "s") value = v ? shared[Number(v.textContent)] ?? "" : "";
              else if (t === "inlineStr") value = all(c, "t").map((x) => x.textContent).join("");
              else if (t === "b") value = v ? (v.textContent === "1" ? "TRUE" : "FALSE") : "";
              else if (t === "e") value = "";
              else if (t === "str" || t === "d") value = v ? v.textContent : "";
              else if (v) {
                value = dateStyles.has(Number(attr(c, "s") || -1)) ? serialToIso(Number(v.textContent), date1904) : numberText(v.textContent);
              }
              row[ci] = value;
            }
            for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
            rows[rowIndex] = row;
          }
          for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
          return rows;
        },
      });
    }
    return sheets;
  }

  // ---------------------------------------------------------------------------
  // ODS
  const MAX_REPEAT = 1000; // trailing empty rows/columns are often "repeated" a million times

  function odsCellValue(cell) {
    const type = attr(cell, "value-type");
    if (type === "date") {
      const v = attr(cell, "date-value") || "";
      const [d, t] = v.split("T");
      return t && !/^00:00(:00)?/.test(t) ? `${d} ${t.slice(0, 8)}` : d;
    }
    if (type === "float" || type === "percentage" || type === "currency") return numberText(attr(cell, "value"));
    if (type === "boolean") return attr(cell, "boolean-value") === "true" ? "TRUE" : "FALSE";
    return kids(cell, "p").map((p) => p.textContent).join("\n");
  }

  async function readOds(zip) {
    const doc = xml(await zip.read("content.xml"));
    return all(doc, "table").map((table) => ({
      name: attr(table, "name"),
      load: async () => {
        const rows = [];
        for (const r of all(table, "table-row")) {
          const row = [];
          for (const c of [...r.children].filter((x) => x.localName === "table-cell" || x.localName === "covered-table-cell")) {
            const value = odsCellValue(c);
            const rep = Math.min(Number(attr(c, "number-columns-repeated") || 1), value ? MAX_REPEAT : 1);
            for (let i = 0; i < rep; i++) row.push(value);
          }
          while (row.length && row[row.length - 1] === "") row.pop();
          const rep = Math.min(Number(attr(r, "number-rows-repeated") || 1), row.length ? MAX_REPEAT : 1);
          for (let i = 0; i < rep; i++) rows.push(row.slice());
        }
        return rows;
      },
    }));
  }

  // Returns [{name, load(): Promise<string[][]>}].
  async function readWorkbook(buffer) {
    const zip = await unzip(buffer);
    if (zip.names.includes("xl/workbook.xml")) return readXlsx(zip);
    if (zip.names.includes("content.xml")) return readOds(zip);
    throw new SheetError("Unsupported workbook: save it as .xlsx, .ods or .csv.");
  }

  NS.xlsx = { readWorkbook, unzip, serialToIso, isDateFormat, SheetError };
})();
