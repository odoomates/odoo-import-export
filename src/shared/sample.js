/* Odoo Import Export: sample contacts to try the import on any database.
 *
 * Built from the database itself (its countries, states, tags and the current user, in the
 * user's language), so the same things happen everywhere: exact matches, typos that come back
 * as close matches, a state settled by its country, a tag to create, a country that doesn't
 * exist. Rows are marked ("Sample – …", sample+…@example.com) so they can't be mistaken for
 * real data, and the import's Undo removes them.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const COMPANIES = ["Northwind Traders", "Lumière Design", "Peachtree Supplies", "Rhein Logistik", "Ganesh Textiles", "Iberia Foods", "Atlas Partners", "Blue Harbor"];
  const CITIES = ["Brussels", "Paris", "Atlanta", "Berlin", "Mumbai", "Madrid", "Poseidonia", "Boston"];

  // A believable typo: two neighbouring letters of the longest word swapped ("France" -> "Frnace").
  function typo(name, avoid = new Set()) {
    const words = String(name).split(" ");
    const w = words.reduce((best, x, i) => (x.length > words[best].length ? i : best), 0);
    const word = words[w];
    for (let i = Math.min(2, word.length - 2); i < word.length - 1; i++) {
      if (word[i] === word[i + 1] || !/\p{L}/u.test(word[i]) || !/\p{L}/u.test(word[i + 1])) continue;
      const swapped = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
      const out = [...words.slice(0, w), swapped, ...words.slice(w + 1)].join(" ");
      if (out !== name && !avoid.has(out.toLowerCase())) return out;
    }
    return `${name}x`;
  }

  // CSV cell (the paste reader takes CSV).
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

  /* -> {csv, rows, tag, expect} where expect lists what the review will show. */
  async function build(client, schemas, session) {
    const partner = await schemas.load("res.partner");
    const has = (f) => partner.fields.has(f) && partner.fields.get(f).importable;
    const countries = await client.call("res.country", "search_read", [[], ["name", "code"]], { limit: 400 });
    const byCode = new Map(countries.map((c) => [c.code, c.name]));
    const names = new Set(countries.map((c) => c.name.toLowerCase()));
    const pick = (code, fallback) => byCode.get(code) || fallback;

    // A state name used in two countries, one of them ours: shows narrowing by the Country column.
    let state = null;
    if (has("state_id")) {
      try {
        const states = await client.call("res.country.state", "search_read", [[], ["name", "country_id"]], { limit: 5000 });
        const seen = new Map();
        for (const s of states) {
          const k = s.name.toLowerCase();
          if (!seen.has(k)) seen.set(k, []);
          seen.get(k).push(s);
        }
        for (const list of seen.values()) {
          const countriesOf = new Set(list.map((s) => s.country_id && s.country_id[0]));
          if (countriesOf.size >= 2 && !names.has(list[0].name.toLowerCase())) {
            state = { name: list[0].name, country: list[0].country_id[1] };
            break;
          }
        }
        // No shared name: a plain state of the United States still shows a link being matched.
        if (!state) {
          const us = states.find((s) => s.country_id && s.country_id[1] === pick("US", ""));
          if (us) state = { name: us.name, country: us.country_id[1] };
        }
      } catch {
        state = null;
      }
    }

    let existingTag = null;
    if (has("category_id")) {
      try {
        const tags = await client.call("res.partner.category", "search_read", [[], ["name"]], { limit: 1, order: "id" });
        existingTag = tags.length ? tags[0].name : null;
      } catch {
        existingTag = null;
      }
    }
    const tag = `Sample tag ${Math.floor(1000 + Math.random() * 9000)}`;
    const user = (session && (session.name || session.username)) || "";

    const be = pick("BE", "Belgium");
    const fr = pick("FR", "France");
    const us = pick("US", "United States");
    const de = pick("DE", "Germany");
    const india = pick("IN", "India");
    const es = pick("ES", "Spain");
    const stamp = Date.now().toString(36);

    const columns = ["Name", "Email", "Phone", "City", "Country"];
    if (has("state_id")) columns.push("State");
    if (has("category_id")) columns.push("Tags");
    if (has("user_id") && user) columns.push("Salesperson");
    if (has("credit_limit")) columns.push("Credit Limit");

    const plan = [
      { country: be, tags: [existingTag, tag].filter(Boolean), user, credit: "1,500.50" },
      { country: typo(fr, names), tags: [tag], user, credit: "200" },
      { country: state ? state.country : us, state: state ? state.name : "", tags: existingTag ? [existingTag] : [], user, credit: "750" },
      { country: de, tags: [], user, credit: "" },
      { country: india, tags: [tag], user: user ? typo(user) : "", credit: "3000" },
      { country: typo(es, names), tags: [], user, credit: "90.5" },
      { country: "Atlantis", tags: [], user, credit: "" },
      { country: typo(us, names), tags: existingTag ? [existingTag] : [], user, credit: "1200" },
    ];
    const rows = plan.map((p, i) => {
      const values = {
        Name: `Sample – ${COMPANIES[i]}`,
        Email: `sample+${stamp}-${i + 1}@example.com`,
        Phone: `+32 2 555 ${String(1000 + i * 37).slice(-4)}`,
        City: CITIES[i],
        Country: p.country,
        State: p.state || "",
        Tags: p.tags.join(", "),
        Salesperson: p.user,
        "Credit Limit": p.credit,
      };
      return columns.map((c) => values[c]);
    });
    const csv = [columns, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
    return {
      csv,
      rows: rows.length,
      tag,
      typos: [plan[1].country, plan[5].country, plan[7].country, user && columns.includes("Salesperson") ? plan[4].user : null].filter(Boolean),
      missing: "Atlantis",
      state,
    };
  }

  NS.sample = { build, typo };
})();
