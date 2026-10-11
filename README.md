# Odoo Import Export

A browser extension (Chrome, Edge, Firefox, Manifest V3) that imports spreadsheets into **any Odoo
model** from any Odoo page, exports any model to Excel or CSV, and charts any model (pie, bar, line)
with PNG, Excel-with-chart and PDF output. Columns are matched to fields automatically, many2one values are looked up
before anything is written, and everything Odoo Import Export isn't sure about goes into one list of
conflicts with ranked suggestions. Click the toolbar button or press **Alt+Shift+I**.

```
File  →  Columns  →  Review  →  Import
         (auto)      (conflicts)  (check with Odoo, import, undo)
```

## What it does

**File**: drop a CSV/TSV, XLSX or ODS file, or copy cells in Excel / Google Sheets and press Ctrl+V.
The separator, encoding (UTF-8, UTF-16, Windows-1252), header row and sheet are detected. The model
comes from the page you are on (`/odoo/contacts` → Contact), or pick any model.

**Not sure which columns to use?** The File step offers **Download a template for <model>**: an
Excel file with the columns to fill (the required fields Odoo can't fill in itself, the fields of
the model's form, and the lines' columns, e.g. *Order Lines / Product*), dropdowns for choices,
yes/no and small related lists (countries, units…), and a Help sheet saying what each column takes,
with an example from your database. The data sheet is left empty on purpose (sample rows get
imported by mistake). Filled in, it maps back by itself. Odoo's own template is offered too when the
model has one.

**Columns**: each column is profiled (numbers and their decimal separator, dates and whether 03/04 is
day/month or month/day, yes/no values, e-mails, phones, comma-separated lists) and scored against
every importable field:

| Signal | Score |
|---|---|
| Header is the technical name (`partner_id`, `order_line/product_id`, `country_id/id`) | 1.0 |
| The mapping you chose for this header before (remembered per database) | 1.0 |
| Header is the field label, in your language or English | 0.97 |
| Synonym (*SKU* → Internal Reference, *Customer* → partner, *Qty* → quantity…), typos included | 0.9 |
| Similar name | up to 0.8 |
| Values fit the field type (dates in a date field, yes/no in a checkbox, known choices) | ± 0.3 |

Pairs are assigned best first, so two columns never land on the same field. **≥ 85%** is mapped
automatically, **50–85%** is suggested and has to be confirmed. `Order Lines/Product`-style headers fill
one2many lines; rows with empty parent columns continue the record above (Odoo's export layout).

**Review**: every relational value is resolved before the import, per distinct value:

1. a choice you made in an earlier import,
2. a database id or an external id (`base.be`),
3. the exact record name (case-insensitive),
4. an alternate key of the related model: e-mail, VAT or reference for contacts; internal reference or
   barcode for products; code for countries, states, accounts, journals… (`src/shared/synonyms.js`),
5. a similar name (typos: *Belgum* → Belgium).

| Result | What happens |
|---|---|
| one match | used, nothing to do |
| several exact matches | **ambiguous**: first narrowed with the other columns of the row (a *Georgia* state with *United States* in the country column), then asked |
| a close match | **close match**: accept with one click, or all of them at once |
| nothing | **not found**: pick a record, create it, leave the cell empty or skip the row |

Conflicts are grouped by value, not by row: *Acme* in 200 rows is one decision. Values of the same
column and kind are grouped again, with actions for the whole group: *Country: 2,000 not found* →
**Create all**, **use one record for all** (search it once), **Leave all empty** or **Skip all rows**;
the values can still be unfolded and decided one by one. **Create** is offered only when Odoo can
create the record from a name: a new country needs its code, so for countries the button is disabled
and says why (the same for missing access rights). Records to create are created 200 at a time. Other conflicts:
values that don't fit the field (not a date, not one of the allowed choices), required fields left
empty, dates that read both ways, records matching several existing ones. Warnings (archived records,
duplicate keys in the file, required fields without a column) don't block anything.
Keyboard: **↑/↓** move, **1–5** pick a suggestion, **C** create, **E** leave empty, **S** skip.
**Preview data** shows the file with every cell tinted by what will happen to it.

**Create or update**: pick a key column (External ID, Database ID, or an alternate key such as
e-mail or internal reference; a unique one is chosen for you). Rows whose key matches an existing
record update it, or are skipped, or are created anyway.

**Import**: *Check with Odoo* runs the whole import inside Odoo and rolls it back, listing every row
Odoo would refuse with its line number. You can skip those rows or download them as a CSV. The import
then runs in batches (500 rows by default) with a progress bar and a stop button. *Undo* deletes the
records the import created, including linked records it created (tags, countries…); records it
updated keep their new values. **History** lists past imports per database with their undo.

**Errors in plain language**: Odoo's messages are explained and grouped, e.g. *Customer is empty, but
Odoo requires it · lines 3, 5, 9 +12*, with what to do (*map a column to it, or set one value for these
rows in Review*); Odoo's original text stays under *Details*. Empty cells of required fields that
Odoo has a default for (company, currency…) get that default on new records, and columns left empty
on every row aren't sent, so they can't wipe those defaults.

**Dropped connections**: reads are retried; a write that lost its connection is never blindly sent
again: Odoo is asked which records this user created since the batch started, and the batch is
resent only if nothing was saved.

## Export

Switch the header to **Export**. Pick the model (the page's model is preselected) and answer one
question: **what is the file for?**

| | Data | For re-importing |
|---|---|---|
| Starting columns | the columns of the model's list view | External ID, name, the editable list-view columns, required fields |
| Headers | field labels ("Customer", "Country") | technical names (`partner_id`, `country_id`) |
| Use | read, share, analyse | edit in Excel and import back: the External ID makes the import update the same records |

Remove a column with **×**, reorder with **↑ ↓**, and add any field by typing its name; **›** (or
→) opens a related record's fields, e.g. *Country › Country Code*. In a **Data** export, adding a lines field (*Order Lines*,
*Invoice Lines*…) adds its useful columns at once (Product, Quantity, Unit Price, Subtotal…, from the
lines table of the record's form), one row per line; re-import exports don't, since importing lines
onto existing records adds them again. The list is remembered per model
and purpose (**Reset to default** brings back the starting columns). Choose **Excel** (bold frozen
header, filters, real numbers and dates) or **CSV** (UTF-8 with BOM, so Excel shows accents), then
**Export N records**. Records are fetched 2,000 at a time through Odoo's own `export_data`, with
progress and Cancel. Tags stay in one cell ("VIP, Gold"); order lines go on extra rows, the layout
the import understands. Odoo allows exporting to administrators and to the "Access to export
feature" group only.

**Start from the page**: on a list, Export and Analyze start from what it shows: the **ticked
records**, else the list's **current search** (search bar and the action's own filter), with a
choice to take all records instead. A small script in the page's own JavaScript world reads the
view (read-only); without it, everything else works the same.

## Analyze

Switch the header to **Analyze** to chart any model:

- **Group by** any stored field, related fields included (**Customer › Country**); dates by day,
  week, month, quarter or year. **Then by** adds a second grouping (stacked columns, one line per
  value). **Measure**: count of records, or the sum / average of a number field (Total, Quantity…).
- **Chart**: Auto picks the form (dates → line, a second grouping → stacked columns, up to 6 groups →
  pie, many or long names → horizontal bars); Columns, Bars, Line, Pie and Donut on request. Top 5 /
  10 / 20 / 50 groups, the rest folded into **Others** (pies keep 5 slices + Others).
- Hover (or tab to) a mark for its values; the table under the chart has every number.
- **PNG** (2×, light background), **Copy image**, **Excel with chart** (the grouped numbers plus a
  native, editable Excel chart), **Print / PDF** (chart, filters and table on a clean page).
- **Compare** with the previous period or the same period last year: add a date filter (e.g. *Order
  Date › this month*), pick *Compare with › the previous period*. Both periods side by side (the
  other one in gray), and the table adds Change and Change % (▲/▼). Previous periods follow the
  calendar (this quarter → last quarter); groups present in only one period are included.
- **Save analysis** keeps the grouping, measure, chart and filters per database; one click reopens it.

Odoo groups the records (`formatted_read_group` on Odoo 19, `read_group` before), so only the totals
travel. If an older version can't group by a related field, the values are read and grouped in the
browser (up to 50,000 records), and the status line says so. Colors are a validated colorblind-safe
palette with separate light and dark steps; a single series uses one color, "Others" is gray.

## Filters

Export and Analyze share one filter (per model): **+ Filter** → pick a field (related fields with
›), then the condition. Text: contains / is / is set…; numbers: = > < between; dates: today, this
week, this month, last month, last 30 days, this quarter, this year, last year, before, after,
between; choices: tick the values; links: pick the records (or "name contains"). All conditions must
match; the record count updates as you type.

**Cancel and discard**: every long step (reading the file, matching, looking values up, the check)
has a **Cancel** button next to its progress; it stops at once and keeps your work. **Discard** in the
header throws away the file, the mapping and your decisions and starts again (second click to
confirm). A running import stops *after the batch being saved* (each batch is committed by Odoo), so
what was saved is known and can be undone.

**Fast mode** (Import step): imports with `tracking_disable`, so the records get no chatter messages
("created", field changes) and no followers. Much faster for big files; off by default because Odoo's
own import keeps the chatter.

## Performance

Measured on a laptop with Odoo 19.5 and a generated contacts file (name, e-mail, phone, city, country,
tags, salesperson, credit limit; with typos and 200 unknown tags):

| 20,000 rows | Time |
|---|---|
| Read the file, profile and map the columns | 0.8 s |
| Look up every value in Odoo (125 requests) | 1.6 s |
| Re-check after each decision | 0.1 s |
| Check with Odoo (dry run, 500-row batches) | 3 min 50 s |
| Import | 8 min 20 s |
| Import in fast mode (2,000 rows: 52 s → 5 s) | ~10× faster |

The extension's own work is small; Odoo's import speed (about 40 rows/s for contacts with chatter,
400 without) decides the total. Lookups are done once per distinct value, batched, and small related
tables (up to 3,000 records: countries, tags, units, users…) are fuzzy-matched in the browser; big ones
use `name_search` for at most 300 distinct unmatched values per column. Conflict cards are drawn 50 at
a time and the preview shows the first 200 rows. After the check, the panel estimates the import time,
and the progress bar shows the time left.

## How it works

The values are resolved and converted in the browser, then sent to Odoo's own import engine
(`base_import.import.execute_import`, the code behind Odoo's Import screen) as a normalized CSV:
relations as database ids (`partner_id/.id`), ISO dates, `.` decimals, selection keys, and `.id` for
records to update. Odoo's validations, defaults and computed fields all apply. Without the
`base_import` module, `load()` is used directly (no check possible).

Everything runs through `/web/dataset/call_kw` with your session, so access rights and record rules
apply. Odoo Import Export never sees your password.

| Part | Files |
|---|---|
| Reading files | `src/shared/csv.js`, `xlsx.js` (XLSX/ODS without a library), `sheet.js` |
| Column profiles | `src/shared/profile.js` |
| Field matching | `src/shared/text.js`, `synonyms.js`, `columns.js`, `schema.js` |
| Value matching | `src/shared/m2o.js`, `values.js`, `records.js` |
| Conflicts and the final matrix | `src/shared/plan.js` |
| Running the import, undo | `src/shared/execute.js`, `rpc.js`, `pipeline.js` |
| Panel | `src/content/odoo-import.js`, `panel-css.js` |

## Compatibility

| Odoo | Status |
|---|---|
| 19.x, 19.5+ (master) | Tested: full end-to-end suite (36 checks) |
| 18.0 | Tested: full end-to-end suite |
| 17.0 | Tested: full end-to-end suite |
| 16.0 | Tested: full end-to-end suite |
| 15.0 and older | Not supported |

Intermediate releases (17.2, 18.3, 19.5…) count as their major version, and Odoo 20 is accepted
ahead of its release. On any other version the panel opens with a warning instead of the tools:
**Try anyway** opens them (remembered for that database and version), **Close** hides the panel.
Versions newer than 20 get a softer "newer than tested" message.

Differences handled per version:

- **Import file**: up to 19.0 Odoo's import takes the file's raw content, later versions base64;
  the field's own description tells which.
- **Updates by key**: Odoo 16 refuses an empty "Database ID" cell, so rows updating existing records
  and rows creating new ones are sent in separate batches.
- **Name matching**: before Odoo 17, record names are matched with `name_search` instead of a
  `display_name` search.
- **Grouping**: `formatted_read_group` on 19, `read_group` on 16-18; related groupings (Customer ›
  Country) aren't supported by the server before 19 and are grouped in the browser instead.
- **Views**: list views are `tree` before 18; Odoo 16 marks hidden columns in a `modifiers` attribute.
- **Rules**: whether a country can be created from a name depends on the version (the code is
  required from 17 on); the panel reads the rules from Odoo rather than assuming them.

Browsers: Chrome/Edge 103+ (tested in Chrome and Chromium), Firefox 128+ (tested in Firefox 155:
unit tests, the packaged add-on, and an import, an export and a chart on a real Odoo).


## Development

No build step and no Node.js needed.

```sh
python3 tools/build.py          # → dist/chrome/, dist/firefox/, dist/*.zip
python3 tools/run_tests.py      # unit tests in headless Chrome
python3 tests/e2e.py --url http://127.0.0.1:8069 --db mydb   # real imports, checked and undone
python3 tests/firefox.py --url http://127.0.0.1:8069 --db mydb   # the same essentials in Firefox
python3 tools/make_fixtures.py  # regenerate tests/fixtures (needs openpyxl)
python3 tools/make_icons.py     # regenerate src/icons (needs Pillow)
```

The end-to-end test expects a database with demo data and the Sales and Contacts apps. It imports
contacts and sale orders, checks them in the database and deletes them again.

Load the extension from `dist/chrome` (chrome://extensions → Developer mode → Load unpacked) or
`dist/firefox` (about:debugging → Load Temporary Add-on).
