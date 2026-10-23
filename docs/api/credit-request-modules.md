# Credit Request modules — API contract (Phase 2)

The seven Credit Request modules (Borrower Profile, Facility & Collateral, Exposure & Relationship,
Business Profile, Financial Analysis, ESG & Sustainability, Credit Administration) are rendered from
configuration. The screens never hard-code a field: they draw what the layout API returns, so a tenant's
label, requirement and visibility overrides — and its custom fields — appear without a code change.

All amounts, rates and ratios are **decimal strings** in both directions. Dates are `YYYY-MM-DD`.

## `GET /api/layout`

```jsonc
{
  "version": 1,
  "display": { "percentagePlaces": 2, "ratioPlaces": 2 },   // tenant display rounding of calculated values
  "baseCurrency": "KWD",
  "currencies": [{ "code": "KWD", "minorUnits": 3 }, { "code": "USD", "minorUnits": 2 }],
  "grids": { "a.partners": { "rowLabel": "Partner", "ordered": false }, "e.financial_periods": { "rowLabel": "Period", "ordered": true, "labelField": "e.financial_statement_header.fiscal_year_financial_statement_date" } },
  "lists": { "country": [{ "code": "KW", "label": "Kuwait" }] },     // tenant value lists used by the layout
  "modules": [{
    "code": "borrower_profile", "letter": "a", "title": "Borrower Profile",
    "sections": [{
      "code": "a.general_information", "title": "General Information",
      "kind": "record",                 // record | grid | periods
      "grid": null, "rowLabel": null,   // grid code for grid / periods sections
      "fields": [FieldMeta],            // record-level fields (all kinds may have some)
      "columns": [FieldMeta]            // per-row fields (grid / periods only)
    }]
  }]
}
```

`FieldMeta`:

| property | meaning |
|---|---|
| `key` | field key, e.g. `a.general_information.legal_entity` |
| `label`, `helpText` | tenant-effective label and help (overrides applied) |
| `dataType` | library data type (`Text`, `Rich Text`, `Currency Amount`, `Percentage`, `Ratio (decimal)`, `Decimal`, `Integer`, `Integer (days)`, `Date`, `Boolean (Yes/No)`, `Dropdown`, `Currency Code`, `Text (identifier)`, `Address (structured)`, `Tier Bracket (from / to amount + rate)`, `Chart (derived)`, `Table (derived)`, `Section Heading`) |
| `valueKind` | `text` · `decimal` · `date` · `bool` · `composite` · `none` (display only) |
| `parts` | for `composite`: part names; the values are stored under `key + ":" + part` (e.g. `…tiering_bracket_1:from`) |
| `source` | `Manual`, `Integrated`, `Calculated` … (integrated fields are entered manually until their adapter is connected) |
| `requirement` | tenant-effective: `Mandatory` · `Conditional` · `Optional` · `System-populated` |
| `list` | value-list key for dropdowns; `lists[list]` holds the entries. If the tenant has no such list the field is free text |
| `bind` | `borrowerName` / `borrowerRef`: shown from the request header, not editable here |
| `display` | `chart` · `table` · `heading` for display-only types |
| `calc` | for calculated fields: `{ "status": "active" \| "pending", "description": "...", "note": "..." }` |
| `readOnly` | true for bound fields, display-only fields and calculated fields with a formula (active or pending) |

Hidden fields (tenant override) are not returned. Sections left empty are dropped.

## `GET /api/credit-requests/:id/data`

```jsonc
{
  "requestId": "…", "rowVersion": 4, "editable": true,
  "record": { "a.general_information.legal_entity": "xyz_bank", "b.interest_tiering_brackets.tiering_bracket_1:from": "0" },
  "grids": { "a.partners": [{ "rowKey": "3f0c…", "values": { "a.partners.partner_name": "…" } }] },
  "completeness": {
    "mode": "warn",                          // tenant parameter credit_request.mandatory_fields_on_submit: off | warn | block
    "modules": { "borrower_profile": { "mandatory": 42, "filled": 10 } },
    "missing": [{ "key": "…", "label": "…", "module": "borrower_profile", "section": "a.general_information", "sectionTitle": "General Information", "rowKey": null }]
  }
}
```

Completeness counts visible **Mandatory** fields whose source is manual (integrated and calculated fields are
excluded until their adapters are connected). For grid columns each existing row counts.

## `PUT /api/credit-requests/:id/data`

```jsonc
{
  "expectedVersion": 4,
  "record": { "a.general_information.legal_entity": "xyz_bank", "a.client_request.client_request_details": null },
  "grids": { "a.partners": [ { "rowKey": "3f0c…", "values": { … } }, { "values": { … } } ] }
}
```

* `record` merges: keys sent are set (`null` or `""` clears), others are kept.
* Each grid sent **replaces** that grid: rows keep their `rowKey`, rows without one are new, rows not sent are
  deleted, and the array order is the display order (period grids: oldest period first).
* Calculated, bound and display-only fields must not be sent (422 `read_only_field`). Unknown keys → 422
  `unknown_field`. Dropdown values must be active codes of the tenant list (422 `invalid_value`).
* All calculated fields are recomputed on the server after every save and returned.
* Response: the same body as `GET …/data`, plus `"warnings": [string]` from `on_save` rules.
* Errors: 409 `conflict` (stale `expectedVersion`; reload), 422 `not_editable` (state not editable).
* The request's `rowVersion` increases with every save; the header `PUT` and transitions use the same version.

## Submission

When a transition leaves an editable state, missing mandatory fields are checked according to
`credit_request.mandatory_fields_on_submit`: `block` → 422 `mandatory_fields` with `details.missing`;
`warn` → the transition succeeds and its response carries `"warnings": ["…"]`; `off` → no check.

## Administration (config_admin; every change goes through maker-checker when the tenant has it on)

| Screen | Read | Change |
|---|---|---|
| Value lists | `GET /api/config/value-lists` (keys) · `GET /api/config/value-lists/:key/entries` (all entries, incl. retired: `code`, `label`, `sortOrder`, `isActive`) | `PUT /api/config/value-lists/:key` `{ "entries": [{ "code", "label", "active"? }] }` — the whole list in display order. Codes are permanent: an entry left out or sent with `active:false` is retired, never deleted. New codes: letters, digits, `_ - .` |
| Formulas | `GET /api/formulas` (`fieldKey, label, scope core\|tenant, status, expression, description, note, grid, rowVersion`) | `PUT /api/formulas/:key` `{ status?, expression?, description, note?, expectedVersion? }` · `DELETE /api/formulas/:key` (back to the core formula) · `POST /api/formulas/:key/check` `{ expression, status? }` → `{ valid: true }` or 422 `invalid_formula` with the reason (unknown field, wrong scope, circular, parameter not numeric) |
| Screen layout | `GET /api/layout/admin` → `{ scope: core\|tenant, coreVersion, updatedAt, document, fields: { key: { label, dataType, requirement, hidden, scope, calculated } } }` (hidden fields included) | `PUT /api/layout` `{ document }` or `{ reset: true }` |

Layout rules (422 `invalid_layout` otherwise): modules and sections can be reordered and renamed; record-level
fields can move between record sections; grid columns can be reordered within their grid; a tenant may add record
sections with codes `<module letter>.t.<name>`. A field cannot change grid / record level, sections keep their kind,
and every field must stay on the layout (hide a field through field settings instead). When the core layout gains
fields later, they are added to the tenant's arrangement automatically.

## Low-code editing

**Formula text** — administrators write formulas like a spreadsheet; the stored expression is generated.

| Write | Means |
|---|---|
| `[Gross Profit]` · `[Income Statement › Gross Profit]` | a field by its (tenant) label; qualify with the section when a label repeats |
| `+ - * /` (also `× ÷ −`), parentheses, numbers | arithmetic |
| `PERCENT(a, b)` · `GROWTH(cur, prev)` · `PREVIOUS([Field])` | a ÷ b × 100 · % change · previous period |
| `SUM(x)` · `TO_BASE(amount, [Currency])` · `ROUND(x, 0)` · `PARAM("key")` · `ROW_NUMBER()` | table total · base currency · rounding · tenant setting · row number |

- `GET /api/formulas` now includes `text` for every formula; `GET /api/formulas/functions` lists the functions.
- `POST /api/formulas/:key/parse {text}` → `{expression, text}` (normalised) or 422 `invalid_formula` with the reason and character position.
- `PUT /api/formulas/:key` and `POST …/check` accept `text` instead of `expression`.
- `POST /api/formulas/:key/preview {text | expression, requestId}` → `{value}` or `{rows:[{rowKey, label, value}]}`: the formula calculated on a saved request, nothing stored.

**Rule builder** — `GET /api/rules/catalog` → `{ fields:[{key,label,dataType,valueKind,group,section,hidden,list?}], parameters:[{key,valueType,value,description}], lists, currencies }`.
Rules may use the request header fields and record-level form fields (not per-row values). Rules naming an unknown field or an
unconfigured parameter are rejected (422 `invalid_rule`). The stored condition language is unchanged (`var`, `cfg`, `and`, `or`,
`not`, `==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `empty`; actions `block`, `warn`, `require`, `hide`).

## Rule contexts — a rule runs only where its fields exist

| `triggerOn` | `scope` | Runs when | Fields a Require/Hide action may name |
|---|---|---|---|
| `on_save` | `["request"]` | the New / Edit Credit Request form is saved (create, header edit, or a tab save that changes one of the form's fields) | the form's fields (`createFields`) |
| `on_save` | module codes, e.g. `["borrower_profile"]` | that module's tab is saved | fields of those modules (and the form's fields) |
| `on_submit` | — | the request leaves an editable state | any record-level field |
| `on_action` | workflow action codes, e.g. `["approve"]` | that action is taken | any record-level field |

Rules checked only on the New Credit Request form may read only the header and the form's fields. Anything else is refused
with a plain reason (422 `invalid_rule`). Existing `on_save` rules received the `request` context (migration 0003).
`GET /api/rules` returns `contexts` per rule; `GET /api/rules/catalog` returns `contexts: { modules, createFields, actions }`
and, per field, `module` and `onCreateForm`.

**New Credit Request form** — `GET /api/layout` returns `createForm: FieldMeta[]`: the record-level fields shown on the form
besides the header. Tenants choose them on the screen-layout page (`document.createFields` in `PUT /api/layout`).
`POST/PUT /api/credit-requests` accept in `fields` only those keys (422 `unknown_field` otherwise); everything else is entered
on the module tabs.
