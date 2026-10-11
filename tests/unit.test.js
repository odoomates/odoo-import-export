import { test, atest, eq, finish } from "./harness.js";

const { text, csv, sheet, profile, xlsx, columns, values, plan, execute, schema, xlsxwriter, domain, analyze, chart } = globalThis.OdooImport;

function ok(cond, label) {
    if (!cond) throw new Error(label || "assertion failed");
}

// ---------------------------------------------------------------------------
// text
test("norm strips accents, case and separators", () => {
    eq(text.norm("  Café_Zoë / Name-2 "), "cafe zoe name 2");
    eq(text.compact("AB-12 3"), "ab123");
});

test("similarity ranks close strings higher", () => {
    eq(text.similarity("Email", "email"), 1);
    eq(text.similarity("e-mail", "E Mail"), 1);
    ok(text.similarity("Customer Name", "Customer") > text.similarity("Customer Name", "Country"), "token overlap");
    ok(text.similarity("Desc", "Description") >= 0.6, "prefix abbreviation");
    ok(text.similarity("Adress", "Address") >= 0.7, "typo");
    ok(text.similarity("Phone", "Zip") < 0.3, "unrelated");
    eq(text.levenshtein("frnace", "france"), 1, "a swap is one edit");
    ok(text.similarity("Frnace", "France") >= 0.85 && text.similarity("Spian", "Spain") >= 0.85, "swapped letters");
    ok(text.similarity("Untied States", "United States") >= 0.85, "swap in one word of two");
    const countries = ["Spain", "Sweden", "Switzerland", "Swaziland", "Saint Lucia", "Slovenia"].map((label, id) => ({ id, label }));
    eq(text.rank("Spian", countries)[0].label, "Spain");
});

// ---------------------------------------------------------------------------
// csv
test("csv: quotes, embedded separators, newlines, BOM", () => {
    const { rows, separator } = csv.parse('﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n1,2,3');
    eq(separator, ",");
    eq(rows, [["a", "b", "c"], ["x, y", 'he said "hi"', "multi\nline"], ["1", "2", "3"]]);
});

test("csv: sniffs ; and tab", () => {
    eq(csv.sniff("name;price\nDesk;1,5\nChair;2,25\n"), ";");
    eq(csv.sniff("name\tprice\nDesk\t1.5\n"), "\t");
    eq(csv.sniff('name,"a;b"\nx,"c;d"\n'), ",");
});

test("csv: serialize round-trips", () => {
    const rows = [["a", "b,c"], ['q"t', "line\nbreak"], ["", null]];
    eq(csv.parse(csv.serialize(rows), ",").rows, [["a", "b,c"], ['q"t', "line\nbreak"], ["", ""]]);
});

// ---------------------------------------------------------------------------
// sheet
test("decode: utf-8, BOM and windows-1252 fallback", () => {
    eq(sheet.decode(new TextEncoder().encode("Zoë")).text, "Zoë");
    eq(sheet.decode(new Uint8Array([0x5a, 0x6f, 0xeb])).text, "Zoë");
    eq(sheet.decode(new Uint8Array([0x5a, 0x6f, 0xeb])).encoding, "windows-1252");
});

test("header detection", () => {
    eq(sheet.detectHeader([["Name", "Qty"], ["Desk", "2"]]), 0);
    eq(sheet.detectHeader([["Desk", "2"], ["Chair", "3"]]), -1);
    eq(sheet.detectHeader([["Report 2024", "", ""], ["", "", ""], ["Name", "Qty", "Price"], ["Desk", "2", "5"]]), 2);
});

test("buildTable trims, drops empty rows/cols, keeps source line numbers, dedups headers", () => {
    const t = sheet.buildTable([["Name", "", "Name", "Qty"], [" Desk ", "", "x", "2"], ["", "", "", ""], ["Chair", "", "", "3"]]);
    eq(t.headers, ["Name", "Name (2)", "Qty"]);
    eq(t.rows, [["Desk", "x", "2"], ["Chair", "", "3"]]);
    eq(t.lines, [2, 4]);
    eq(sheet.buildTable([["1", "2"]], -1).headers, ["Column A", "Column B"]);
});

// ---------------------------------------------------------------------------
// profile
test("numbers and decimal separators", () => {
    eq(profile.parseNumber("1,234.50"), 1234.5);
    eq(profile.parseNumber("1.234,50", ","), 1234.5);
    eq(profile.parseNumber("€ 12,5", ","), 12.5);
    eq(profile.parseNumber("(15)"), -15);
    eq(profile.parseNumber("12%"), 0.12);
    eq(profile.parseNumber("1 234 567"), 1234567);
    eq(profile.parseNumber("abc"), null);
    eq(profile.parseNumber("1e3"), 1000);
    const p = profile.profileColumn(["1,5", "2,25", "3"]);
    eq([p.type, p.decimal], ["float", ","]);
    eq(profile.profileColumn(["1,234", "12"]).decimal, ".");
});

test("dates: formats, day/month order, ambiguity", () => {
    eq(profile.parseDate("2024-03-01"), { date: "2024-03-01", time: null });
    eq(profile.parseDate("03/04/2024", "DMY").date, "2024-04-03");
    eq(profile.parseDate("03/04/2024", "MDY").date, "2024-03-04");
    eq(profile.parseDate("1 Feb 2024").date, "2024-02-01");
    eq(profile.parseDate("March 5, 2023 2:30 PM"), { date: "2023-03-05", time: "14:30:00" });
    eq(profile.parseDate("31/04/2024"), null);
    eq(profile.parseDate("2024-03-01T10:20:30Z").time, "10:20:30");
    let p = profile.profileColumn(["25/12/2024", "01/02/2024"]);
    eq([p.type, p.dateOrder, p.dateAmbiguous], ["date", "DMY", false]);
    p = profile.profileColumn(["12/25/2024", "01/02/2024"]);
    eq(p.dateOrder, "MDY");
    p = profile.profileColumn(["03/04/2024", "01/02/2024"], { dateOrder: "MDY" });
    eq([p.dateOrder, p.dateAmbiguous], ["MDY", true]);
    eq(profile.profileColumn(["2024-01-01 10:00", "2024-01-02"]).type, "datetime");
});

test("profile types", () => {
    eq(profile.profileColumn(["yes", "no", "", "Yes"]).type, "bool");
    const zo = profile.profileColumn(["0", "1", "1"]);
    eq([zo.type, zo.boolish], ["int", true]);
    eq(profile.profileColumn(["0012", "0450"]).type, "text");
    eq(profile.profileColumn(["a@b.test", "c@d.test"]).type, "email");
    eq(profile.profileColumn(["+32 470 12 34 56", "(555) 123-4567"]).type, "phone");
    eq(profile.profileColumn(["https://x.test", "www.y.test"]).type, "url");
    eq(profile.profileColumn(["VIP, Gold", "Silver", "Gold, New"]).list, ",");
    eq(profile.profileColumn(["Main street 1, Brussels", "Elm 2"]).list, ",", "short address looks like a list (accepted)");
    eq(profile.profileColumn(["base.be", "base.fr"]).xmlid, true);
    eq(profile.profileColumn(["", ""]).type, "empty");
});

// ---------------------------------------------------------------------------
// workbooks
async function fixture(name) {
    return (await fetch(`fixtures/${name}`)).arrayBuffer();
}

await atest("xlsx: sheets, shared strings, dates, numbers, booleans, gaps", async () => {
    const book = await sheet.readFile("sample.xlsx", await fixture("sample.xlsx"));
    eq(book.sheets.map((s) => s.name), ["Contacts", "Second"]);
    const rows = await book.sheets[0].load();
    eq(rows[0], ["Name", "Email", "Birthday", "Since", "Credit", "Active", "Tags"]);
    eq(rows[1], ["Acme", "info@acme.test", "1990-04-03", "2024-03-01 14:30:00", "1234.5", "TRUE", "VIP, Gold"]);
    eq(rows[2].slice(0, 6), ["Café Zoë", "", "", "", "0.3", "FALSE"]);
    eq(rows[4][0], "Long\ntext");
    eq(rows[9][7], "far cell");
    const t = sheet.buildTable(rows);
    eq(t.rows.length, 4);
    eq(t.lines, [2, 3, 5, 10]);
});

await atest("ods: repeated cells/rows, typed values", async () => {
    const book = await sheet.readFile("sample.ods", await fixture("sample.ods"));
    const rows = await book.sheets[0].load();
    eq(rows[0], ["Product", "Price", "Date", "Sold"]);
    eq(rows[1], ["Desk", "99.9", "2024-02-29", "TRUE"]);
    eq(rows[2], ["same", "same"]);
    eq(rows[3], ["same", "same"]);
    eq(rows.length, 5);
});

await atest("unsupported files are refused with a helpful message", async () => {
    let msg = "";
    try {
        await sheet.readFile("old.xls", new ArrayBuffer(10));
    } catch (e) {
        msg = e.message;
    }
    ok(/xlsx/.test(msg), msg);
});

// ---------------------------------------------------------------------------
// column mapping
const F = (name, type, string, extra = {}) => ({ name, type, string, stringEn: extra.en || string, relation: extra.relation || null,
    required: !!extra.required, readonly: false, store: true, selection: extra.selection || null, selectionEn: extra.selection || null, importable: true });
const PARTNER = [
    schema.ID_FIELD,
    F("name", "char", "Name", { required: true }), F("email", "char", "Email"), F("phone", "char", "Phone"),
    F("street", "char", "Street"), F("city", "char", "City"), F("zip", "char", "Zip"),
    F("country_id", "many2one", "Country", { relation: "res.country" }), F("state_id", "many2one", "State", { relation: "res.country.state" }),
    F("category_id", "many2many", "Tags", { relation: "res.partner.category" }), F("is_company", "boolean", "Is a Company"),
    F("vat", "char", "Tax ID"), F("ref", "char", "Reference"), F("user_id", "many2one", "Salesperson", { relation: "res.users" }),
    F("comment", "html", "Notes"), F("website", "char", "Website Link"), F("parent_id", "many2one", "Related Company", { relation: "res.partner" }),
    F("child_ids", "one2many", "Contact", { relation: "res.partner" }), F("credit_limit", "float", "Credit Limit"),
    F("type", "selection", "Address Type", { selection: [["contact", "Contact"], ["invoice", "Invoice Address"], ["delivery", "Delivery Address"]] }),
    F("company_name", "char", "Company Name"), F("function", "char", "Job Position"), F("mobile", "char", "Mobile"),
    schema.DBID_FIELD,
];

async function map(headers, rows, opts = {}) {
    const profiles = headers.map((_, c) => profile.profileColumn(rows.map((r) => r[c])));
    return columns.automap({ headers, profiles, fields: PARTNER, subFields: async () => [], ...opts });
}
const pathOf = (m) => (m.path ? m.path.join("/") : null);

await atest("automap: exact, synonyms, typos, value types", async () => {
    const headers = ["Customer Name", "E-mail", "Tel", "Country", "Tags", "Company?", "VAT Number", "Credit Limit", "Adress", "Salesperson", "Zip Code", "Random stuff"];
    const rows = [["Acme", "a@x.test", "+32 2 123 45 67", "Belgium", "VIP, Gold", "yes", "BE0123", "1000", "Main st 1", "Mitchell Admin", "1000", "qwerty"]];
    const m = await map(headers, rows);
    const got = Object.fromEntries(m.map((r) => [headers[r.col], [pathOf(r), r.status]]));
    eq(got["Customer Name"], ["name", "auto"]);
    eq(got["E-mail"], ["email", "auto"]);
    eq(got["Tel"], ["phone", "auto"]);
    eq(got["Country"], ["country_id", "auto"]);
    eq(got["Tags"], ["category_id", "auto"]);
    eq(got["VAT Number"], ["vat", "auto"]);
    eq(got["Credit Limit"], ["credit_limit", "auto"]);
    eq(got["Salesperson"], ["user_id", "auto"]);
    eq(got["Zip Code"], ["zip", "auto"]);
    eq(got["Adress"][0], "street");
    eq(got["Company?"][0], "is_company");
    eq(got["Random stuff"], [null, "none"]);
});

await atest("automap: a field takes one column; the loser moves to its next choice", async () => {
    const m = await map(["Email", "E-mail address"], [["a@x.test", "b@y.test"]]);
    eq(pathOf(m[0]), "email");
    ok(pathOf(m[1]) !== "email", "second column must not take email again");
});

await atest("automap: technical names, xmlid paths and memory", async () => {
    const m = await map(["country_id/id", "id", "type", "Headline"], [["base.be", "__export__.p_1", "invoice", "x"]],
        { memory: new Map([["headline", ["function"]]]) });
    eq(m.map(pathOf), ["country_id/id", "id", "type", "function"]);
    eq(m[3].source, "memory");
});

await atest("automap: one2many sub-fields through 'Lines/Field' headers", async () => {
    const headers = ["Contact/Name", "Contact/Email"];
    const subs = [F("name", "char", "Name"), F("email", "char", "Email")];
    const profiles = headers.map(() => profile.profileColumn(["x"]));
    const m = await columns.automap({ headers, profiles, fields: PARTNER, subFields: async () => subs });
    eq(m.map(pathOf), ["child_ids/name", "child_ids/email"]);
});

test("type fit lowers a wrong-type match", () => {
    const dateProf = profile.profileColumn(["2024-01-01"]);
    ok(columns.scoreField("Credit", F("credit_limit", "float", "Credit Limit"), dateProf).score
        < columns.scoreField("Credit", F("credit_limit", "float", "Credit Limit"), profile.profileColumn(["10"])).score);
});

// ---------------------------------------------------------------------------
// values
test("convert values to Odoo's import format", () => {
    const sel = F("type", "selection", "Type", { selection: [["contact", "Contact"], ["invoice", "Invoice Address"]] });
    eq(values.convert(sel, "invoice address").out, "invoice");
    eq(values.convert(sel, "CONTACT").out, "contact");
    const bad = values.convert(sel, "Invoice adress");
    eq([bad.ok, bad.candidates[0].id], [false, "invoice"]);
    eq(values.convert(F("x", "float", "X"), "1.234,5", { decimal: "," }).out, "1234.5");
    eq(values.convert(F("x", "integer", "X"), "12.5").ok, false);
    eq(values.convert(F("x", "boolean", "X"), "Oui").out, "1");
    eq(values.convert(F("x", "date", "X"), "03/04/2024", { dateOrder: "MDY" }).out, "2024-03-04");
    eq(values.convert(F("x", "datetime", "X"), "2024-03-04").out, "2024-03-04 00:00:00");
});

// ---------------------------------------------------------------------------
// planning
function job(headers, rows, mapped, resolutions = {}) {
    const j = plan.newJob("res.partner", { headers, rows, lines: rows.map((_, i) => i + 2) });
    j.profiles = headers.map((_, c) => profile.profileColumn(rows.map((r) => r[c])));
    const byName = new Map(PARTNER.map((f) => [f.name, f]));
    j.mapping = headers.map((_, col) => {
        const path = mapped[col];
        return path ? { col, path, fields: path.map((n) => byName.get(n)), status: "auto", score: 1, candidates: [] } : { col, path: null, status: "none", candidates: [] };
    });
    for (const m of plan.active(j)) {
        const r = plan.relationOf(m);
        if (r) j.rel.set(m.col, { ...r, sep: "," });
    }
    for (const [col, res] of Object.entries(resolutions)) j.resolutions.set(Number(col), new Map(Object.entries(res)));
    return j;
}
const C = (id, label, links = {}) => ({ id, label, score: 1, active: true, links, detail: "" });

test("analyze: ambiguous, missing, probable, bad values; build writes ids", () => {
    const j = job(["Name", "Country", "Tags", "Type"], [
        ["A", "Belgium", "VIP, Gold", "contact"],
        ["B", "Georgia", "Gold", "nope"],
        ["C", "Narnia", "", "invoice"],
        ["D", "Belgum", "VIP", ""],
    ], [["name"], ["country_id"], ["category_id"], ["type"]], {
        1: {
            Belgium: { status: "ok", id: 21, candidates: [C(21, "Belgium")] },
            Georgia: { status: "ambiguous", id: null, candidates: [C(80, "Georgia"), C(81, "Georgia (US)")] },
            Narnia: { status: "missing", id: null, candidates: [] },
            Belgum: { status: "probable", id: 21, candidates: [C(21, "Belgium")] },
        },
        2: { VIP: { status: "ok", id: 5, candidates: [] }, Gold: { status: "ok", id: 6, candidates: [] } },
    });
    let a = plan.analyze(j);
    eq(a.conflicts.map((c) => c.key).sort(), ["m2o:1:belgum", "m2o:1:georgia", "m2o:1:narnia", "value:3:nope"]);
    j.decisions.set("m2o:1:georgia", { action: "pick", id: 80 });
    j.decisions.set("m2o:1:narnia", { action: "skip", rows: [2] });
    j.decisions.set("m2o:1:belgum", { action: "pick", id: 21 });
    j.decisions.set("value:3:nope", { action: "empty" });
    a = plan.analyze(j);
    eq(a.conflicts.length, 0);
    eq(a.stats.create, 3);
    eq(a.stats.skip, 1);
    const m = plan.build(j, a);
    eq(m.fields, ["name", "country_id/.id", "category_id/.id", "type"]);
    eq(m.rows, [["A", "21", "5,6", "contact"], ["B", "80", "6", ""], ["D", "21", "5", ""]]);
    eq(m.groups.map((g) => g.src), [[0], [1], [3]]);
});

test("analyze: ambiguous values are narrowed by another column of the row", () => {
    const j = job(["Name", "State", "Country"], [["A", "Georgia", "United States"], ["B", "Georgia", "Nowhere"]],
        [["name"], ["state_id"], ["country_id"]], {
            1: { Georgia: { status: "ambiguous", candidates: [C(10, "Georgia (US)", { country_id: 233 }), C(11, "Georgia (GE)", { country_id: 80 })] } },
            2: { "United States": { status: "ok", id: 233, candidates: [] }, Nowhere: { status: "missing", candidates: [] } },
        });
    j.links.set(1, [{ field: "country_id", col: 2 }]);
    const a = plan.analyze(j);
    const keys = a.conflicts.map((c) => c.key).sort();
    eq(keys, ["m2o:1:georgia", "m2o:2:nowhere"]);
    eq(a.conflicts.find((c) => c.key === "m2o:1:georgia").rows, [1], "row 0 was narrowed to the US state");
    j.decisions.set("m2o:1:georgia", { action: "pick", id: 11 });
    j.decisions.set("m2o:2:nowhere", { action: "empty" });
    const m = plan.build(j, plan.analyze(j));
    eq(m.rows, [["A", "10", "233"], ["B", "11", ""]]);
});

test("analyze: required empty, defaults, record keys, duplicates, create", () => {
    const j = job(["Name", "Ref", "Country"], [["A", "R1", "Mars"], ["", "R2", ""], ["C", "R1", "Mars"]],
        [["name"], ["ref"], ["country_id"]], { 2: { Mars: { status: "missing", candidates: [] } } });
    j.key = { col: 1, field: "ref", mode: "update" };
    j.existing = new Map([["r2", [{ id: 7, label: "Old" }]]]);
    let a = plan.analyze(j);
    eq(a.conflicts.map((c) => c.kind).sort(), ["m2o", "requiredempty"]);
    eq(a.warnings.map((c) => c.kind), ["duplicate"]);
    eq([a.stats.create, a.stats.update], [2, 1]);
    j.decisions.set("m2o:2:mars", { action: "create", value: "Mars" });
    j.decisions.set("requiredempty:0", { action: "default", out: "Unnamed" });
    j.decisions.set("duplicate:r1", { action: "last" });
    a = plan.analyze(j);
    eq(a.conflicts.length, 0);
    eq(plan.toCreate(j), [{ relation: "res.country", name: "Mars" }]);
    const m = plan.build(j, a, { created: new Map([["res.country\u0000mars", 99]]) });
    eq(m.fields, ["name", "ref", "country_id/.id", ".id"]);
    eq(m.rows, [["Unnamed", "R2", "", "7"], ["C", "R1", "99", ""]]);
});

test("one2many lines: continuation rows stay with their record", () => {
    const j = job(["Name", "Contact/Name"], [["Acme", "John"], ["", "Jane"], ["Beta", "Bob"]], [["name"], null]);
    const sub = F("name", "char", "Name");
    j.mapping[1] = { col: 1, path: ["child_ids", "name"], fields: [PARTNER.find((f) => f.name === "child_ids"), sub], status: "auto", score: 1, candidates: [] };
    eq(plan.recordRows(j), [0, 2]);
    const m = plan.build(j, plan.analyze(j));
    eq(m.fields, ["name", "child_ids/name"]);
    eq(m.groups.map((g) => g.out), [[0, 2], [2, 3]]);
    eq(execute.batches(m.groups, 2).map((b) => b.length), [1, 1]);
});

test("base64 handles unicode", () => {
    eq(atob(execute.base64("é")), "Ã©");
});

// ---------------------------------------------------------------------------
// xlsx writer
test("crc32 and excel serial dates", () => {
    eq(xlsxwriter.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
    eq(xlsxwriter.serial("1900-03-01"), 61);
    eq(xlsxwriter.serial("2024-03-01 12:00:00"), 45352.5);
    eq(xlsxwriter.colName(27), "AB");
});

await atest("xlsx writer: what it writes reads back identically", async () => {
    const blob = await xlsxwriter.workbook({
        headers: ["Name", "Amount", "Active", "Date", "When", "Notes"],
        types: ["text", "number", "boolean", "date", "datetime", "text"],
        rows: [
            ["Café <Zoë> & co", 1234.5, true, "2024-02-29", "2024-03-01 14:30:00", "line1\nline2"],
            ["", 0, false, false, "", "\u0001control"],
            ["x".repeat(40000), -7, false, "1999-12-31", "2000-01-01 00:00:00", "=SUM(A1)"],
        ],
        sheetName: "Contact / test",
    });
    const book = await sheet.readFile("out.xlsx", await blob.arrayBuffer());
    eq(book.sheets.map((s) => s.name), ["Contact   test"]);
    const rows = await book.sheets[0].load();
    eq(rows[0], ["Name", "Amount", "Active", "Date", "When", "Notes"]);
    eq(rows[1], ["Café <Zoë> & co", "1234.5", "TRUE", "2024-02-29", "2024-03-01 14:30:00", "line1\nline2"]);
    eq(rows[2], ["", "0", "FALSE", "", "", "control"]);
    eq([rows[3][0].length, rows[3][1], rows[3][3], rows[3][4], rows[3][5]], [32767, "-7", "1999-12-31", "2000-01-01", "=SUM(A1)"]);
});

await atest("export CSV: BOM, no False for empty cells", async () => {
    const blob = await globalThis.OdooImport.export.toBlob({ headers: ["a", "b", "c"], types: ["text", "boolean", "number"], rows: [[false, false, 0], ["x,y", true, 1.5]] }, "csv");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    eq([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
    eq(await blob.text(), "a,b,c\r\n,False,0\r\n\"x,y\",True,1.5\r\n");
});

// ---------------------------------------------------------------------------
// filters -> domain
test("filters: operators per type and the resulting domain", () => {
    const now = new Date(2026, 9, 11, 15, 0); // 11 Oct 2026
    eq(domain.toDomain([], now), []);
    eq(domain.toDomain([{ path: ["name"], type: "char", op: "ilike", value: "acme" }], now), [["name", "ilike", "acme"]]);
    eq(domain.toDomain([{ path: ["name"], type: "char", op: "=", value: "50%_off" }], now), [["name", "=ilike", "50\\%\\_off"]]);
    eq(domain.toDomain([{ path: ["name"], type: "char", op: "!=", value: "x" }], now), ["!", ["name", "=ilike", "x"]]);
    eq(domain.toDomain([{ path: ["partner_id", "country_id"], type: "many2one", op: "in", value: [{ id: 20, label: "Belgium" }] }], now),
        [["partner_id.country_id", "in", [20]]]);
    eq(domain.toDomain([{ path: ["state"], type: "selection", op: "in", value: [] }], now), [], "incomplete conditions are ignored");
    eq(domain.toDomain([{ path: ["amount_total"], type: "monetary", op: "between", value: ["100", "500"] }, { path: ["active"], type: "boolean", op: "true" }], now),
        ["&", "&", ["amount_total", ">=", 100], ["amount_total", "<=", 500], ["active", "=", true]]);
    eq(domain.toDomain([{ path: ["date"], type: "date", op: "this_month" }], now), ["&", ["date", ">=", "2026-10-01"], ["date", "<", "2026-11-01"]]);
    eq(domain.toDomain([{ path: ["date"], type: "date", op: "last_month" }], now), ["&", ["date", ">=", "2026-09-01"], ["date", "<", "2026-10-01"]]);
    eq(domain.toDomain([{ path: ["date"], type: "date", op: "this_week" }], now), ["&", ["date", ">=", "2026-10-05"], ["date", "<", "2026-10-12"]]);
    eq(domain.toDomain([{ path: ["date"], type: "date", op: "between", value: ["2026-01-01", "2026-01-31"] }], now), ["&", ["date", ">=", "2026-01-01"], ["date", "<", "2026-02-01"]]);
    eq(domain.toDomain([{ path: ["date"], type: "date", op: "after", value: "2026-03-31" }], now), [["date", ">=", "2026-04-01"]]);
    const dt = domain.toDomain([{ path: ["create_date"], type: "datetime", op: "today" }], now);
    eq(dt[1][2], new Date(2026, 9, 11).toISOString().slice(0, 19).replace("T", " "), "datetimes are compared in UTC");
    eq(domain.describe({ path: ["state"], type: "selection", op: "in", value: [{ id: "sale", label: "Sales Order" }, { id: "done", label: "Locked" }] }, "Status"), "Status is Sales Order, Locked");
});

// ---------------------------------------------------------------------------
// grouping
const G = (label, value, count = 1, label2) => ({ key: label2 === undefined ? [{ value: label, label }] : [{ value: label, label }, { value: label2, label: label2 }], value, count });

test("pivot: top N + Others, sorted by value", () => {
    const groups = [G("BE", 50), G("FR", 30), G("DE", 20), G("ES", 5), G("IT", 3), G("NL", 2)];
    const p = analyze.pivot(groups, { top: 3 });
    eq(p.categories.map((c) => c.label), ["BE", "FR", "DE", "Others (3)"]);
    eq(p.series[0].values, [50, 30, 20, 10]);
    eq(p.total, 110);
    eq(analyze.pivot(groups, { top: 10 }).categories.length, 6);
});

test("pivot: averages of Others are weighted; dates keep their order", () => {
    const groups = [G("a", 10, 1), G("b", 8, 1), G("c", 2, 3), G("d", 4, 1)];
    const p = analyze.pivot(groups, { top: 2, agg: "avg" });
    eq(p.series[0].values, [10, 8, 2.5]);
    const d = analyze.pivot([G("Jan", 1), G("Feb", 9), G("Mar", 4)], { top: 2, chronological: true });
    eq(d.categories.map((c) => c.label), ["Jan", "Feb", "Mar"]);
});

test("pivot: a second grouping makes stacked series", () => {
    const groups = [G("BE", 5, 1, "Draft"), G("BE", 7, 1, "Sale"), G("FR", 4, 1, "Sale")];
    const p = analyze.pivot(groups, {});
    eq(p.split, true);
    eq(p.categories.map((c) => c.label), ["BE", "FR"]);
    eq(p.series.map((x) => [x.label, x.values]), [["Sale", [7, 4]], ["Draft", [5, 0]]]);
});

test("group keys: many2one, selection, boolean, empty", () => {
    eq(analyze.keyOf([7, "Acme"], { type: "many2one" }), { value: 7, label: "Acme" });
    eq(analyze.keyOf("sale", { type: "selection", selection: [["sale", "Sales Order"]] }), { value: "sale", label: "Sales Order" });
    eq(analyze.keyOf(false, { type: "many2one" }).label, "None");
    eq(analyze.keyOf(true, { type: "boolean" }).label, "Yes");
    eq(analyze.bucket("2026-02-15 10:00:00", "quarter"), { value: "2026-01-01", label: "Q1 2026" });
    eq(analyze.bucket("2026-01-01", "week").label, "W1 2026");
});

// ---------------------------------------------------------------------------
// charts
test("charts: marks, one color for a single series, pie slices, Others in gray", () => {
    const data = { ...analyze.pivot([G("BE", 50), G("FR", 30), G("DE", 20), G("ES", 5), G("IT", 3), G("NL", 2)], { top: 4 }), measureLabel: "Count" };
    const bar = chart.render(data, { type: "bar", width: 600, theme: "light", title: "Count by Country" });
    const fills = [...bar.svg.querySelectorAll(".mark")].map((m) => m.getAttribute("fill"));
    eq(fills.length, 5);
    eq(new Set(fills.slice(0, 4)).size, 1, "one series: one color");
    eq(fills[4], chart.THEMES.light.others, "Others is gray");
    const pie = chart.render(data, { type: "pie", width: 600, theme: "dark" });
    eq(pie.svg.querySelectorAll(".mark").length, 5);
    eq([...pie.svg.querySelectorAll(".mark")][0].getAttribute("fill"), chart.THEMES.dark.series[0]);
    const hb = chart.render(data, { type: "hbar", width: 600, theme: "light" });
    ok(hb.height > 150, "bars grow with the categories");
    ok(bar.svg.querySelector(".mark").__tip.rows[0].value === "50", "tooltip value");
    const empty = chart.render({ categories: [], series: [{ values: [] }], measureLabel: "Count" }, { type: "bar", width: 400, theme: "light" });
    ok(empty.svg.textContent.includes("No records"), "empty state");
});

test("charts: stacked columns and lines draw every series with a legend", () => {
    const groups = [G("Jan", 5, 1, "Draft"), G("Jan", 7, 1, "Sale"), G("Feb", 4, 1, "Sale"), G("Feb", -2, 1, "Draft")];
    const data = { ...analyze.pivot(groups, { chronological: true }), measureLabel: "Sum" };
    const st = chart.render(data, { type: "bar", width: 600, theme: "light" });
    eq(st.svg.querySelectorAll(".mark").length, 4, "negative values stack below zero");
    ok(st.svg.textContent.includes("Draft") && st.svg.textContent.includes("Sale"), "legend");
    const ln = chart.render(data, { type: "line", width: 600, theme: "light" });
    eq(ln.svg.querySelectorAll("path[stroke-width='2']").length, 2);
    eq(ln.svg.querySelectorAll(".band").length, 2, "one hover band per date");
    eq(chart.suggest({ categories: data.categories, split: true, chronological: true }), "line");
    eq(chart.suggest({ categories: [1, 2, 3].map((i) => ({ label: `c${i}` })), split: false }), "pie");
    eq(chart.ticks(0, 87), [0, 20, 40, 60, 80, 100]);
});

await atest("excel with a native chart", async () => {
    const blob = await xlsxwriter.workbook({ headers: ["Country", "Count"], rows: [["BE", 3], ["FR", 2]], types: ["text", "number"], sheetName: "Data",
        chart: { type: "pie", title: "Count by Country", colors: ["#2a78d6", "#eb6834"] } });
    const zip = await xlsx.unzip(await blob.arrayBuffer());
    ok(zip.names.includes("xl/charts/chart1.xml") && zip.names.includes("xl/drawings/drawing1.xml"), zip.names.join());
    const c = await zip.read("xl/charts/chart1.xml");
    ok(c.includes("<c:pieChart>") && c.includes("'Data'!$A$2:$A$3") && c.includes("'Data'!$B$2:$B$3") && c.includes("Count by Country"), c.slice(0, 300));
    const book = await sheet.readFile("c.xlsx", await blob.arrayBuffer());
    eq(await book.sheets[0].load(), [["Country", "Count"], ["BE", "3"], ["FR", "2"]]);
});

test("Odoo version support: 16 to 20, intermediate releases included", () => {
    const v = (info) => globalThis.OdooImport.rpc.version(info);
    eq(v({ server_version_info: [16, 0, 0, "final", 0, ""], server_version: "16.0" }), { major: 16, minor: 0, label: "16.0", support: "yes" });
    eq(v({ server_version_info: ["saas~17", 2, 0, "final", 0, ""], server_version: "saas~17.2" }).support, "yes");
    eq(v({ server_version_info: ["saas~17", 2, 0, "final", 0, ""] }).label, "17.2");
    eq(v({ server_version_info: [19, 5, 0, "alpha", 1, ""] }).label, "19.5");
    eq(v({ server_version_info: [20, 0, 0, "final", 0, ""] }).support, "yes");
    eq(v({ server_version_info: [20, 3, 0, "final", 0, ""] }).support, "yes");
    eq(v({ server_version_info: [15, 0, 0, "final", 0, ""] }).support, "old");
    eq(v({ server_version_info: [14, 0] }).support, "old");
    eq(v({ server_version_info: [21, 0] }).support, "new");
    eq(v({ server_version: "18.3+e" }), { major: 18, minor: 3, label: "18.3", support: "yes" });
    eq(v({}).support, "unknown");
});

test("errors: Odoo messages explained, with what to do, and grouped", () => {
    const E = globalThis.OdooImport.errors;
    const x = (m) => E.explain(m).title;
    eq(x("Missing required value for the field 'Customer' (partner_id)"), "Customer is empty, but Odoo requires it");
    eq(x("No matching record found for name 'Narnia' in field 'Country'"), "“Narnia” doesn't match any Country");
    eq(x("'12,5x' does not seem to be a number for field 'Credit Limit'"), "“12,5x” isn't a number (Credit Limit)");
    eq(x("'31/02/2024' does not seem to be a valid date for field 'Date'"), "“31/02/2024” isn't a date (Date)");
    eq(x("Value 'Pending' not found in selection field 'Status'"), "“Pending” isn't one of the choices for Status");
    eq(x("Found multiple matches for value \"Acme\" in field \"Customer\" (3 matches)"), "“Acme” matches 3 Customer records; Odoo used the first one");
    eq(x("You are not allowed to create 'Contact' (res.partner) records."), "Your Odoo user may not create Contact records");
    eq(x("Session expired: Log in to Odoo in this tab and try again."), "Your Odoo session expired");
    eq(x("Missing required field 'Company' (company_id) for model 'Sales Order' (sale.order)"), "Company is empty, but Odoo requires it");
    eq(x("Column credit_limit contains incorrect values (value: 12x)"), "“12x” isn't a valid value for credit_limit");
    ok(E.explain("Missing required value for the field 'Customer' (partner_id)").hint.includes("Review"), "hint");
    eq(x("Something completely new\nwith a traceback"), "Something completely new");
    const g = E.group([
        { row: 0, line: 2, message: "Missing required value for the field 'Customer' (partner_id)" },
        { row: 3, line: 5, message: "Missing required value for the field 'Customer' (partner_id)" },
        { row: 4, line: 6, message: "Value 'X' not found in selection field 'Status'" },
    ]);
    eq(g.map((y) => [y.title, y.lines]), [["Customer is empty, but Odoo requires it", [2, 5]], ["“X” isn't one of the choices for Status", [6]]]);
});

await atest("excel book: several sheets, dropdown lists in a hidden sheet the reader skips", async () => {
    const blob = await xlsxwriter.book({ sheets: [
        { name: "Data", headers: ["Name", "Status", "Active"], rows: [], validations: [{ col: 1, values: ["Draft", "Done"] }, { col: 2, values: ["Yes", "No"] }], filter: false },
        { name: "Help", headers: ["Column", "Allowed"], rows: [["Status", "Draft, Done"]] },
    ] });
    const zip = await xlsx.unzip(await blob.arrayBuffer());
    const wb = await zip.read("xl/workbook.xml");
    ok(wb.includes('name="Lists"') && wb.includes('state="hidden"'), wb);
    const s1 = await zip.read("xl/worksheets/sheet1.xml");
    ok(s1.includes("<dataValidations count=\"2\">") && s1.includes("'Lists'!$A$1:$A$2") && s1.includes("'Lists'!$B$1:$B$2"), s1.slice(-600));
    const book = await sheet.readFile("t.xlsx", await blob.arrayBuffer());
    eq(book.sheets.map((x) => x.name), ["Data", "Help"]);
    eq(await book.sheets[0].load(), [["Name", "Status", "Active"]]);
});

test("domains combine with an implicit AND", () => {
    eq(domain.and([], [["a", "=", 1]]), [["a", "=", 1]]);
    eq(domain.and(["|", ["a", "=", 1], ["b", "=", 2]], [["c", "=", 3]]), ["|", ["a", "=", 1], ["b", "=", 2], ["c", "=", 3]]);
});
test("comparisons: periods, labels, aligned values", () => {
    const now = new Date(2026, 9, 11);
    const r = (c, how) => domain.compareRange(c, how, now).map((d) => d.toDateString());
    const D = (y, m, d) => new Date(y, m, d).toDateString();
    eq(r({ type: "date", op: "this_month" }, "previous"), [D(2026, 8, 1), D(2026, 9, 1)]);
    eq(r({ type: "date", op: "this_month" }, "year"), [D(2025, 9, 1), D(2025, 10, 1)]);
    eq(r({ type: "date", op: "this_quarter" }, "previous"), [D(2026, 6, 1), D(2026, 9, 1)]);
    eq(r({ type: "date", op: "last_7" }, "previous"), [D(2026, 8, 28), D(2026, 9, 5)]);
    eq(r({ type: "date", op: "between", value: ["2026-01-01", "2026-03-31"] }, "previous"), [D(2025, 9, 1), D(2026, 0, 1)]);
    eq(domain.rangeLabel(domain.rangeOf({ type: "date", op: "this_month" }, now)), "October 2026");
    eq(domain.rangeLabel(domain.rangeOf({ type: "date", op: "this_quarter" }, now)), "Q4 2026");
    eq(domain.rangeLabel(domain.rangeOf({ type: "date", op: "last_year" }, now)), "2025");
    eq(domain.rangeLabel(domain.rangeOf({ type: "date", op: "last_7" }, now)), "5 Oct – 11 Oct 2026");
    eq(domain.compareRange({ type: "date", op: "after", value: "2026-01-01" }, "previous", now), null);
    const d = domain.toDomain([{ path: ["date"], type: "date", op: "range", value: [new Date(2026, 8, 1), new Date(2026, 9, 1)] }]);
    eq(d, ["&", ["date", ">=", "2026-09-01"], ["date", "<", "2026-10-01"]]);
    const cur = [G("BE", 10), G("FR", 6), G("DE", 2), G("ES", 1)];
    const prev = [G("FR", 8), G("BE", 5), G("IT", 4), G("ES", 3)];
    const c = analyze.compare(cur, prev, { top: 2, labels: ["Oct", "Sep"] });
    // ranked by both periods together (BE 15, FR 14, IT 4, ES 4, DE 2); every record counts
    eq(c.categories.map((x) => x.label), ["BE", "FR", "Others (3)"]);
    eq(c.series.map((x) => [x.label, x.values]), [["Oct", [10, 6, 3]], ["Sep", [5, 8, 7]]]);
    const u = analyze.compare([G("BE", 1)], [G("FR", 2)], { top: 10 });
    eq([u.categories.map((x) => x.label), u.series[0].values, u.series[1].values], [["FR", "BE"], [0, 1], [2, 0]], "a group of the other period only");
    const t = analyze.compare([G("Oct 1", 3), G("Oct 2", 4)], [G("Sep 1", 1)], { chronological: true });
    eq(t.series[1].values, [1, 0]);
    eq(t.categories[0].label, "Oct 1 vs Sep 1");
    const svg = chart.render({ ...c, measureLabel: "Count" }, { type: "bar", width: 500, theme: "light" }).svg;
    eq(svg.querySelectorAll(".mark").length, 6, "two bars per category, side by side");
    eq([...svg.querySelectorAll(".mark")][1].getAttribute("fill"), chart.THEMES.light.others, "the other period is gray");
});

test("sample data: typos made from real names", () => {
    const t = globalThis.OdooImport.sample.typo;
    eq(t("France"), "Frnace");
    eq(t("United States"), "Untied States");
    eq(t("Mitchell Admin"), "Micthell Admin");
    ok(t("Spain", new Set(["sapin"])) !== "Spain", "never the name itself");
});
finish();
