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
  "baseCurrency": "KWD",
  "currencies": [{ "code": "KWD", "minorUnits": 3 }, { "code": "USD", "minorUnits": 2 }],
  "grids": { "a.partners": { "rowLabel": "Partner", "ordered": false }, "e.financial_periods": { "rowLabel": "Period", "ordered": true } },
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
    "missing": [{ "key": "…", "label": "…", "module": "borrower_profile", "section": "a.general_information", "rowKey": null }]
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
