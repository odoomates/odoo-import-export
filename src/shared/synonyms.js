/* Odoo Import Export: matching hints. Plain data, safe to extend.
 *
 * Nothing here is required: every model and field works without hints. They only turn
 * "suggested" matches into automatic ones for headers and keys that are common in
 * spreadsheets exported from other tools.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  // field name -> header phrases meaning that field (used only when the field exists on the model).
  const FIELD_SYNONYMS = {
    name: ["name", "full name", "title", "description", "label", "designation", "nom", "naam", "nombre", "bezeichnung",
      "customer name", "client name", "vendor name", "supplier name", "contact name", "product name", "item name", "partner name"],
    email: ["email", "e mail", "mail", "email address", "e mail address", "courriel", "correo"],
    phone: ["phone", "telephone", "tel", "phone number", "landline", "work phone", "telefoon", "telefono", "telefon"],
    mobile: ["mobile", "cell", "cell phone", "mobile phone", "gsm", "portable", "handy"],
    website: ["website", "web", "url", "homepage", "site", "web site"],
    street: ["street", "address", "address 1", "address line 1", "street address", "adresse", "rue", "strasse"],
    street2: ["street 2", "address 2", "address line 2", "street2"],
    zip: ["zip", "zip code", "postal code", "postcode", "post code", "cp", "plz", "code postal"],
    city: ["city", "town", "ville", "stad", "ciudad", "ort", "locality"],
    state_id: ["state", "province", "region", "county", "state province"],
    country_id: ["country", "country name", "pays", "land", "pais"],
    country_code: ["country code", "iso country"],
    vat: ["vat", "tax id", "vat number", "tva", "btw", "tax number", "gst", "gstin", "ein", "nif", "cif"],
    ref: ["ref", "reference", "internal reference", "code", "customer code", "vendor code", "account number"],
    company_name: ["company", "company name", "organisation", "organization", "societe"],
    parent_id: ["parent", "parent company", "related company", "company", "account"],
    function: ["job", "job title", "job position", "position", "function", "role"],
    title: ["salutation", "honorific"],
    lang: ["language", "lang", "langue"],
    comment: ["notes", "note", "comment", "comments", "remarks", "internal notes"],
    category_id: ["tags", "tag", "labels", "categories", "segments"],
    tag_ids: ["tags", "tag", "labels"],
    user_id: ["salesperson", "sales person", "account manager", "owner", "responsible", "assigned to", "user"],
    team_id: ["sales team", "team"],
    company_id: ["company"],
    currency_id: ["currency", "devise", "ccy"],
    active: ["active", "enabled", "archived"],
    is_company: ["is company", "is a company", "company type", "company?", "is company?", "is a company?"],
    // products
    default_code: ["sku", "item code", "product code", "internal reference", "reference", "ref", "part number", "article number", "code"],
    barcode: ["barcode", "ean", "ean13", "upc", "gtin", "bar code"],
    list_price: ["price", "sales price", "sale price", "unit price", "list price", "selling price", "retail price"],
    standard_price: ["cost", "cost price", "unit cost", "purchase price", "standard price"],
    categ_id: ["category", "product category", "item category", "family"],
    uom_id: ["uom", "unit", "unit of measure", "units", "measure"],
    uom_po_id: ["purchase uom", "purchase unit"],
    weight: ["weight", "poids", "gewicht"],
    volume: ["volume"],
    type: ["product type", "type"],
    sale_ok: ["can be sold", "sellable", "sale ok"],
    purchase_ok: ["can be purchased", "purchasable", "purchase ok"],
    description_sale: ["sales description", "sale description"],
    description_purchase: ["purchase description"],
    // orders, invoices, lines
    partner_id: ["customer", "client", "partner", "contact", "vendor", "supplier", "customer name", "client name", "vendor name", "supplier name"],
    partner_invoice_id: ["invoice address", "billing address", "bill to"],
    partner_shipping_id: ["delivery address", "shipping address", "ship to"],
    date_order: ["order date", "date", "date ordered"],
    invoice_date: ["invoice date", "bill date", "date"],
    invoice_date_due: ["due date", "payment due"],
    date: ["date", "accounting date", "posting date"],
    date_deadline: ["deadline", "due date"],
    client_order_ref: ["customer reference", "po number", "customer po", "your reference"],
    payment_term_id: ["payment terms", "terms", "payment term"],
    pricelist_id: ["pricelist", "price list"],
    product_id: ["product", "item", "article", "product name", "item name", "sku"],
    product_uom_qty: ["quantity", "qty", "ordered qty", "ordered quantity", "units", "qté", "menge", "cantidad"],
    product_qty: ["quantity", "qty", "ordered qty"],
    quantity: ["quantity", "qty"],
    price_unit: ["unit price", "price", "price per unit", "rate"],
    discount: ["discount", "disc", "discount %", "remise"],
    tax_id: ["taxes", "tax", "vat rate"],
    tax_ids: ["taxes", "tax", "vat rate"],
    account_id: ["account", "gl account", "account code"],
    journal_id: ["journal"],
    debit: ["debit", "dr"],
    credit: ["credit", "cr"],
    amount: ["amount", "total"],
    amount_currency: ["amount in currency", "foreign amount"],
    analytic_distribution: ["analytic", "analytic account", "cost center"],
    // people, projects, misc
    job_id: ["job", "job position", "position"],
    department_id: ["department", "dept"],
    work_email: ["work email", "email", "business email"],
    work_phone: ["work phone", "office phone", "phone"],
    mobile_phone: ["work mobile", "mobile"],
    project_id: ["project"],
    stage_id: ["stage", "status", "pipeline stage"],
    priority: ["priority", "importance"],
    date_start: ["start date", "start", "from"],
    date_end: ["end date", "end", "to"],
    expected_revenue: ["expected revenue", "deal value", "amount", "opportunity amount"],
    probability: ["probability", "win probability"],
    contact_name: ["contact name", "contact person"],
    sequence: ["sequence", "order", "position", "sort"],
    code: ["code", "short code"],
    id: ["external id", "xml id", "xmlid", "external identifier"],
    ".id": ["database id", "db id", "record id"],
  };

  // Alternate keys tried after the record name when resolving many2one values: model -> fields.
  const MODEL_KEYS = {
    "res.partner": ["email", "vat", "ref", "company_registry", "phone"],
    "product.product": ["default_code", "barcode"],
    "product.template": ["default_code", "barcode"],
    "res.country": ["code"],
    "res.country.state": ["code"],
    "res.currency": ["name", "symbol"],
    "res.lang": ["code", "iso_code"],
    "res.users": ["login", "email"],
    "hr.employee": ["work_email", "barcode", "identification_id"],
    "account.account": ["code"],
    "account.journal": ["code"],
    "account.tax": ["description"],
    "account.analytic.account": ["code"],
    "product.category": ["complete_name"],
    "stock.location": ["complete_name", "barcode"],
    "stock.warehouse": ["code"],
    "uom.uom": [],
    "crm.tag": [],
    "project.project": [],
  };

  // Field names that make good alternate keys on any model without a MODEL_KEYS entry.
  const GENERIC_KEYS = ["code", "default_code", "ref", "barcode", "email", "login", "vat", "complete_name", "iso_code", "short_code", "symbol"];

  // Common unit spellings -> the name Odoo ships (en_US). Applied before looking up uom.uom.
  const VALUE_ALIASES = {
    "uom.uom": {
      pcs: "Units", pc: "Units", piece: "Units", pieces: "Units", ea: "Units", each: "Units", unit: "Units", u: "Units", nos: "Units", stk: "Units",
      kgs: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg",
      gram: "g", grams: "g", gr: "g",
      litre: "L", liter: "L", litres: "L", liters: "L", l: "L", lt: "L",
      meter: "m", metre: "m", meters: "m", metres: "m",
      hour: "Hours", hours: "Hours", hrs: "Hours", hr: "Hours", h: "Hours",
      day: "Days", days: "Days",
      dozen: "Dozens", dozens: "Dozens", dz: "Dozens",
    },
  };

  // Build the reverse index: normalized phrase -> [field names].
  const PHRASES = new Map();
  for (const [field, phrases] of Object.entries(FIELD_SYNONYMS)) {
    for (const ph of phrases) {
      const key = NS.text.norm(ph);
      if (!PHRASES.has(key)) PHRASES.set(key, []);
      PHRASES.get(key).push(field);
    }
  }

  function synonymFields(header) {
    return PHRASES.get(NS.text.norm(header)) || [];
  }

  NS.synonyms = { FIELD_SYNONYMS, MODEL_KEYS, GENERIC_KEYS, VALUE_ALIASES, synonymFields };
})();
