# Odoo Import Export privacy policy

Odoo Import Export does not collect, transmit or sell any data.

- It runs only when you click its toolbar button or press its shortcut, and only in that tab.
- Your files, the data you import, export or chart, go only between your browser and the Odoo
  server of the page you opened it on, with your existing Odoo session: every operation runs as your
  Odoo user, with your access rights. The extension never sees your password.
- To start from the list you are looking at, a small read-only script in the Odoo page reads which
  model it shows, its current search and the records you ticked. It changes nothing in the page and
  sends nothing anywhere.
- Stored locally in your browser with `storage.local`, per Odoo address and database:
  - the field you chose for each column header, and the record you chose for values that didn't
    match exactly, so the next import of a similar file needs fewer clicks;
  - the columns you chose for exports, per model and purpose, and the analyses you saved (grouping,
    measure, chart type and filters);
  - a history of up to 30 imports (model, file name, date, counts, and the ids of the records each
    import created, so they can be undone);
  - whether you already tried the sample contacts, and the Odoo versions you chose to try although
    they are not supported;
  - your settings (batch size, fast mode, export format).
- The contents of your files and of the records are never stored by the extension.
- The welcome page shown after installing is part of the extension and loads nothing from the web.
- There is no account, no analytics, no telemetry, no remote code and no third-party service.

Uninstalling the extension deletes everything it stored.
