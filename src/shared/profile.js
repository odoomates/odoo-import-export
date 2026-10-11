/* Odoo Import Export: column profiling.
 *
 * Looks at every value of a column and works out what it holds: booleans, integers,
 * decimals (and which decimal separator), dates (and whether 03/04 is day-month or
 * month-day), emails, phones, URLs, comma-separated lists or plain text. The mapping
 * scorer uses the type, the value converters use the formats.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const TRUE = new Set(["1", "true", "yes", "y", "x", "✓", "✔", "on", "oui", "ja", "si", "sí", "vrai", "waar", "t"]);
  const FALSE = new Set(["0", "false", "no", "n", "off", "non", "nein", "nee", "faux", "onwaar", "f", "-"]);

  function parseBool(v) {
    const s = String(v).trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
    return null;
  }

  // ---------------------------------------------------------------------------
  // numbers
  const CURRENCY = /[$€£¥₹₩₽₪฿₫₦₱﷼]|\b(usd|eur|gbp|inr|chf|jpy|cad|aud)\b/gi;

  function cleanNumber(v) {
    let s = String(v).trim().replace(CURRENCY, "").replace(/[\s  ']/g, "");
    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1);
    }
    if (s.endsWith("-") && !s.startsWith("-")) {
      sign = -1;
      s = s.slice(0, -1);
    }
    return { s, sign };
  }

  // Which decimal separator a single value implies: ".", ",", or null when it can't tell.
  function decimalHint(v) {
    const { s } = cleanNumber(v);
    const dot = s.lastIndexOf(".");
    const comma = s.lastIndexOf(",");
    if (dot >= 0 && comma >= 0) return dot > comma ? "." : ",";
    if (comma >= 0) return /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? null : ",";
    if (dot >= 0) return /^[-+]?\d{1,3}(\.\d{3})+$/.test(s) ? null : ".";
    return null;
  }

  // Parse with a known decimal separator; returns a Number or null.
  function parseNumber(v, decimal = ".") {
    const { s, sign } = cleanNumber(v);
    let t = s;
    let percent = false;
    if (t.endsWith("%")) {
      percent = true;
      t = t.slice(0, -1);
    }
    const thousands = decimal === "." ? "," : ".";
    if (!new RegExp(`^[-+]?(\\d{1,3}(\\${thousands}\\d{3})+|\\d*)(\\${decimal}\\d*)?$`).test(t) || !/\d/.test(t)) {
      if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t)) return null;
      return sign * Number(t) / (percent ? 100 : 1);
    }
    t = t.split(thousands).join("").replace(decimal, ".");
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return (sign * n) / (percent ? 100 : 1);
  }

  // ---------------------------------------------------------------------------
  // dates
  const MONTHS = {
    jan: 1, january: 1, janv: 1, janvier: 1, januar: 1, ene: 1, enero: 1,
    feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2, februar: 2, febrero: 2,
    mar: 3, march: 3, mars: 3, marz: 3, maerz: 3, marzo: 3,
    apr: 4, april: 4, avr: 4, avril: 4, abr: 4, abril: 4,
    may: 5, mai: 5, mayo: 5,
    jun: 6, june: 6, juin: 6, juni: 6, junio: 6,
    jul: 7, july: 7, juil: 7, juillet: 7, juli: 7, julio: 7,
    aug: 8, august: 8, aout: 8, ago: 8, agosto: 8,
    sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9,
    oct: 10, october: 10, octobre: 10, okt: 10, oktober: 10, octubre: 10,
    nov: 11, november: 11, novembre: 11, noviembre: 11,
    dec: 12, december: 12, decembre: 12, dez: 12, dezember: 12, dic: 12, diciembre: 12,
  };
  const TIME = String.raw`(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]\.?m\.?)?)?(?:\s*(?:z|utc|[+-]\d{2}:?\d{2}))?`;
  const RE_YMD = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`, "i");
  const RE_NUM = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})${TIME}$`, "i");
  const RE_DMONY = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?[-/. ]+([a-zé]+)\.?[-/., ]+(\d{4}|\d{2})${TIME}$`, "i");
  const RE_MONDY = new RegExp(String.raw`^([a-zé]+)\.?[-/. ]+(\d{1,2})(?:st|nd|rd|th)?,?[-/. ]+(\d{4})${TIME}$`, "i");

  const pad = (n) => String(n).padStart(2, "0");
  const year4 = (y) => (y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y));
  const monthOf = (name) => MONTHS[NS.text.norm(name)] || MONTHS[NS.text.norm(name).slice(0, 3)] || null;

  function build(y, m, d, t) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null; // 31 April and friends
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if (!t || t[0] === undefined) return { date, time: null };
    let h = Number(t[0]);
    const ampm = (t[3] || "").toLowerCase().replace(/\./g, "");
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || Number(t[1]) > 59) return null;
    return { date, time: `${pad(h)}:${t[1]}:${t[2] || "00"}` };
  }

  // Classify one value: which shapes could it be, and what does each give.
  // order: "YMD", "DMY", "MDY" or "TEXT"; a/b are the two leading numbers for numeric dates.
  function dateShape(v) {
    const s = String(v).trim();
    let m;
    if ((m = RE_YMD.exec(s))) return { order: "YMD", parts: [Number(m[1]), Number(m[2]), Number(m[3])], t: m.slice(4, 8) };
    if ((m = RE_NUM.exec(s))) return { order: "NUM", a: Number(m[1]), b: Number(m[2]), y: year4(m[3]), t: m.slice(4, 8) };
    if ((m = RE_DMONY.exec(s)) && monthOf(m[2])) return { order: "TEXT", parts: [year4(m[3]), monthOf(m[2]), Number(m[1])], t: m.slice(4, 8) };
    if ((m = RE_MONDY.exec(s)) && monthOf(m[1])) return { order: "TEXT", parts: [Number(m[3]), monthOf(m[1]), Number(m[2])], t: m.slice(4, 8) };
    return null;
  }

  // Parse with a known order for numeric dates ("DMY" or "MDY"). Returns {date, time} or null.
  function parseDate(v, order = "DMY") {
    const sh = dateShape(v);
    if (!sh) return null;
    if (sh.order === "NUM") return order === "MDY" ? build(sh.y, sh.a, sh.b, sh.t) : build(sh.y, sh.b, sh.a, sh.t);
    return build(sh.parts[0], sh.parts[1], sh.parts[2], sh.t);
  }

  // ---------------------------------------------------------------------------
  // column profile
  const RE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
  const RE_URL = /^(https?:\/\/|www\.)\S+$/i;
  const RE_PHONE = /^\+?[\d\s().\-/]{7,20}$/;
  const RE_XMLID = /^[a-z_][\w]*\.[\w.]+$/i;

  // "+32 2 123 45 67", "(555) 123-4567", "02/123.45.67": a phone, unlike "1 234 567" or "1,234.50".
  function phoneLike(v) {
    if (!RE_PHONE.test(v)) return false;
    const digits = v.replace(/\D/g, "").length;
    if (digits < 7) return false;
    if (/^\+/.test(v) || /\(\d{1,5}\)/.test(v)) return true;
    if (/^[-+]?\d{1,3}([ ,.]\d{3})+([.,]\d+)?$/.test(v) || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(v)) return false;
    return digits >= 8 && /\d[\s\-./]\d/.test(v);
  }

  // opts.dateOrder: the user's preferred order for ambiguous numeric dates ("DMY" or "MDY").
  function profileColumn(values, opts = {}) {
    const filled = values.map((v) => String(v ?? "").trim()).filter(Boolean);
    const distinct = [...new Set(filled)];
    const p = {
      filled: filled.length,
      empty: values.length - filled.length,
      distinct: distinct.length,
      samples: distinct.slice(0, 5),
      type: "empty",
      decimal: ".",
      dateOrder: null,
      dateAmbiguous: false,
      hasTime: false,
      list: null,
      xmlid: false,
      leadingZeros: false,
      boolish: false,
    };
    if (!filled.length) return p;
    const n = filled.length;
    const ratio = (count) => count / n;
    const enough = (count) => ratio(count) >= 0.95;

    // booleans: yes/no-like words with few distinct values; a 0/1 column stays "int" but is boolish
    p.boolish = enough(filled.filter((v) => parseBool(v) !== null).length) && distinct.length <= 3;
    if (p.boolish && !filled.every((v) => /^[01]$/.test(v))) {
      p.type = "bool";
      return p;
    }

    // dates
    let ymd = 0;
    let num = 0;
    let dmy = 0;
    let mdy = 0;
    let time = 0;
    for (const v of filled) {
      const sh = dateShape(v);
      if (!sh) continue;
      if (sh.t && sh.t[0] !== undefined) time++;
      if (sh.order === "NUM") {
        num++;
        if (sh.a > 12 && sh.b <= 12) dmy++;
        if (sh.b > 12 && sh.a <= 12) mdy++;
      } else ymd++;
    }
    if (enough(ymd + num)) {
      p.type = time ? "datetime" : "date";
      p.hasTime = time > 0;
      if (num) {
        if (dmy && !mdy) p.dateOrder = "DMY";
        else if (mdy && !dmy) p.dateOrder = "MDY";
        else {
          p.dateOrder = opts.dateOrder || "DMY";
          p.dateAmbiguous = !dmy && !mdy;
          if (dmy && mdy) p.dateMixed = true;
        }
      } else p.dateOrder = "YMD";
      return p;
    }

    // phone numbers before numbers: "+32 2 123 45 67" also parses as a number
    if (enough(filled.filter(phoneLike).length)) {
      p.type = "phone";
      return p;
    }

    // numbers
    const votes = { ".": 0, ",": 0 };
    for (const v of filled) {
      const hint = decimalHint(v);
      if (hint) votes[hint]++;
    }
    p.decimal = votes[","] > votes["."] ? "," : ".";
    const nums = filled.map((v) => parseNumber(v, p.decimal));
    const numeric = nums.filter((x) => x !== null).length;
    if (enough(numeric)) {
      p.leadingZeros = filled.some((v) => /^0\d/.test(v));
      const integers = filled.every((v) => /^[-+]?\d+$/.test(v));
      if (p.leadingZeros && integers) p.type = "text"; // "00123" is a code, not a number
      else {
        p.type = integers ? "int" : "float";
        return p;
      }
    }

    if (enough(filled.filter((v) => RE_EMAIL.test(v)).length)) p.type = "email";
    else if (enough(filled.filter((v) => RE_URL.test(v)).length)) p.type = "url";
    else p.type = "text";

    p.xmlid = enough(filled.filter((v) => RE_XMLID.test(v) && !/\s/.test(v)).length) && p.type === "text";

    // comma / semicolon / pipe separated lists of short items (tags, categories)
    if (p.type === "text") {
      for (const sep of [",", ";", "|"]) {
        const listy = filled.filter((v) => {
          const parts = v.split(sep).map((x) => x.trim());
          return parts.length > 1 && parts.every((x) => x && x.length <= 40);
        });
        if (listy.length && ratio(listy.length) >= 0.2 && filled.every((v) => v.split(sep).every((x) => x.trim().length <= 60))) {
          p.list = sep;
          break;
        }
      }
    }
    return p;
  }

  NS.profile = { profileColumn, parseBool, parseNumber, parseDate, dateShape, decimalHint };
})();
