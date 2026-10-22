# ADR 0002 — Credit Request module data in the typed value store

Status: accepted (Phase 2) · Relates to SDD Sections 3–9, 18, 19.6, 20 · Builds on ADR 0001

## Context
The seven Credit Request modules carry about 690 core-library fields, including 26 repeating sections
(partners, facilities, security-package lines, financial periods …). Tenants change labels, requirements and
visibility, add their own fields, and will add adapters that populate integrated fields. A table column per
field would mean a schema migration for every library change and three engine-specific test cycles.

## Decisions
1. **Values live in `field_values`** (typed attribute-value rows: text / decimal(28,8) / timestamp / boolean),
   the same store tenant custom fields already use. The library's `storage_location = core_column` means
   *core library field*, not a physical column. The Credit Request header (number, borrower, amount, currency,
   base amount, authority level, status) stays in `credit_requests` columns because workflow, authority and
   reporting query it.
2. **Repeating sections** use `form_rows` (one row per grid row, with order) and `field_values.row_key`
   (`'record'` for record-level values, otherwise the `form_rows` id). `row_key` is never NULL, so the unique key
   `(tenant, entity type, entity, field, row)` behaves the same on all three engines (ADR 0001 §4).
3. **Composite types** (tier brackets) are stored as typed parts under `key:part` — never as JSON.
4. **The screen layout is configuration** (`form_layouts`, JSON document stored as text, generated from the
   field library by `tools/library/build_layout.py`). The application parses it; the database never queries it.
5. **Calculated fields** use formulas stored as configuration (`field_formulas`, owner scope `core` or tenant),
   evaluated by a pure, decimal-exact engine (`formula-engine.ts`) on every save. Results are stored like any
   other value, so reports and the audit trail see exactly what users saw. A tenant formula replaces the core one
   through maker-checker governance and is validated (references, scope, cycles, parameters) before it is accepted.
   Formulas awaiting the bank's methodology are `pending` and are not evaluated.
6. **Saves are differential and audited**: one transaction writes only changed values and rows, bumps the
   request's `row_version` (optimistic lock shared with the header and workflow) and appends one audit event with
   the before/after of every changed value, including recomputed ones.
7. **Release configuration for existing tenants**: the seed step adds parameters and value-list entries a
   tenant does not have yet (never overwriting a tenant's value) and records `tenant_config_synced` in its audit
   trail.

## Consequences
- Library changes need no schema migration; a new field appears once the library and layout are reseeded.
- Cross-request analytics over module fields read `field_values` by key (an indexed lookup) or a reporting
  extract; there is no per-field column to index. Fields that become query-critical can be promoted to header
  columns by a migration.
- Integrated fields are entered manually until their adapter exists; completeness counts only manual
  mandatory fields until then.
