# Store listings

Copy-paste material for the Chrome Web Store and Firefox Add-ons (AMO).
Upload packages are built with `python3 tools/build.py`:
`dist/odoo-import-export-<version>-chrome.zip` and `dist/odoo-import-export-<version>-firefox.zip`.
Images: `python3 tools/make_store_images.py` (promo tiles) and
`python3 tools/make_screenshots.py --url … --db …` (screenshots, from a real Odoo with demo data).

---

## Shared text

**Name:** Odoo Import Export

> Store reviewers and Odoo's trademark rules may object to a name that starts with "Odoo". If the
> listing is refused for that reason, rename it (e.g. *Import Export for Odoo*) in `manifest.json`.

**Short description** (Chrome summary, max 132 characters; AMO summary, max 250):

> Import spreadsheets into any Odoo model with automatic matching and undo; export to Excel or CSV; chart any model.

**Full description:**

```
Odoo Import Export brings three tools to any Odoo page (Odoo 16 to 20): an import that does the matching for you, a simple export, and charts you can save. Click the toolbar button or press Alt+Shift+I.

TRY IT IN A MINUTE
On the Contacts page, click "Try it with sample contacts": 8 contacts with typical mistakes (typos, a missing tag, an unknown country). A guide explains each step; nothing is saved unless you click Import, and one click removes them afterwards.

IMPORT
• CSV, Excel (.xlsx), LibreOffice (.ods), or cells pasted from Excel / Google Sheets
• Columns matched to fields by themselves: names, labels in your language or English, synonyms (SKU, Qty, Customer…), typos, and the type of the values
• Links looked up before anything is written: customers, countries, products, tags… by name, e-mail, reference, barcode or code
• Typos come back as close matches ("Frnace" → France?), several matches are narrowed with the other columns of the row, unknown values can be created, left empty or skipped: one decision per value, or for a whole column at once
• Update existing records by a key (e-mail, internal reference, External ID…) instead of duplicating them
• "Check with Odoo" runs the whole import and saves nothing; errors are explained in plain language with the fix
• Import in batches with progress and stop; undo afterwards
• A template per model: the columns to fill, dropdowns for the choices, and a help sheet

EXPORT
• One question: data to read, or a file to edit and import back
• Starts with the columns of the list view; add any field, related fields included (Customer › Country); adding Order Lines brings their useful columns
• All records, the list's current search, or the records you ticked; filters on any field
• Excel or CSV

ANALYZE
• Group by any field, related fields and dates (by day, week, month, quarter, year) included; count, sum or average
• Bars, columns, lines, pie and donut; compare with the previous period or last year
• Save the chart as PNG, as Excel with a real chart, or print it to PDF; save analyses for later

SAFE BY DEFAULT
• Everything runs through your own Odoo session, as your user, with your access rights and record rules
• Nothing is written before you click Import; every import can be undone
• The extension has no access to any site until you open it on that tab

PRIVACY
Your data goes only between your browser and your Odoo server. No account, no analytics, no tracking, no third-party services.

Odoo Import Export is an independent open-source project (MIT), not affiliated with Odoo S.A. "Odoo" is a trademark of Odoo S.A.
Source: https://github.com/odoomates/odoo-import-export
```

**Homepage:** https://github.com/odoomates/odoo-import-export
**Support:** https://github.com/odoomates/odoo-import-export/issues
**Privacy policy:** https://github.com/odoomates/odoo-import-export/blob/main/PRIVACY.md
**License:** MIT

---

## Chrome Web Store (https://chrome.google.com/webstore/devconsole)

**Package:** `dist/odoo-import-export-<version>-chrome.zip`

**Store listing tab**
- Category: *Productivity* (or *Developer Tools*)
- Language: English
- Icon: taken from the package (128×128)
- Screenshots (1280×800), in this order:
  `store/screenshots/1-import-columns.png`, `2-import-review.png`, `3-import-done.png`, `4-export.png`, `5-analyze.png`
- Small promo tile (440×280): `store/promo-small-440x280.png`
- Marquee promo tile (1400×560, optional): `store/promo-marquee-1400x560.png`
- Homepage and support: URLs above

**Privacy practices tab**

*Single purpose:*
> Odoo Import Export lets users of the Odoo web application import spreadsheets into Odoo, export Odoo records to Excel or CSV, and chart them, from a panel on the Odoo page they are on, using their own session.

*Permission justifications:*
- **activeTab**: The panel is injected only into the tab where the user clicks the toolbar button or presses the shortcut, so the extension needs no standing access to any website.
- **scripting**: Used to inject the panel into the active tab when the user asks for it, and a small read-only script that tells the panel which model, search and ticked records the Odoo page shows.
- **storage**: Stores the user's settings, column mappings, saved export columns and analyses, and a local history of their imports (to undo them). Nothing is sent anywhere.

*Host permissions:* none requested.

*Remote code:* **No, I am not using remote code.** All JavaScript is packaged in the extension; no code is downloaded or evaluated.

*Data usage:* collects none of the listed data types. Tick the three certifications.

*Privacy policy URL:* see above.

**Distribution:** Public, all regions (or Unlisted to share by link only).

---

## Firefox Add-ons (https://addons.mozilla.org/developers/)

**Submit a New Add-on → On this site** (listed) → upload `dist/odoo-import-export-<version>-firefox.zip`.

- Compatibility: Firefox (desktop), minimum 128 (from the manifest)
- Source code: **not needed**. Nothing is minified, transpiled or bundled; the package is the source.
- Summary / description / homepage / support / license (MIT) / privacy policy: as above
- Categories: *Productivity*, *Other*
- Tags: odoo, import, export, excel, csv, erp, charts
- Screenshots: the same PNGs

**Notes to reviewer:**
```
Odoo Import Export needs an Odoo web client (16 to 20) where you are logged in (https://www.odoo.com/trial gives a free instance, or runbot.odoo.com).
To test: log in to Odoo, open Contacts, click the toolbar button (or Alt+Shift+I), then "Try it with sample contacts" and follow the guide. "Check with Odoo" saves nothing; after Import, "Remove the sample records" deletes them.

- The panel is injected on demand with scripting.executeScript (activeTab only); there are no host permissions and no persistent content scripts.
- src/page/bridge.js is injected into the page's world (world: "MAIN") only to read the Odoo web client's current view (model, search domain, ticked record ids). It is read-only and answers the panel through DOM events carrying JSON.
- All network requests go to the Odoo origin of the current tab (/web/session/get_session_info and /web/dataset/call_kw), with the user's own session, via content.fetch in Firefox. No remote code, no analytics, no third-party services.
- The panel's markup is built with createElement; all server data and file contents are rendered with textContent. Files are read locally (CSV parser and a small XLSX/ODS reader in src/shared/). "Print / PDF" builds a detached document with DOM methods (the chart SVG and a table, no scripts) and prints it from a hidden iframe (srcdoc).
- The welcome page (src/welcome/welcome.html) is opened once on install with tabs.create and loads nothing from the web.
- The source is not minified; tests are in tests/ of https://github.com/odoomates/odoo-import-export.
```
