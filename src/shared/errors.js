/* Odoo Import Export: Odoo's error messages in plain language, with what to do about them.
 *
 * explain(message) -> {title, hint, original}. Unknown messages keep their text as title.
 * group(errors) puts identical explanations together with the lines they concern.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  // Strip "(field_name)" and quotes from a field label taken out of a message.
  const label = (s) => String(s || "").replace(/\s*\([\w.]+\)\s*$/, "").replace(/^['"“]|['"”]$/g, "").trim();

  const RULES = [
    [/Missing required value for the field '([^']+)'(?: \(([\w.]+)\))?/i, (m) => ({
      title: `${label(m[1])} is empty, but Odoo requires it`,
      hint: "Fill it in the file, map a column to it, or set one value for these rows in Review. You can also skip the rows.",
    })],
    [/Missing required field '([^']+)'(?: \(([\w.]+)\))?/i, (m) => ({
      title: `${label(m[1])} is empty, but Odoo requires it`,
      hint: "Fill it in the file, map a column to it, or set one value for these rows in Review. You can also skip the rows.",
    })],
    [/Column ([\w./]+) contains incorrect values \(value: ([^)]*)\)/i, (m) => ({
      title: `“${m[2]}” isn't a valid value for ${m[1]}`,
      hint: "Check the format: numbers like 1234.50, dates like 2024-03-31.",
    })],
    [/null value in column "([\w]+)"[^]*violates not-null constraint/i, (m) => ({
      title: `${m[1]} is empty, but Odoo requires it`,
      hint: "Map a column to it, or set one value for every record in Review.",
    })],
    [/No matching record found for (name|external id|database id) '([^']*)' in field '([^']+)'/i, (m) => ({
      title: `“${m[2]}” doesn't match any ${label(m[3])}`,
      hint: "Pick the right record in Review, create it, or leave the cell empty.",
    })],
    [/Found multiple matches for value "?([^"]*?)"? in field "?([^"(]+?)"? \((\d+) matches\)/i, (m) => ({
      title: `“${m[1]}” matches ${m[3]} ${label(m[2])} records; Odoo used the first one`,
      hint: "Pick the right one in Review so the import doesn't guess.",
    })],
    [/'([^']*)' does not seem to be an? (integer|number|float) for field '([^']+)'/i, (m) => ({
      title: `“${m[1]}” isn't a number (${label(m[3])})`,
      hint: m[2] === "integer" ? "Use a whole number, like 12." : "Use digits with a decimal point, like 1234.50, or fix the decimal separator.",
    })],
    [/'([^']*)' does not seem to be a valid (date|datetime) for field '([^']+)'/i, (m) => ({
      title: `“${m[1]}” isn't a date (${label(m[3])})`,
      hint: "Use a date like 2024-03-31, or check the day/month order in Review.",
    })],
    [/Value '([^']*)' not found in selection field '([^']+)'/i, (m) => ({
      title: `“${m[1]}” isn't one of the choices for ${label(m[2])}`,
      hint: "Review lists the allowed values: pick one, or leave the cell empty.",
    })],
    [/Unknown value '([^']*)' for boolean field '([^']+)'/i, (m) => ({
      title: `“${m[1]}” isn't yes or no (${label(m[2])})`,
      hint: "Use yes/no, true/false or 1/0.",
    })],
    [/Cannot create new '([^']+)' records from their name alone/i, (m) => ({
      title: `${m[1]} records can't be created from a name alone`,
      hint: "Create them in Odoo first, or pick existing ones in Review.",
    })],
    [/You are not allowed to (create|modify|access|read|write|delete|unlink)[^'"]*['"]?([^'"(]+)/i, (m) => ({
      title: `Your Odoo user may not ${{ write: "modify", unlink: "delete", read: "read" }[m[1].toLowerCase()] || m[1].toLowerCase()} ${label(m[2])} records`,
      hint: "Ask an administrator for the access rights, or run the import with a user who has them.",
    })],
    [/don't have the rights to export data/i, () => ({
      title: "Your Odoo user may not export data",
      hint: "An administrator can give you the “Access to export feature” right (Settings › Users).",
    })],
    [/duplicate key value violates unique constraint "?([\w]+)"?|already exists|must be unique/i, () => ({
      title: "Another record already uses this value, and it must be unique",
      hint: "To update the existing record, use “Find existing records by” in Review; otherwise change the value.",
    })],
    [/Incompatible companies on records/i, () => ({
      title: "The records belong to different companies",
      hint: "Add a Company column, or switch Odoo to the right company (company switcher) before importing.",
    })],
    [/You cannot delete .+ as it is used by|is used as the default/i, () => ({
      title: "Can't delete: other records still use it",
      hint: "Delete or change those records first, or archive this one instead.",
    })],
    [/Found more than 10 errors/i, () => ({
      title: "Odoo stopped after many errors",
      hint: "Fix the ones listed; the rest of the file may be fine.",
    })],
    [/invalid input syntax for type (\w+)/i, (m) => ({
      title: `A value has the wrong type (${m[1]} expected)`,
      hint: "Check the column mapped to a number or a link: it may contain text.",
    })],
    [/Session expired|SessionExpired/i, () => ({
      title: "Your Odoo session expired",
      hint: "Log in again in this tab, then retry. Nothing was lost in the panel.",
    })],
    [/Failed to fetch|Network error|NetworkError/i, () => ({
      title: "Couldn't reach Odoo",
      hint: "Check the connection and retry. A batch that didn't reach Odoo wasn't saved.",
    })],
    [/The operation cannot be completed: (.+)/i, (m) => ({
      title: m[1].trim(),
      hint: "Odoo refused the values: check the rows listed.",
    })],
  ];

  function explain(message) {
    const original = String(message || "").trim();
    for (const [re, make] of RULES) {
      const m = re.exec(original);
      if (m) return { ...make(m), original };
    }
    // Unknown: keep Odoo's first line as the title.
    const first = original.split("\n")[0].slice(0, 300);
    return { title: first || "Odoo reported an error", hint: "", original };
  }

  /* errors: [{row, line, message}] -> [{title, hint, original, lines: [n], rows: [i]}] in order of
   * first appearance; identical explanations are merged. */
  function group(errors) {
    const out = new Map();
    for (const e of errors) {
      const x = explain(e.message);
      const key = `${x.title}\u0000${x.hint}`;
      if (!out.has(key)) out.set(key, { ...x, lines: [], rows: [] });
      const g = out.get(key);
      if (e.line !== null && e.line !== undefined && !g.lines.includes(e.line)) g.lines.push(e.line);
      if (e.row !== null && e.row !== undefined && !g.rows.includes(e.row)) g.rows.push(e.row);
    }
    return [...out.values()];
  }

  NS.errors = { explain, group };
})();
