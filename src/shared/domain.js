/* Odoo Import Export: simple filters -> an Odoo domain.
 *
 * A filter is a list of conditions, all of which must match:
 *   {path: ["partner_id", "country_id"], type: "many2one", op: "in", value: [{id, label}]}
 * The operators offered depend on the field type; dates have presets ("this month",
 * "last 30 days"...) computed in the browser's time zone.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const TEXT = [["ilike", "contains"], ["not ilike", "doesn't contain"], ["=", "is"], ["!=", "is not"], ["set", "is set"], ["notset", "is not set"]];
  const NUMBER = [["=", "="], ["!=", "≠"], [">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"], ["between", "between"]];
  const DATE = [
    ["today", "today"], ["yesterday", "yesterday"], ["this_week", "this week"], ["last_7", "last 7 days"],
    ["this_month", "this month"], ["last_month", "last month"], ["last_30", "last 30 days"],
    ["this_quarter", "this quarter"], ["this_year", "this year"], ["last_year", "last year"],
    ["after", "after"], ["before", "before"], ["between", "between"], ["set", "is set"], ["notset", "is not set"],
  ];
  const RELATION = [["in", "is"], ["not in", "is not"], ["ilike", "name contains"], ["set", "is set"], ["notset", "is not set"]];
  const SELECTION = [["in", "is"], ["not in", "is not"]];
  const BOOLEAN = [["true", "is yes"], ["false", "is no"]];

  function operators(type) {
    switch (type) {
      case "integer":
      case "float":
      case "monetary":
        return NUMBER;
      case "date":
      case "datetime":
        return DATE;
      case "many2one":
      case "many2many":
      case "one2many":
        return RELATION;
      case "selection":
        return SELECTION;
      case "boolean":
        return BOOLEAN;
      default:
        return TEXT;
    }
  }

  // Operators that need no value.
  const NO_VALUE = new Set(["set", "notset", "true", "false", "today", "yesterday", "this_week", "last_7", "this_month", "last_month", "last_30", "this_quarter", "this_year", "last_year"]);

  const pad = (n) => String(n).padStart(2, "0");
  const day = (y, m, d) => new Date(y, m, d);

  // [start, end) of a date preset, as local Dates.
  function presetRange(op, now = new Date()) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    const today = day(y, m, d);
    const plus = (date, days) => day(date.getFullYear(), date.getMonth(), date.getDate() + days);
    switch (op) {
      case "today":
        return [today, plus(today, 1)];
      case "yesterday":
        return [plus(today, -1), today];
      case "this_week": {
        const monday = plus(today, -((today.getDay() + 6) % 7));
        return [monday, plus(monday, 7)];
      }
      case "last_7":
        return [plus(today, -6), plus(today, 1)];
      case "last_30":
        return [plus(today, -29), plus(today, 1)];
      case "this_month":
        return [day(y, m, 1), day(y, m + 1, 1)];
      case "last_month":
        return [day(y, m - 1, 1), day(y, m, 1)];
      case "this_quarter": {
        const q = Math.floor(m / 3) * 3;
        return [day(y, q, 1), day(y, q + 3, 1)];
      }
      case "this_year":
        return [day(y, 0, 1), day(y + 1, 0, 1)];
      case "last_year":
        return [day(y - 1, 0, 1), day(y, 0, 1)];
      default:
        return null;
    }
  }

  // A local Date as the domain value for the field type: "2024-03-01" for dates, the UTC
  // "2024-02-29 23:00:00" for datetimes (Odoo stores datetimes in UTC).
  function dateValue(date, type) {
    if (type === "datetime") return date.toISOString().slice(0, 19).replace("T", " ");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // "2024-03-01" from an <input type=date> -> local Date at midnight.
  function parseDay(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
    return m ? day(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // One condition -> domain terms (prefix notation), or null when incomplete.
  function conditionDomain(c, now = new Date()) {
    const name = c.path.join(".");
    const t = c.type;
    const v = c.value;
    switch (c.op) {
      case "set":
        return [[name, "!=", false]];
      case "notset":
        return [[name, "=", false]];
      case "true":
        return [[name, "=", true]];
      case "false":
        return [[name, "=", false]];
    }
    if (c.op === "range" && Array.isArray(v) && v[0] instanceof Date) {
      // [start, end) as Dates: used for comparisons
      return ["&", [name, ">=", dateValue(v[0], t)], [name, "<", dateValue(v[1], t)]];
    }
    if (t === "date" || t === "datetime") {
      const range = presetRange(c.op, now);
      if (range) return ["&", [name, ">=", dateValue(range[0], t)], [name, "<", dateValue(range[1], t)]];
      const a = parseDay(Array.isArray(v) ? v[0] : v);
      const b = parseDay(Array.isArray(v) ? v[1] : null);
      const next = (date) => day(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      if (c.op === "after" && a) return [[name, ">=", dateValue(next(a), t)]];
      if (c.op === "before" && a) return [[name, "<", dateValue(a, t)]];
      if (c.op === "between" && a && b) return ["&", [name, ">=", dateValue(a, t)], [name, "<", dateValue(next(b), t)]];
      return null;
    }
    if (c.op === "between") {
      const [a, b] = Array.isArray(v) ? v.map(Number) : [];
      return Number.isFinite(a) && Number.isFinite(b) && String(v[0]).trim() !== "" && String(v[1]).trim() !== "" ? ["&", [name, ">=", a], [name, "<=", b]] : null;
    }
    if (c.op === "in" || c.op === "not in") {
      const ids = (Array.isArray(v) ? v : []).map((x) => (x && typeof x === "object" ? x.id : x));
      return ids.length ? [[name, c.op, ids]] : null;
    }
    if (v === undefined || v === null || String(v).trim() === "") return null;
    if (["integer", "float", "monetary"].includes(t)) {
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? [[name, c.op, n]] : null;
    }
    if (t === "many2one" || t === "many2many" || t === "one2many") return [[name, c.op, String(v)]];
    // "is" / "is not" ignore case but are exact: =ilike with its wildcards escaped.
    const exact = String(v).replace(/[\\%_]/g, "\\$&");
    if (c.op === "=") return [[name, "=ilike", exact]];
    if (c.op === "!=") return ["!", [name, "=ilike", exact]];
    return [[name, c.op, String(v)]];
  }

  // All complete conditions ANDed.
  function toDomain(conditions, now = new Date()) {
    const parts = conditions.map((c) => conditionDomain(c, now)).filter(Boolean);
    if (!parts.length) return [];
    return [...Array(parts.length - 1).fill("&"), ...parts.flat()];
  }

  // Short text for summaries and printouts: "Country is Belgium, France · Date this month".
  function describe(c, label) {
    const ops = Object.fromEntries(operators(c.type));
    const v = c.value;
    let val = "";
    if (Array.isArray(v)) val = v.map((x) => (x && typeof x === "object" ? x.label : x)).filter((x) => x !== "").join(c.op === "between" ? " and " : ", ");
    else if (v !== undefined && v !== null) val = String(v);
    return `${label} ${ops[c.op] || c.op}${NO_VALUE.has(c.op) ? "" : ` ${val}`}`.trim();
  }

  // ---------------------------------------------------------------------------
  // comparisons: the period of a date condition, and the one to compare it with
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const firstOfMonth = (d) => d.getDate() === 1;
  const MONTHS_OF = { this_month: 1, last_month: 1, this_quarter: 3, this_year: 12, last_year: 12 };

  // [start, end) of a date condition, or null when open-ended (before/after) or not a date.
  function rangeOf(c, now = new Date()) {
    if (!c || (c.type !== "date" && c.type !== "datetime")) return null;
    const preset = presetRange(c.op, now);
    if (preset) return preset;
    if (c.op === "between" && Array.isArray(c.value)) {
      const parse = (x) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x || ""));
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
      };
      const a = parse(c.value[0]);
      const b = parse(c.value[1]);
      return a && b && b >= a ? [a, addDays(b, 1)] : null;
    }
    return null;
  }

  /* The period to compare a date condition with: "previous" (the period just before, by whole
   * months when the period is made of months) or "year" (a year earlier). */
  function compareRange(c, how, now = new Date()) {
    const r = rangeOf(c, now);
    if (!r) return null;
    const [start, end] = r;
    if (how === "year") return [addMonths(start, -12), addMonths(end, -12)];
    let months = MONTHS_OF[c.op] || 0;
    if (!months && firstOfMonth(start) && firstOfMonth(end)) months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
    if (months) return [addMonths(start, -months), start];
    const days = Math.round((end - start) / 86400000);
    return [addDays(start, -days), start];
  }

  // "October 2026", "Q4 2026", "2026", "5 – 11 Oct 2026"
  function rangeLabel([start, end]) {
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const last = addDays(end, -1);
    if (firstOfMonth(start) && firstOfMonth(end)) {
      const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
      if (months === 1) return `${LONG[start.getMonth()]} ${start.getFullYear()}`;
      if (months === 3 && start.getMonth() % 3 === 0) return `Q${start.getMonth() / 3 + 1} ${start.getFullYear()}`;
      if (months === 12 && start.getMonth() === 0) return String(start.getFullYear());
    }
    if (+start === +last) return `${start.getDate()} ${M[start.getMonth()]} ${start.getFullYear()}`;
    const sameYear = start.getFullYear() === last.getFullYear();
    return `${start.getDate()} ${M[start.getMonth()]}${sameYear ? "" : ` ${start.getFullYear()}`} – ${last.getDate()} ${M[last.getMonth()]} ${last.getFullYear()}`;
  }

  // a AND b. A domain is a list of expressions joined by an implicit AND, so two domains
  // (each well formed, prefix operators included) combine by concatenation.
  function and(a, b) {
    return [...(a || []), ...(b || [])];
  }

  NS.domain = { rangeOf, compareRange, rangeLabel, and, operators, toDomain, conditionDomain, presetRange, describe, NO_VALUE, dateValue };
})();
