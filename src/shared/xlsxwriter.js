/* Odoo Import Export: write .xlsx files without any library.
 *
 * One sheet, a bold frozen header with an autofilter, typed cells (numbers, booleans,
 * real dates) and column widths fitted to the content. Strings are written inline
 * (no shared-strings table) and the ZIP is deflated with CompressionStream('deflate-raw').
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const enc = new TextEncoder();

  // ---------------------------------------------------------------------------
  // ZIP
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // files: [{name, text}] -> Blob (a ZIP archive)
  async function zip(files, type = "application/zip") {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = enc.encode(f.text);
      const packed = await deflate(data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 8, true); // deflate
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, packed.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, packed);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 8, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, packed.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + packed.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
  }

  // ---------------------------------------------------------------------------
  // XLSX
  // XML can't hold most control characters: drop them.
  const xmlText = (s) =>
    String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function colName(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // ISO date / datetime text -> Excel serial number (days since 1899-12-30).
  function serial(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(text));
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return ms / 86400000 + 25569;
  }

  const STYLE = { header: 1, date: 2, datetime: 3 };
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3EDF2"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // ---------------------------------------------------------------------------
  // native chart (DrawingML) over the sheet's data: categories in column A, one series per
  // following column, header row 1. chart = {type: "col"|"bar"|"line"|"pie"|"doughnut",
  // stacked, title, colors: [hex per series or per category for pies]}
  function chartXml(chart, sheet, n, seriesCount) {
    const ref = (col, r1, r2) => `'${sheet.replace(/'/g, "''")}'!$${colName(col)}$${r1}${r2 ? `:$${colName(col)}$${r2}` : ""}`;
    const fill = (hex) => `<a:solidFill><a:srgbClr val="${hex.replace("#", "").toUpperCase()}"/></a:solidFill>`;
    const pie = chart.type === "pie" || chart.type === "doughnut";
    const sers = [];
    for (let k = 0; k < seriesCount; k++) {
      const color = (chart.colors && chart.colors[k]) || "#2a78d6";
      let body = `<c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:strRef><c:f>${ref(k + 1, 1)}</c:f></c:strRef></c:tx>`;
      if (pie) {
        body += Array.from({ length: n }, (_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill((chart.colors && chart.colors[i]) || "#2a78d6")}<a:ln w="19050">${fill("#FFFFFF")}</a:ln></c:spPr></c:dPt>`).join("");
        body += `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>`;
      } else if (chart.type === "line") {
        body += `<c:spPr><a:ln w="28575" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${fill(color)}<a:ln w="19050">${fill("#FFFFFF")}</a:ln></c:spPr></c:marker>`;
      } else {
        body += `<c:spPr>${fill(color)}</c:spPr><c:invertIfNegative val="0"/>`;
      }
      body += `<c:cat><c:strRef><c:f>${ref(0, 2, n + 1)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${ref(k + 1, 2, n + 1)}</c:f></c:numRef></c:val>`;
      if (chart.type === "line") body += `<c:smooth val="0"/>`;
      sers.push(`<c:ser>${body}</c:ser>`);
    }
    const grid = `<c:majorGridlines><c:spPr><a:ln w="6350">${fill("#E1E0D9")}</a:ln></c:spPr></c:majorGridlines>`;
    const axisLine = `<c:spPr><a:ln w="6350">${fill("#C3C2B7")}</a:ln></c:spPr>`;
    const text = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="52514E"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
    const horizontal = chart.type === "bar";
    const axes = `<c:catAx><c:axId val="500"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}${text}<c:crossAx val="501"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="501"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/>${grid}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${text}<c:crossAx val="500"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
    let plot;
    if (chart.type === "pie") plot = `<c:pieChart><c:varyColors val="1"/>${sers.join("")}<c:firstSliceAng val="0"/></c:pieChart>`;
    else if (chart.type === "doughnut") plot = `<c:doughnutChart><c:varyColors val="1"/>${sers.join("")}<c:firstSliceAng val="0"/><c:holeSize val="60"/></c:doughnutChart>`;
    else if (chart.type === "line") plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers.join("")}<c:marker val="1"/><c:axId val="500"/><c:axId val="501"/></c:lineChart>${axes}`;
    else plot = `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/><c:grouping val="${chart.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${sers.join("")}<c:gapWidth val="${chart.stacked ? 60 : 80}"/>${chart.stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="500"/><c:axId val="501"/></c:barChart>${axes}`;
    const title = chart.title
      ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"/><a:t>${xmlText(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
      : `<c:autoTitleDeleted val="1"/>`;
    const showLegend = pie || seriesCount > 1;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${showLegend ? `<c:legend><c:legendPos val="${pie ? "r" : "b"}"/><c:overlay val="0"/>${text}</c:legend>` : ""}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr>${fill("#FFFFFF")}<a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
  }

  function drawingXml(col, rows) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 10}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${1 + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
  }

  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const safeName = (n, i) => String(n || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
  const quoteSheet = (n) => `'${n.replace(/'/g, "''")}'`;

  function cell(ref, v, type) {
    if (v === null || v === undefined || v === "" || (v === false && type !== "boolean")) return "";
    if (type === "boolean" || typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v === true || v === "True" || v === "1" || v === 1 ? 1 : 0}</v></c>`;
    if ((type === "number" || typeof v === "number") && v !== "" && Number.isFinite(Number(v))) return `<c r="${ref}"><v>${Number(v)}</v></c>`;
    if (type === "date" || type === "datetime") {
      const n = serial(v);
      if (n !== null) return `<c r="${ref}" s="${type === "date" ? STYLE.date : STYLE.datetime}"><v>${type === "date" ? Math.floor(n) : n}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(v).slice(0, 32767))}</t></is></c>`;
  }

  /* One worksheet. sheet: {headers, rows, types, filter, validations: [{col, ref}], wrap}
   * validations point at a range (the hidden "Lists" sheet) giving a dropdown in that column. */
  function sheetXml(sheet, { drawing = false } = {}) {
    const { headers, rows, types = [] } = sheet;
    const widths = headers.map((h) => Math.min(60, Math.max(8, String(h).length + 2)));
    const out = [];
    if (headers.length) out.push(`<row r="1">${headers.map((h, c) => `<c r="${colName(c)}1" t="inlineStr" s="${sheet.plainHeader ? 0 : STYLE.header}"><is><t>${xmlText(h)}</t></is></c>`).join("")}</row>`);
    rows.forEach((r, i) => {
      const n = i + (headers.length ? 2 : 1);
      let cells = "";
      for (let c = 0; c < r.length; c++) {
        const v = r[c];
        cells += cell(`${colName(c)}${n}`, v, types[c]);
        if (i < 200 && v !== null && v !== undefined && c < widths.length) {
          const len = types[c] === "datetime" ? 17 : types[c] === "date" ? 11 : String(v).split("\n")[0].length + 2;
          widths[c] = Math.min(sheet.maxWidth || 60, Math.max(widths[c], len));
        }
      }
      out.push(`<row r="${n}">${cells}</row>`);
    });
    const lastRow = rows.length + (headers.length ? 1 : 0);
    const lastCol = colName(Math.max(0, Math.max(headers.length, ...rows.map((r) => r.length)) - 1));
    const filter = headers.length && sheet.filter !== false && !drawing;
    const dv = (sheet.validations || []).filter((v) => v.ref);
    return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">
<dimension ref="A1:${lastCol}${Math.max(1, lastRow)}"/>
<sheetViews><sheetView workbookViewId="0">${headers.length && sheet.freeze !== false ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ""}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${widths.length ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : ""}
<sheetData>${out.join("")}</sheetData>
${filter ? `<autoFilter ref="A1:${colName(headers.length - 1)}${lastRow}"/>` : ""}
${dv.length ? `<dataValidations count="${dv.length}">${dv.map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" errorTitle="Not in the list" error="${xmlText(v.error || "Pick a value from the list, or leave the cell empty.")}" sqref="${colName(v.col)}2:${colName(v.col)}${v.rows || 1001}"><formula1>${xmlText(v.ref)}</formula1></dataValidation>`).join("")}</dataValidations>` : ""}
${drawing ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
  }

  /* A workbook of several sheets: [{name, headers, rows, types, hidden, filter, validations: [{col, values}]}].
   * Dropdown values go to a hidden "Lists" sheet. chart (optional) is drawn on the first sheet,
   * over its data (see chartXml). Returns a Blob. */
  async function book({ sheets, chart = null }) {
    const all = sheets.map((sh, i) => ({ ...sh, name: safeName(sh.name, i) }));
    // Dropdown lists: one column each in the hidden Lists sheet.
    const lists = [];
    for (const sh of all) {
      sh.validations = (sh.validations || []).filter((v) => v.values && v.values.length).map((v) => {
        const col = lists.length;
        lists.push(v.values);
        return { ...v, ref: `${quoteSheet("Lists")}!$${colName(col)}$1:$${colName(col)}$${v.values.length}` };
      });
    }
    if (lists.length) {
      const height = Math.max(...lists.map((l) => l.length));
      all.push({ name: "Lists", hidden: true, headers: [], plainHeader: true, filter: false, freeze: false,
        rows: Array.from({ length: height }, (_, r) => lists.map((l) => (r < l.length ? l[r] : ""))) });
    }
    const files = [];
    all.forEach((sh, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sh, { drawing: !!chart && i === 0 }) }));
    if (chart) {
      const first = all[0];
      files.push(
        { name: "xl/worksheets/_rels/sheet1.xml.rels", text: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>` },
        { name: "xl/drawings/drawing1.xml", text: drawingXml(first.headers.length + 1, 20) },
        { name: "xl/drawings/_rels/drawing1.xml.rels", text: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/chart" Target="../charts/chart1.xml"/></Relationships>` },
        { name: "xl/charts/chart1.xml", text: chartXml(chart, first.name, first.rows.length, first.headers.length - 1) },
      );
    }
    const overrides = all.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + (chart ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' : "");
    const filters = all.map((sh, i) => (sh.headers.length && sh.filter !== false && !(chart && i === 0)
      ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(quoteSheet(sh.name))}!$A$1:$${colName(sh.headers.length - 1)}$${sh.rows.length + 1}</definedName>` : "")).join("");
    return zip([
      { name: "[Content_Types].xml", text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: "_rels/.rels", text: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", text: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${all.map((sh, i) => `<sheet name="${xmlText(sh.name)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ""}</workbook>` },
      { name: "xl/_rels/workbook.xml.rels", text: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${all.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", text: STYLES },
      ...files,
    ], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  /* One sheet: headers, rows, types ("number" | "boolean" | "date" | "datetime" | "text"),
   * optional chart. Strings longer than Excel's cell limit are cut. */
  function workbook({ headers, rows, types = [], sheetName = "Sheet1", chart = null }) {
    return book({ sheets: [{ name: sheetName, headers, rows, types }], chart });
  }

  NS.xlsxwriter = { workbook, book, zip, crc32, serial, colName };
})();
