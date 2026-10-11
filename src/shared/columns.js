/* Odoo Import Export: automatic column -> field mapping.
 *
 * Every column is scored against every importable field from several signals (exact
 * technical name or label, remembered choice, synonym, fuzzy similarity), adjusted by
 * how well the column's values fit the field type. Pairs are then assigned greedily from
 * the highest score down, so two columns never land on the same field: the loser falls
 * back to its next best field.
 *
 * Headers with a "/" ("Order Lines/Product", "order_line/product_id", "country_id/id")
 * map to sub-fields, the way Odoo's own export writes them.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const { norm, similarity } = NS.text;

  const AUTO = 0.85; // at or above: mapped automatically
  const SUGGEST = 0.5; // at or above: suggested, needs a confirmation
  const FLOOR = 0.45; // below: not even offered as a candidate

  // How well a column profile fits a field type: added to the name score.
  function typeFit(field, prof) {
    const t = prof.type;
    if (t === "empty") return 0;
    const name = field.name;
    let fit = 0;
    switch (field.type) {
      case "char":
      case "text":
      case "html":
        fit = t === "bool" ? -0.3 : ["date", "datetime", "float"].includes(t) ? -0.1 : 0;
        break;
      case "integer":
        fit = t === "int" ? 0.05 : t === "float" ? -0.1 : -0.3;
        break;
      case "float":
      case "monetary":
        fit = t === "int" || t === "float" ? 0.05 : -0.3;
        break;
      case "boolean":
        fit = t === "bool" || prof.boolish ? 0.15 : -0.3;
        break;
      case "date":
      case "datetime":
        fit = t === "date" || t === "datetime" ? 0.1 : -0.3;
        break;
      case "selection":
        fit = selectionFit(field, prof);
        break;
      case "many2one":
        fit = ["date", "datetime", "float", "bool"].includes(t) ? -0.3 : 0;
        break;
      case "many2many":
        fit = prof.list ? 0.05 : ["date", "datetime", "float", "bool"].includes(t) ? -0.3 : 0;
        break;
      case "one2many":
        fit = -0.2;
        break;
      case "binary":
        fit = t === "url" ? 0 : -0.2;
        break;
      case "id":
        fit = prof.xmlid ? 0.1 : 0;
        break;
      case "dbid":
        fit = t === "int" ? 0 : -0.3;
        break;
    }
    if (t === "email" && /mail/.test(name)) fit += 0.1;
    if (t === "phone" && /phone|mobile/.test(name)) fit += 0.1;
    if (t === "url" && /website|url/.test(name)) fit += 0.1;
    return fit;
  }

  // Selection: how many sample values are a key or a label of the selection.
  function selectionFit(field, prof) {
    if (!prof.samples.length || !field.selection) return 0;
    const known = new Set();
    for (const [k, l] of [...field.selection, ...(field.selectionEn || [])]) {
      known.add(norm(k));
      known.add(norm(l));
    }
    const hits = prof.samples.filter((v) => known.has(norm(v))).length / prof.samples.length;
    return hits >= 0.8 ? 0.15 : hits < 0.2 ? -0.2 : 0;
  }

  // Name-based score of a header against one field: {score, source}.
  function nameScore(header, field) {
    const h = norm(header);
    if (!h) return { score: 0, source: "" };
    if (h === norm(field.name)) return { score: 1, source: "name" };
    if (h === norm(field.string) || h === norm(field.stringEn)) return { score: 0.97, source: "label" };
    // "partner_id" style headers without the "_id" suffix ("partner")
    if (/_ids?$/.test(field.name) && h === norm(field.name.replace(/_ids?$/, ""))) return { score: 0.92, source: "name" };
    if (NS.synonyms.synonymFields(header).includes(field.name)) return { score: 0.9, source: "synonym" };
    const fuzzy = Math.max(similarity(h, field.name), similarity(h, field.string), similarity(h, field.stringEn));
    // A misspelt synonym ("Adress") is as good as a close fuzzy match on the label.
    const phrases = NS.synonyms.FIELD_SYNONYMS[field.name] || [];
    const nearSyn = Math.max(0, ...phrases.map((ph) => similarity(h, ph)));
    if (nearSyn >= 0.85 && nearSyn > fuzzy) return { score: 0.85 * nearSyn, source: "synonym" };
    return { score: 0.8 * fuzzy, source: "fuzzy" };
  }

  function scoreField(header, field, prof) {
    const base = nameScore(header, field);
    if (base.score <= 0) return { score: 0, source: "" };
    // Exact names are trusted even if values look odd: the value check will flag bad cells.
    const fit = base.score >= 0.97 ? Math.max(0, typeFit(field, prof)) : typeFit(field, prof);
    return { score: Math.max(0, Math.min(1, base.score + fit)), source: base.source };
  }

  // Split "Order Lines / Product", "order_line/product_id", "country_id/id" into parts.
  function headerParts(header) {
    return String(header).split("/").map((s) => s.trim()).filter(Boolean);
  }

  /* Map every column.
   *   headers, profiles: from the table
   *   fields: importable fields of the model (schema.importable)
   *   subFields(field): Promise of importable fields of a relational field's comodel
   *   memory: Map normalized header -> path array (choices the user made before)
   * Returns [{col, path, score, source, status, candidates: [{path, score, source, label}]}].
   */
  async function automap({ headers, profiles, fields, subFields, memory = new Map() }) {
    const byName = new Map(fields.map((f) => [f.name, f]));
    const pairs = []; // {col, path, score, source, label}
    const candidates = headers.map(() => []);

    for (let col = 0; col < headers.length; col++) {
      const header = headers[col];
      const prof = profiles[col];
      const remembered = memory.get(norm(header));
      if (remembered && (remembered.length > 1 || byName.has(remembered[0]))) {
        pairs.push({ col, path: remembered, score: 1, source: "memory" });
      }

      const parts = headerParts(header);
      if (parts.length > 1) {
        // Relational path: score the head against relational fields, the rest inside its comodel.
        const last = parts[parts.length - 1];
        const headCandidates = fields
          .filter((f) => ["one2many", "many2many", "many2one"].includes(f.type))
          .map((f) => ({ f, ...nameScore(parts[0], f) }))
          .filter((c) => c.score >= SUGGEST)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        for (const hc of headCandidates) {
          if (parts.length === 2 && (last === "id" || last === ".id") && hc.f.type !== "one2many") {
            pairs.push({ col, path: [hc.f.name, last], score: hc.score, source: hc.source });
            continue;
          }
          if (hc.f.type !== "one2many") continue;
          const subs = await subFields(hc.f);
          for (const sf of subs) {
            const s = scoreField(parts.slice(1).join(" "), sf, prof);
            if (s.score >= FLOOR) pairs.push({ col, path: [hc.f.name, sf.name], score: Math.min(hc.score, s.score), source: s.source });
          }
        }
      }

      for (const f of fields) {
        if (f.type === "one2many") continue; // only reachable through a "Lines/Field" header
        const s = scoreField(header, f, prof);
        if (s.score >= FLOOR) pairs.push({ col, path: [f.name], score: s.score, source: s.source });
      }
    }

    // Greedy assignment, best pairs first; a field (path) takes one column at most.
    pairs.sort((a, b) => b.score - a.score || a.col - b.col);
    const taken = new Set();
    const result = headers.map((_, col) => ({ col, path: null, score: 0, source: "", status: "none", candidates: candidates[col] }));
    for (const p of pairs) {
      const key = p.path.join("/");
      const list = candidates[p.col];
      if (!list.some((c) => c.path.join("/") === key)) list.push(p);
      const r = result[p.col];
      if (r.path || taken.has(key) || p.score < SUGGEST) continue;
      r.path = p.path;
      r.score = p.score;
      r.source = p.source;
      r.status = p.score >= AUTO ? "auto" : "suggest";
      taken.add(key);
    }
    for (const r of result) r.candidates = r.candidates.slice(0, 5);
    return result;
  }

  NS.columns = { automap, scoreField, nameScore, typeFit, headerParts, AUTO, SUGGEST };
})();
