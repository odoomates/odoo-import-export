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

// A contact's parent company that is a row of the same file.
function selfJob(rows, resolutions, extra = []) {
    const j = job(["Name", "Company", "Email", ...extra.map((e) => e[0])], rows, [["name"], ["parent_id"], ["email"], ...extra.map((e) => e[1])], { 1: resolutions });
    j.inFile = plan.fileIndex(j, ["name", "email"]);
    return j;
}

test("in-file links: values naming a row of the file link to its record, imported first", () => {
    const j = selfJob([
        ["Acme", "", "info@acme.test"],
        ["John", "Acme", "john@acme.test"],
        ["Beta Corp", "", ""],
        ["Jane", "beta corp", ""],
        ["Zed", "Gamma", ""],
        ["Ann", "Delta", ""],
        ["Bob", "INFO@acme.test", ""],
    ], {
        Acme: { status: "missing", candidates: [] },
        "beta corp": { status: "probable", id: 9, candidates: [C(9, "Beta Ltd")] },
        Gamma: { status: "missing", candidates: [] },
        Delta: { status: "ok", id: 50, candidates: [C(50, "Delta")] },
        "INFO@acme.test": { status: "missing", candidates: [] },
    });
    const a = plan.analyze(j);
    eq(a.conflicts.map((c) => c.key), ["m2o:1:gamma"], "only the value that is neither in the file nor in Odoo");
    eq([...a.inFile], [["1:1:acme", 0], ["1:3:beta corp", 2], ["1:6:info@acme.test", 0]]);
    eq([...a.levels], [[1, 1], [3, 1], [6, 1]]);
    eq(a.stats.inFile, 3);
    j.decisions.set("m2o:1:gamma", { action: "empty" });
    const b = plan.analyze(j);
    eq(plan.build(j, b, { level: 0 }).rows.map((r) => r[0]), ["Acme", "Beta Corp", "Zed", "Ann"]);
    eq(plan.build(j, b, { level: 0 }).rows[3][1], "50");
    const second = plan.build(j, b, { level: 1, rowIds: new Map([[0, 100], [2, 200]]) });
    eq(second.rows.map((r) => [r[0], r[1]]), [["John", "100"], ["Jane", "200"], ["Bob", "100"]]);
    eq(second.groups.map((g) => g.src), [[1], [3], [6]]);
    // a dry run doesn't know the ids: the link stays empty, never an existing record
    eq(plan.build(j, b, { level: 1 }).rows.map((r) => r[1]), ["", "", ""]);
});

test("in-file links: existing records, skipped rows, several rows, circles", () => {
    // the parent row updates an existing record: its id, no second round
    let j = selfJob([["Acme", "", "info@acme.test"], ["John", "Acme", "john@acme.test"]], { Acme: { status: "ok", id: 7, candidates: [C(7, "Acme")] } });
    j.key = { col: 2, field: "email", mode: "skip" };
    j.existing = new Map([["info@acme.test", [{ id: 7, label: "Acme" }]]]);
    let a = plan.analyze(j);
    eq([a.inFile.size, a.levels.size, a.rowId.get("1:1:acme")], [0, 0, 7]);
    eq(plan.build(j, a).rows, [["John", "7", "john@acme.test"]]);

    // the parent row is skipped: the value is looked up in Odoo as usual
    j = selfJob([["Acme", "", "", "Narnia"], ["John", "Acme", "", "Belgium"]], { Acme: { status: "missing", candidates: [] } }, [["Country", ["country_id"]]]);
    j.resolutions.set(3, new Map([["Narnia", { status: "missing", candidates: [] }], ["Belgium", { status: "ok", id: 21, candidates: [] }]]));
    j.rel.set(3, { field: PARTNER.find((f) => f.name === "country_id"), mode: "name", sep: "," });
    j.decisions.set("m2o:3:narnia", { action: "skip", rows: [0] });
    a = plan.analyze(j);
    eq(a.conflicts.map((c) => c.key), ["m2o:1:acme"]);

    // a name shared by two rows: the first one, with a warning; an existing namesake: warned
    j = selfJob([["Acme", "", ""], ["Acme", "", ""], ["John", "Acme", ""]], { Acme: { status: "ok", id: 7, candidates: [C(7, "Acme")] } });
    a = plan.analyze(j);
    eq(a.inFile.get("1:2:acme"), 0);
    eq(a.warnings.map((w) => [w.kind, w.title]), [["infile", "“Acme” is the name of 2 rows of this file"]]);
    j = selfJob([["Acme", "", ""], ["John", "Acme", ""]], { Acme: { status: "ok", id: 7, candidates: [C(7, "Acme")] } });
    eq(plan.analyze(j).warnings.map((w) => w.title), ["“Acme” is also an existing Related Company"]);

    // a row naming itself isn't a link to the file
    j = selfJob([["Acme", "Acme", ""]], { Acme: { status: "missing", candidates: [] } });
    eq(plan.analyze(j).conflicts.map((c) => c.key), ["m2o:1:acme"]);

    // A -> B -> A: the link closing the circle is a conflict of its row
    j = selfJob([["A", "B", ""], ["B", "A", ""], ["C", "A", ""]], { A: { status: "missing", candidates: [] }, B: { status: "missing", candidates: [] } });
    a = plan.analyze(j);
    eq(a.conflicts.map((c) => [c.key, c.rows]), [["cycle:1:1", [1]]]);
    ok(a.conflicts[0].message.includes("rows 3 → 2 → 3"), a.conflicts[0].message);
    j.decisions.set("cycle:1:1", { action: "empty" });
    a = plan.analyze(j);
    eq(a.conflicts.length, 0);
    eq([...a.levels], [[0, 1], [2, 2]]);
    eq(plan.build(j, a, { level: 0 }).rows, [["B", ""]]);
    j.decisions.set("cycle:1:1", { action: "skip", rows: [1] });
    a = plan.analyze(j);
    eq([a.conflicts.length, a.stats.skip], [1, 1], "B skipped: A's parent is looked up in Odoo again");
    eq(a.conflicts[0].key, "m2o:1:b");

    // a long chain doesn't overflow the stack
    const chain = Array.from({ length: 20000 }, (_, i) => [`N${i}`, i ? `N${i - 1}` : "", ""]);
    j = selfJob(chain, Object.fromEntries(chain.slice(1).map((r) => [r[1], { status: "missing", candidates: [] }])));
    a = plan.analyze(j);
    eq([a.conflicts.length, a.levels.get(19999)], [0, 19999]);
});

// A fake Odoo without base_import: load() records what it is sent, new ids from 100.
function loader(onLoad) {
    const calls = [];
    let next = 100;
    return {
        calls,
        async call(model, method, args) {
            if (model === "base_import.import") throw new Error("no base_import");
            if (method === "load") {
                calls.push([args[0], args[1]]);
                return onLoad ? onLoad(args) : { ids: args[1].map(() => next++), messages: [] };
            }
            throw new Error(`unexpected ${model}.${method}`);
        },
    };
}
const XMLID = /^__import__\.oi_[0-9a-z]+_(\d+)$/;
const lineOf = (x) => Number((XMLID.exec(x) || [])[1]);

await atest("in-file links: batch-wise import, links sent as external ids, parents first", async () => {
    const j = selfJob([["John", "Acme", ""], ["Acme", "", ""], ["Kid", "John", ""], ["Solo", "", ""]], { Acme: { status: "missing", candidates: [] }, John: { status: "missing", candidates: [] } });
    const client = loader();
    const r = await execute.createExecutor(client).run(j, plan.analyze(j), { batchSize: 2 });
    ok(r.ok, JSON.stringify(r.errors));
    eq(client.calls.map((c) => c[0]), [["name", "parent_id/.id", "id"], ["name", "parent_id/id", "id"]]);
    const [[, plain], [, linked]] = client.calls;
    eq(plain.map((row) => row.slice(0, 2)), [["Acme", ""], ["Solo", ""]]);
    eq([plain[1][2], linked.map((row) => row[0])], ["", ["John", "Kid"]], "the user's batch size; a child after its parent");
    const [xAcme, xJohn] = [plain[0][2], linked[0][2]];
    eq([lineOf(xAcme), lineOf(xJohn), linked[0][1], linked[1][1], linked[1][2]], [3, 2, xAcme, xJohn, ""]);
    eq(r.created, [100, 101, 102, 103]);
});

await atest("in-file links: a dry run sends one pass and leaves the links empty", async () => {
    const j = selfJob([["John", "Acme", ""], ["Acme", "", ""]], { Acme: { status: "missing", candidates: [] } });
    const calls = [];
    const client = {
        async call(model, method, args, kwargs) {
            if (method === "fields_get") return { file: { help: "" } };
            if (method === "create") return 1;
            if (method === "execute_import") {
                calls.push([args[1], kwargs]);
                return { ids: [], messages: [] };
            }
            throw new Error(`unexpected ${model}.${method}`);
        },
    };
    await execute.createExecutor(client).run(j, plan.analyze(j), { dryrun: true });
    eq(calls, [[["name", "parent_id/.id"], { dryrun: true }]]);
});

await atest("in-file links: an updated record links to a new one, after the creations", async () => {
    const client = loader((args) => ({ ids: args[1].map((r) => (args[0].includes(".id") ? Number(r[args[0].indexOf(".id")]) : 100)), messages: [] }));
    const j = selfJob([["John", "Acme", "john@acme.test"], ["Acme", "", "info@acme.test"]], { Acme: { status: "missing", candidates: [] } });
    j.key = { col: 2, field: "email", mode: "update" };
    j.existing = new Map([["john@acme.test", [{ id: 7, label: "John" }]]]);
    const a = plan.analyze(j);
    eq([[...a.inFile], [...a.levels]], [[["1:0:acme", 1]], [[0, 1]]]);
    const r = await execute.createExecutor(client).run(j, a);
    ok(r.ok, JSON.stringify(r.errors));
    eq(client.calls.map((c) => c[0]), [["name", "parent_id/.id", "email", "id"], ["name", "parent_id/id", "email", ".id"]]);
    const xAcme = client.calls[0][1][0][3];
    eq(lineOf(xAcme), 3);
    eq(client.calls[1][1], [["John", xAcme, "john@acme.test", "7"]]);
    eq([r.created, r.updated], [[100], [7]]);
});

await atest("in-file links: a row's own External ID is the one linked to", async () => {
    const j = selfJob([["John", "Acme", "", ""], ["Acme", "", "", "acme"], ["Beta", "", "", ""], ["Ann", "Beta", "", ""]],
        { Acme: { status: "missing", candidates: [] }, Beta: { status: "missing", candidates: [] } }, [["External ID", ["id"]]]);
    const client = loader();
    await execute.createExecutor(client).run(j, plan.analyze(j));
    eq(client.calls.map((c) => c[0]), [["name", "parent_id/.id", "id"], ["name", "parent_id/id", "id"]]);
    eq(client.calls[0][1][0], ["Acme", "", "acme"]);
    eq(lineOf(client.calls[0][1][1][2]), 4, "a blank External ID gets a generated one");
    eq(client.calls[1][1].map((row) => row.slice(0, 2)), [["John", "__import__.acme"], ["Ann", client.calls[0][1][1][2]]]);
});

// Contacts linked to contacts by a many2many column: values may name rows of the file and
// existing records alike.
function relatedJob(rows, resolutions) {
    const j = job(["Name", "Related"], rows, [["name"], null]);
    const related = F("related_ids", "many2many", "Related", { relation: "res.partner" });
    j.mapping[1] = { col: 1, path: ["related_ids"], fields: [related], status: "auto", score: 1, candidates: [] };
    j.rel.set(1, { field: related, mode: "name", sep: "," });
    j.resolutions.set(1, new Map(Object.entries(resolutions)));
    j.inFile = plan.fileIndex(j, ["name"]);
    return j;
}

test("in-file links: a many2many naming several rows of the file links to each of them", () => {
    const j = relatedJob([["Ann", "Bob, Cid"], ["Bob", ""], ["Cid", "Bob"]], { Bob: { status: "missing", candidates: [] }, Cid: { status: "missing", candidates: [] } });
    const a = plan.analyze(j);
    eq(a.conflicts.length, 0);
    eq([...a.inFile], [["1:0:bob", 1], ["1:0:cid", 2], ["1:2:bob", 1]]);
    eq([...a.levels].sort(), [[0, 2], [2, 1]]);
    eq(plan.build(j, a, { level: 2, rowIds: new Map([[1, 10], [2, 11]]) }).rows, [["Ann", "10,11"]]);
    const xmlids = plan.xmlids(j, a, "t");
    const m = plan.build(j, a, { linked: true, xmlids });
    eq([m.mixed, m.fields, m.rows], [false, ["name", "related_ids/id", "id"], [["Cid", "__import__.oi_t_3", "__import__.oi_t_4"], ["Ann", "__import__.oi_t_3,__import__.oi_t_4", ""]]]);
});

const MIXED = { Bob: { status: "missing", candidates: [] }, Zed: { status: "ok", id: 50, candidates: [C(50, "Zed")] } };

await atest("in-file links: a link column also naming existing records falls back to rounds", async () => {
    const j = relatedJob([["Ann", "Bob, Zed"], ["Bob", ""]], MIXED);
    const client = loader();
    const r = await execute.createExecutor(client).run(j, plan.analyze(j));
    ok(r.ok, JSON.stringify(r.errors));
    eq(client.calls, [[["name", "related_ids/.id"], [["Bob", ""]]], [["name", "related_ids/.id"], [["Ann", "100,50"]]]]);
});

await atest("in-file links: after a dropped connection, the links still resolve by external id", async () => {
    const executed = [];
    const client = {
        async call(model, method, args) {
            if (model === "base_import.import" && method === "fields_get") return { file: { help: "" } };
            if (model === "base_import.import" && method === "create") return 1;
            if (model === "base_import.import" && method === "search_read") return [{ create_date: "2026-01-01 00:00:00", create_uid: [2, "Admin"] }];
            if (model === "base_import.import" && method === "execute_import") {
                executed.push([args[1], args[2]]);
                if (executed.length === 1) throw Object.assign(new Error("dropped"), { title: "Network error" });
                return { ids: [300], messages: [] };
            }
            // Acme's batch was saved along with a contact of its own: 2 records for 1 row.
            if (model === "res.partner" && method === "search") return [200, 201];
            throw new Error(`unexpected ${model}.${method}`);
        },
    };
    const j = selfJob([["John", "Acme", ""], ["Acme", "", ""]], { Acme: { status: "missing", candidates: [] } });
    const r = await execute.createExecutor(client).run(j, plan.analyze(j));
    eq(executed.length, 2, "the recovered batch isn't sent again");
    eq(executed[1][0], ["name", "parent_id/id"]);
    eq(r.created, [200, 201, 300]);
    eq(r.warnings.length, 1, "only the dropped connection's");
});

await atest("in-file links: rounds after a dropped connection that can't be mapped back leave the link empty, with a warning", async () => {
    let n = 0;
    const client = {
        async call(model, method, args) {
            if (model === "base_import.import" && method === "fields_get") return { file: { help: "" } };
            if (model === "base_import.import" && method === "create") return 1;
            if (model === "base_import.import" && method === "search_read") return [{ create_date: "2026-01-01 00:00:00", create_uid: [2, "Admin"] }];
            if (model === "base_import.import" && method === "execute_import") {
                if (++n === 1) throw Object.assign(new Error("dropped"), { title: "Network error" });
                return { ids: [300], messages: [] };
            }
            if (model === "res.partner" && method === "search") return [200, 201];
            throw new Error(`unexpected ${model}.${method}`);
        },
    };
    const j = relatedJob([["Ann", "Bob, Zed"], ["Bob", ""]], MIXED);
    const r = await execute.createExecutor(client).run(j, plan.analyze(j));
    eq([n, r.created], [2, [200, 201, 300]]);
    eq(r.warnings.map((w) => w.line), [null, 2]);
    ok(/1 link to records of this file couldn't be set .*rows 2\./.test(r.warnings[1].message), r.warnings[1].message);
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
// ---------------------------------------------------------------------------
// stock counts (stock.quant)
const QUANT = [
    schema.ID_FIELD,
    F("product_id", "many2one", "Product", { relation: "product.product", required: true }),
    F("location_id", "many2one", "Location", { relation: "stock.location", required: true }),
    F("lot_id", "many2one", "Lot/Serial Number", { relation: "stock.lot" }),
    F("package_id", "many2one", "Package", { relation: "stock.package" }),
    F("owner_id", "many2one", "Owner", { relation: "res.partner" }),
    F("user_id", "many2one", "Assigned To", { relation: "res.users" }),
    F("inventory_quantity", "float", "Counted"),
    F("inventory_quantity_auto_apply", "float", "Inventoried Quantity"),
    F("inventory_date", "date", "Scheduled Date"),
    schema.DBID_FIELD,
];
const OK = (id) => ({ status: "ok", id, candidates: [C(id, String(id))] });

function countJob(headers, rows, mapped, resolutions = {}) {
    const j = plan.newJob("stock.quant", { headers, rows, lines: rows.map((_, i) => i + 2) });
    j.profiles = headers.map((_, c) => profile.profileColumn(rows.map((r) => r[c])));
    const byName = new Map(QUANT.map((f) => [f.name, f]));
    j.mapping = headers.map((_, col) => {
        const path = mapped[col];
        return path ? { col, path, fields: path.map((n) => byName.get(n)), status: "auto", score: 1, candidates: [] } : { col, path: null, status: "none", candidates: [] };
    });
    for (const m of plan.active(j)) {
        const r = plan.relationOf(m);
        if (r) j.rel.set(m.col, { ...r, sep: "," });
    }
    for (const [col, res] of Object.entries(resolutions)) j.resolutions.set(Number(col), new Map(Object.entries(res)));
    OdooImport.inventory.ensure(j);
    return j;
}
const quant = (id, product, location, qty, extra = {}) => ({
    id, product_id: [product, `P${product}`], location_id: [location, `L${location}`], lot_id: extra.lot || false, package_id: extra.package || false, owner_id: false,
    quantity: qty, reserved_quantity: extra.reserved || 0, inventory_quantity: extra.counted || 0, inventory_quantity_set: !!extra.set, user_id: extra.user || false,
});
const PRODUCTS = new Map([[1, { label: "Desk", tracking: "none", storable: true }], [2, { label: "Chair", tracking: "lot", storable: true }], [3, { label: "Service", tracking: "none", storable: false }]]);
const LOCATIONS = new Map([[10, { label: "WH/Stock", usage: "internal", company: 1 }], [11, { label: "Partners/Customers", usage: "customer", company: null }]]);

test("stock count: column choice, lot names left to the count, key put aside", () => {
    const inv = OdooImport.inventory;
    const j = countJob(["Product", "Lot", "Location", "Qty"], [["Desk", "", "WH/Stock", "5"], ["Chair", "L-NEW", "WH/Stock", "2"]],
        [["product_id"], ["lot_id"], ["location_id"], ["inventory_quantity"]],
        { 0: { Desk: OK(1), Chair: OK(2) }, 1: { "L-NEW": { status: "missing", candidates: [] } }, 2: { "WH/Stock": OK(10) } });
    eq(inv.columns(j), { product: 0, location: 2, lot: 1, package: null, owner: null, qty: 3, lotByName: true });
    eq(plan.analyze(j).conflicts.length, 0, "a lot name is matched per product by the count, not by name alone");
    eq(inv.problems(j), []);
    j.key = { col: 0, field: "id", mode: "update" };
    inv.setMode(j, "overwrite");
    eq(j.key, null);
    eq(inv.setMode(j, "default"), true, "the key comes back for Odoo's default flow");
    eq(j.key.field, "id");
    eq(plan.analyze(j).conflicts.map((c) => c.key), ["m2o:1:l-new"], "default flow: Odoo's own lot lookup");
    const k = countJob(["Product", "Lot"], [["Desk", ""]], [["product_id"], ["lot_id"]], { 0: { Desk: OK(1) } });
    eq(inv.problems(k), ["Map a column to Counted Quantity.", "Map a column to Location, or set one location for every row (Review step)."]);
});

test("stock count: rows matched to quants, summed, new lots, blanks and errors", () => {
    const inv = OdooImport.inventory;
    const rows = [
        ["Desk", "", "WH/Stock", "5"], // quant 100: 3 on hand -> 5
        ["Chair", "L1", "WH/Stock", "2"], // quant 101 (lot 7)
        ["Chair", "l1", "WH/Stock", "1"], // same lot (case), summed: 3
        ["Chair", "L2", "WH/Stock", "4"], // L2 exists for another product only: new lot
        ["Desk", "", "WH/Stock", ""], // no quantity: left out
        ["Service", "", "WH/Stock", "1"], // not storable
        ["Desk", "", "Customers", "1"], // not internal
        ["Desk", "", "WH/Stock", "-1"], // negative
    ];
    const j = countJob(["Product", "Lot", "Location", "Qty"], rows, [["product_id"], ["lot_id"], ["location_id"], ["inventory_quantity"]],
        { 0: { Desk: OK(1), Chair: OK(2), Service: OK(3) }, 2: { "WH/Stock": OK(10), Customers: OK(11) } });
    const a = plan.analyze(j);
    eq(a.conflicts.length, 0);
    const read = inv.readRows(j, a);
    eq(read.blank, [4]);
    eq(read.errors.map((e) => e.row), [7]);
    const quants = [quant(100, 1, 10, 3), quant(101, 2, 10, 6, { lot: [7, "L1"], reserved: 4 }), quant(102, 1, 10, 0, { package: [5, "PK"] })];
    const lots = [{ id: 7, name: "L1", product_id: [2, "Chair"] }, { id: 8, name: "L2", product_id: [1, "Desk"] }];
    const p = inv.compute({ mode: "listed", ...read, products: PRODUCTS, locations: LOCATIONS, lots: lots.filter((l) => l.product_id[0] === 2), quants, has: { lot: true, package: false, owner: false }, lines: j.table.lines });
    eq(p.errors.map((e) => e.row).sort(), [5, 6, 7]);
    eq(p.lines.map((l) => [l.action, l.quant && l.quant.id, l.rows, l.onHand, l.counted, l.lotLabel]), [
        ["update", 100, [0], 3, 5, ""],
        ["update", 101, [1, 2], 6, 3, "L1"],
        ["create", null, [3], 0, 4, "L2"],
    ]);
    eq(p.newLots, [{ name: "L2", product: 2, company: 1 }]);
    eq([p.stats.update, p.stats.create, p.stats.zero, p.stats.up, p.stats.down, p.stats.net, p.stats.blank], [2, 1, 0, 2, 1, 3, 1]);
    const titles = p.warnings.map((w) => w.title);
    ok(titles.includes("2 rows for Chair (L1) in WH/Stock"), "summed rows");
    ok(titles.includes("Chair (L1) in WH/Stock: counted below the reserved quantity"), "reserved");
    ok(titles.some((t) => t.startsWith("1 row has no counted quantity")), "blank rows");
    eq(p.zeros, [], "listed: nothing else is touched");
});

test("stock count: overwrite counts the rest of the location 0; add adds to on hand", () => {
    const inv = OdooImport.inventory;
    const entries = [{ row: 0, product: 1, location: 10, lot: null, lotName: "", package: null, owner: null, qty: 2 }];
    const quants = [
        quant(100, 1, 10, 3), // counted 2
        quant(103, 1, 10, 1), // a duplicate quant of the same key (an earlier import): counted 0
        quant(104, 2, 10, 5, { lot: [7, "L1"] }), // not in the sheet: 0
        quant(105, 1, 10, 4, { package: [5, "PK"] }), // Desk in a package, no Package column: kept
        quant(106, 2, 10, 0), // nothing there, nothing counted: left alone
        quant(107, 2, 10, 0, { set: true, counted: 9 }), // an open count of 9: counted 0
        quant(99, 1, 10, 0), // an empty duplicate of 100: left to Odoo's cleanup, and not the one counted
    ];
    const base = { entries, products: PRODUCTS, locations: LOCATIONS, quants, has: { lot: true, package: false, owner: false }, lines: [2] };
    const o = inv.compute({ ...base, mode: "overwrite" });
    eq(o.lines.map((l) => [l.quant.id, l.others.map((q) => q.id), l.onHand, l.counted]), [[100, [103], 4, 2]]);
    eq(o.zeros.map((z) => [z.quant.id, z.counted]), [[104, 0], [107, 0]]);
    eq([o.stats.zero, o.stats.net, o.stats.total], [3, -7, 4]);
    ok(o.warnings.some((w) => w.title === "P1 in L10: 4 more not counted" && /packages/.test(w.message)), "packaged stock kept");
    ok(o.warnings.some((w) => /split over 2 quants/.test(w.title)), "duplicate quants");
    const add = inv.compute({ ...base, mode: "add" });
    eq(add.lines.map((l) => [l.onHand, l.counted, l.diff]), [[4, 6, 2]]);
    eq(add.zeros, []);
});

test("stock count: a tracked product needs its lot, an untracked one takes none", () => {
    const inv = OdooImport.inventory;
    const SERIAL = new Map([...PRODUCTS, [4, { label: "Laptop", tracking: "serial", storable: true }]]);
    const e = (row, product, qty, extra = {}) => ({ row, product, location: 10, lot: null, lotName: "", lotText: "", package: null, owner: null, qty, ...extra });
    const entries = [
        e(0, 2, 3), // Chair (lots) without a lot: error
        e(1, 2, 0), // Chair counted 0 without a lot: clears stock from before lots, fine
        e(2, 4, 1), // Laptop (serials) without a serial: error
        e(3, 1, 2, { lotName: "L1", lotText: "L1" }), // Desk (no lots) with a lot name: error
        e(4, 1, 2, { lot: 7, lotText: "L1" }), // Desk with a lot picked by id: error
        e(5, 2, 1, { lotName: "L1", lotText: "L1" }), // Chair with its lot: fine
        e(6, 1, 2), // Desk without a lot: fine
    ];
    const lots = [{ id: 7, name: "L1", product_id: [2, "Chair"] }];
    const p = inv.compute({ mode: "listed", entries, products: SERIAL, locations: LOCATIONS, lots, quants: [], has: { lot: true, package: false, owner: false }, lines: [2, 3, 4, 5, 6, 7, 8] });
    eq(p.errors.map((x) => [x.row, x.line]), [[0, 2], [2, 4], [3, 5], [4, 6]]);
    ok(/Chair is tracked by lots: the row has no lot/.test(p.errors[0].message), p.errors[0].message);
    ok(/Laptop is tracked by serial numbers/.test(p.errors[1].message), p.errors[1].message);
    ok(/Desk has no lots or serial numbers, but the row gives “L1”/.test(p.errors[2].message), p.errors[2].message);
    eq(p.lines.map((l) => l.rows), [[1], [5], [6]]);
    eq(p.warnings.filter((w) => /lots|serial/.test(w.title)), [], "no lot warnings left: they're errors now");
    const none = inv.compute({ mode: "listed", entries: [e(0, 2, 3)], products: SERIAL, locations: LOCATIONS, quants: [], has: { lot: false, package: false, owner: false }, lines: [2] });
    ok(/no Lot\/Serial column: map one/.test(none.errors[0].message), none.errors[0].message);
});

test("stock count: offered on the tested releases only (18.0, 19.0, 20.0)", () => {
    const inv = OdooImport.inventory;
    const v = (vi, server_version) => OdooImport.rpc.version({ server_version_info: vi, server_version });
    eq([[18, 0], [19, 0], [20, 0]].map((x) => inv.tested(v(x))), [true, true, true]);
    eq(inv.tested(v(["saas~18", 3, 0, "final", 0, ""])), false, "Odoo Online intermediate release");
    eq(inv.tested(v(["saas~19", 1])), false);
    eq([[17, 0], [16, 0], [21, 0]].map((x) => inv.tested(v(x))), [false, false, false]);
    eq(inv.tested(v([], "")), false, "unknown version");
    eq(inv.tested(null), false);
});

await atest("stock count: the only location fills in for every row, and leaves Odoo's default flow", async () => {
    const inv = OdooImport.inventory;
    const fake = ({ locs, multi, whs }) => ({ async call(model, method) {
        if (model === "stock.location") return locs;
        if (model === "res.users" && method === "has_group") { if (multi instanceof Error) throw multi; return multi; }
        if (model === "stock.warehouse") return whs;
        throw new Error(`${model}.${method}`);
    } });
    eq(await inv.soleLocation(fake({ locs: [{ id: 8, display_name: "WH/Stock" }] }), 2), { id: 8, label: "WH/Stock", why: "the only stock location" });
    const two = [{ id: 8, display_name: "WH/Stock" }, { id: 9, display_name: "WH/Stock/Shelf 1" }];
    eq(await inv.soleLocation(fake({ locs: two, multi: false, whs: [{ id: 1, lot_stock_id: [8, "WH/Stock"] }] }), 2), { id: 8, label: "WH/Stock", why: "the warehouse's stock location" });
    eq(await inv.soleLocation(fake({ locs: two, multi: true }), 2), null, "storage locations on: the sheet must say");
    eq(await inv.soleLocation(fake({ locs: two, multi: new Error("no access") }), 2), null);
    eq(await inv.soleLocation(fake({ locs: two, multi: false, whs: [{ id: 1, lot_stock_id: [8, "A/Stock"] }, { id: 2, lot_stock_id: [12, "B/Stock"] }] }), 2), null);
    eq(await inv.soleLocation(fake({ locs: [] }), 2), null);

    const j = countJob(["Product", "Qty"], [["Desk", "5"]], [["product_id"], ["inventory_quantity"]], { 0: { Desk: OK(1) } });
    ok(inv.problems(j).some((x) => /Location/.test(x)), "no location yet");
    j.count.sole = { id: 8, label: "WH/Stock", why: "the only stock location" };
    j.defaults.set("location_id", inv.soleDefault(j.count.sole));
    eq(inv.problems(j), []);
    eq(inv.readRows(j, plan.analyze(j)).entries.map((x) => x.location), [8]);
    inv.setMode(j, "default");
    eq(j.defaults.has("location_id"), false, "Odoo's default flow: not the user's choice there");
    inv.setMode(j, "overwrite");
    eq(j.defaults.get("location_id").out, "8", "back in a count: filled in again");
    j.defaults.set("location_id", { out: "9", label: "WH/Stock/Shelf 1", path: "location_id/.id" });
    inv.setMode(j, "default");
    eq(j.defaults.get("location_id").out, "9", "a location the user picked stays");
});

await atest("stock count: run sends updates with .id and creations with the quant key, never twice", async () => {
    const inv = OdooImport.inventory;
    const calls = [];
    const executor = { async batch(model, matrix, rows, dryrun) { calls.push({ model, fields: matrix.fields, rows, dryrun }); return { ids: rows.map((_, k) => 500 + calls.length * 10 + k), messages: [] }; } };
    const client = { async call(model, method, args) { calls.push({ model, method, args }); return args[0].map((_, k) => 900 + k); } };
    const q = quant(100, 1, 10, 3, { set: true, counted: 8, user: [6, "Ann"] });
    const plan1 = {
        mode: "overwrite",
        lines: [
            { action: "update", quant: q, others: [quant(103, 1, 10, 1)], product: 1, location: 10, lot: null, package: null, owner: null, counted: 2, rows: [0], productLabel: "Desk", locationLabel: "WH/Stock", lotLabel: "" },
            { action: "create", quant: null, others: [], product: 2, location: 10, lot: null, newLot: "L9", package: null, owner: null, counted: 4, rows: [1], productLabel: "Chair", locationLabel: "WH/Stock", lotLabel: "L9" },
        ],
        zeros: [{ action: "zero", quant: quant(104, 2, 10, 5), others: [], counted: 0, rows: [], productLabel: "P2", locationLabel: "L10", lotLabel: "" }],
        newLots: [{ name: "L9", product: 2, company: 1 }],
    };
    const dry = await inv.run(client, executor, plan1, { dryrun: true, uid: 2 });
    ok(dry.ok, "dry run ok");
    eq(calls.some((c) => c.method === "create"), false, "no lot is created by a check");
    eq(calls.filter((c) => c.fields).map((c) => [c.fields, c.rows]), [
        [[".id", "inventory_quantity", "user_id/.id"], [["100", "2", "2"], ["103", "0", "2"], ["104", "0", "2"]]],
        [["product_id/.id", "location_id/.id", "inventory_quantity", "user_id/.id"], [["2", "10", "4", "2"]]],
    ], "a check leaves the new lot empty");
    calls.length = 0;
    const r = await inv.run(client, executor, plan1, { uid: 2 });
    eq(calls[0], { model: "stock.lot", method: "create", args: [[{ name: "L9", product_id: 2, company_id: 1 }]] });
    eq(calls[2].fields, ["product_id/.id", "location_id/.id", "lot_id/.id", "inventory_quantity", "user_id/.id"]);
    eq(calls[2].rows, [["2", "10", "900", "4", "2"]]);
    eq([r.created, r.updated.length, r.count.created.length, r.count.zeroed], [[], 3, 1, 2]);
    eq(r.count.prev[0], { id: r.updated[0], set: true, qty: 8, user: 6 });
    eq(r.deps, [{ relation: "stock.lot", ids: [900] }]);
});

await atest("stock count: undo restores open counts, leaves applied ones", async () => {
    const inv = OdooImport.inventory;
    const calls = [];
    const client = { async call(model, method, args) {
        calls.push([model, method, args]);
        if (method === "search_read") return [{ id: 1, inventory_quantity_set: true }, { id: 2, inventory_quantity_set: true }, { id: 4, inventory_quantity_set: true }];
        return true;
    } };
    const errors = await inv.undo(client, { count: { prev: [{ id: 1, set: false, qty: 0, user: null }, { id: 2, set: true, qty: 8, user: 6 }, { id: 3, set: false, qty: 0, user: null }], created: [4] }, deps: [] });
    eq(calls.slice(1), [["stock.quant", "action_clear_inventory_quantity", [[4, 1]]], ["stock.quant", "write", [[2], { inventory_quantity: 8, user_id: 6 }]], ["stock.quant", "action_view_inventory", []]]);
    eq(errors, ["1 count was already applied in Odoo and can't be undone here."]);
});

await atest("stock count: apply only the waiting counts, in batches, leaving moved stock for review", async () => {
    const inv = OdooImport.inventory;
    const calls = [];
    const client = { async call(model, method, args, kwargs, context) {
        calls.push([method, args, context]);
        if (method === "search_read") return [1, 2, 3, 4, 5].map((id) => ({ id, inventory_quantity_set: id !== 3, is_outdated: id === 4 }));
        if (method === "action_apply_inventory" && args[0].includes(5)) return { type: "ir.actions.act_window", res_model: "stock.inventory.conflict" };
        return true;
    } };
    const entry = { count: { prev: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], created: [5] } };
    const r = await inv.apply(client, entry, { reason: "Count A", batchSize: 2 });
    eq(calls.slice(1), [["action_apply_inventory", [[1, 2]], { inventory_name: "Count A" }], ["action_apply_inventory", [[5]], { inventory_name: "Count A" }]]);
    eq([r.applied, r.outdated, r.gone, r.errors], [[1, 2], [4, 5], 1, []]);
});

await atest("stock count: apply stops on Odoo's refusal, keeping what was applied", async () => {
    const inv = OdooImport.inventory;
    let n = 0;
    const client = { async call(model, method) {
        if (method === "search_read") return [1, 2].map((id) => ({ id, inventory_quantity_set: true, is_outdated: false }));
        if (n++) throw new Error("Only a stock manager can do that");
        return true;
    } };
    const r = await inv.apply(client, { count: { prev: [{ id: 1 }, { id: 2 }], created: [] } }, { batchSize: 1 });
    eq([r.applied, r.errors], [[1], ["Only a stock manager can do that"]]);
});

await atest("stock count: a count sheet has one row per stock key, split quants added up", async () => {
    const client = { async call(model, method) {
        if (model === "stock.quant") return [quant(1, 1, 10, 10), quant(2, 1, 10, -2), quant(3, 2, 10, 5, { lot: [7, "L1"] }), quant(4, 2, 10, 0)];
        if (model === "product.product") return [{ id: 1, default_code: "DESK" }, { id: 2, default_code: "CHAIR" }];
        throw new Error(`${model}.${method}`);
    } };
    const t = await OdooImport.inventory.countSheet(client, { locations: [10] });
    eq(t.sheets[0].rows, [["CHAIR", "L1", "L10", 5, null], ["DESK", "", "L10", 8, null]]);
});

await atest("stock count: a count sheet maps back to the right fields", async () => {
    const fields = QUANT;
    const headers = ["Product", "Lot/Serial Number", "Location", "Package", "Owner", "On Hand (not imported)", "Counted Quantity"];
    const rows = [["FURN_1", "L1", "WH/Stock", "", "", "3", ""], ["FURN_2", "", "WH/Stock", "", "", "1", ""]];
    const map = await columns.automap({ headers, profiles: headers.map((_, c) => profile.profileColumn(rows.map((r) => r[c]))), fields, subFields: async () => [] });
    eq(map.map((m) => m.path && m.path.join("/")), ["product_id", "lot_id", "location_id", "package_id", "owner_id", null, "inventory_quantity"]);
    const plain = ["Item", "Serial", "Bin", "Qty"];
    const map2 = await columns.automap({ headers: plain, profiles: plain.map(() => profile.profileColumn(["x"])), fields, subFields: async () => [] });
    eq(map2.map((m) => m.path && m.path.join("/")), ["product_id", "lot_id", "location_id", "inventory_quantity"]);
});

// ---------------------------------------------------------------------------
// export columns
const LIST_ARCH = `<list><field name="name"/><field name="email"/><field name="phone" optional="show"/><field name="city" optional="hide"/><field name="vat" optional="hide"/><field name="comment" column_invisible="1"/></list>`;
const fakeViews = (arch) => ({ async call(model, method) { if (method === "get_views") return { views: { list: { arch } } }; throw new Error(method); } });
const fakeSchemas = { async load() { return { fields: new Map(PARTNER.map((f) => [f.name, { ...f, importable: f.name !== "email", store: true }])) }; } };
const onOff = (list) => list.map((x) => `${x.on ? "+" : "-"}${x.path.join("/")}`);

await atest("export columns: the list on screen first, its hidden optional columns unticked", async () => {
    const client = fakeViews(LIST_ARCH);
    eq(onOff(await OdooImport.export.defaultPaths(client, fakeSchemas, "res.partner", "data")), ["+name", "+email", "+phone", "-city", "-vat"]);
    // the user switched Phone off and City on in the list's column menu, and moved Email last
    const page = { shown: ["name", "city", "email"], hidden: ["phone", "vat"] };
    eq(onOff(await OdooImport.export.defaultPaths(client, fakeSchemas, "res.partner", "data", page)), ["+name", "+city", "+email", "-phone", "-vat"]);
    // re-import: External ID, editable shown columns, required fields; editable hidden ones unticked
    eq(onOff(await OdooImport.export.defaultPaths(client, fakeSchemas, "res.partner", "reimport", page)), ["+id", "+name", "+city", "-phone", "-vat"]);
    eq(await OdooImport.export.listViewColumns(client, "res.partner"), { shown: ["name", "email", "phone"], hidden: ["city", "vat"] });
});

finish();
