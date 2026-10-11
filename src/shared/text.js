/* Odoo Import Export: text normalization and similarity used by every matcher.
 *
 * All scores are in [0, 1]. Nothing here talks to Odoo, so it is unit-tested directly.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  // Lowercase, strip accents, turn separators into spaces, collapse whitespace.
  function norm(s) {
    return String(s ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[_\-./\\|:;,()[\]{}#*'"`’]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Compact form for exact comparisons of codes and keys: "ab-12 3" -> "ab123".
  function compact(s) {
    return norm(s).replace(/ /g, "");
  }

  const STOP = new Set(["the", "a", "an", "of", "de", "la", "le", "du", "des", "el", "der", "die", "das", "for", "to"]);

  function tokens(s) {
    return norm(s).split(" ").filter((t) => t && !STOP.has(t));
  }

  function trigrams(s) {
    const t = `  ${compact(s)} `;
    const out = new Map();
    for (let i = 0; i < t.length - 2; i++) {
      const g = t.slice(i, i + 3);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  // Dice coefficient over character trigrams: tolerant to typos and word order changes inside words.
  function trigramSim(a, b) {
    const A = trigrams(a);
    const B = trigrams(b);
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) {
      total += n;
      if (B.has(g)) inter += Math.min(n, B.get(g));
    }
    for (const n of B.values()) total += n;
    return total ? (2 * inter) / total : 0;
  }

  // Edit distance where swapping two neighbouring letters counts as one edit ("Frnace",
  // "Spian"): optimal string alignment.
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  // Two tokens are "the same word" when equal, one is a prefix abbreviation of the other
  // ("qty" / "quantity" is handled by synonyms; "desc" / "description" here), or a typo apart.
  function tokenSim(a, b) {
    if (a === b) return 1;
    if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
    const d = levenshtein(a, b);
    const len = Math.max(a.length, b.length);
    if (len >= 4 && d === 1) return 0.85;
    if (len >= 7 && d === 2) return 0.7;
    return 0;
  }

  // Soft token-set overlap: each token is paired with its best match on the other side.
  function tokenSetSim(a, b) {
    const A = tokens(a);
    const B = tokens(b);
    if (!A.length || !B.length) return 0;
    const best = (xs, ys) => xs.reduce((sum, x) => sum + Math.max(0, ...ys.map((y) => tokenSim(x, y))), 0);
    return (best(A, B) + best(B, A)) / (A.length + B.length);
  }

  // Overall similarity of two short strings (headers, labels, record names).
  function similarity(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (compact(a) === compact(b)) return 0.98;
    return Math.max(tokenSetSim(na, nb), trigramSim(na, nb) * 0.95);
  }

  // Rank many choices against one string: a cheap trigram pass keeps the best `pool` (all of a
  // small list such as countries: a swapped-letter typo shares few trigrams), then the full
  // similarity orders them. choices: [{label, ...}] (trigrams cached on the objects).
  function rank(query, choices, { limit = 8, pool = 400 } = {}) {
    const q = trigrams(query);
    const dice = (g) => {
      let inter = 0;
      let total = 0;
      for (const [k, n] of q) {
        total += n;
        if (g.has(k)) inter += Math.min(n, g.get(k));
      }
      for (const n of g.values()) total += n;
      return total ? (2 * inter) / total : 0;
    };
    const rough = choices.map((c) => {
      if (!c._grams) c._grams = trigrams(c.label);
      return { c, d: dice(c._grams) };
    });
    rough.sort((a, b) => b.d - a.d);
    return rough
      .slice(0, pool)
      .map(({ c }) => ({ ...c, score: similarity(query, c.label) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ _grams, ...c }) => c);
  }

  NS.text = { norm, compact, tokens, trigramSim, levenshtein, tokenSetSim, similarity, rank };
})();
