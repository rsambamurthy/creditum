# ADR 0001 — Database portability decisions

Status: accepted (Phase 0) · Relates to SDD Sections 19.1, 19.6, 25

## Context
Creditum must run on PostgreSQL, Microsoft SQL Server and Oracle, because banks often require the
database their operations team already runs. Portability must be proven by tests, not claimed.

## Decisions
1. **One column-type helper.** `apps/api/src/common/db-types.ts` maps each logical type to the engine:
   strings (`varchar` / `nvarchar` / `nvarchar2`), text (`text` / `nvarchar(max)` / `nclob`), decimals
   (`decimal` / `number`), booleans (`boolean` / `bit` / `number(1)`), timestamps (`timestamptz` /
   `datetime2` / `timestamp`). Entities and migrations use only this helper.
2. **Identifiers are 36-character strings**, not native UUID types (which differ per engine).
3. **Exact decimals are strings in the application.** PostgreSQL returns DECIMAL as text; Oracle is
   configured with `fetchAsString = [NUMBER]`; all values pass through a transformer that normalises
   trailing zeros. The integration suite round-trips a 28-digit value on every engine. *Known risk:*
   the SQL Server driver (tedious) parses DECIMAL into a JavaScript number; values beyond about 15
   significant digits would lose precision. The CI round-trip test exists to catch exactly this; if it
   fails on SQL Server, the fix is to read decimals as text for that driver (CAST in a custom
   repository read, or a driver-level type mapping) — tracked as the first SQL Server follow-up.
4. **No nullable columns in unique keys.** PostgreSQL treats NULLs as distinct in unique indexes,
   SQL Server and Oracle (partly) do not. Shared core-library rows use `owner_scope = 'core'` instead
   of `tenant_id IS NULL` (SDD 19.1 describes the concept as NULL; this is the portable form).
5. **Empty strings are avoided as stored values.** Oracle stores `''` as NULL. Configuration uses
   explicit tokens (for example request-number separator `none`).
6. **JSON is stored as text and parsed by the application.** Rule and workflow definitions are never
   queried inside by the database. Tenant custom fields use a typed attribute-value table
   (`field_values`), not JSON columns.
7. **Migrations use the TypeORM schema builder** (`createTable` with `Table` objects), never SQL text,
   and a drift test fails if migrations and entities disagree.
8. **Locking uses `pessimistic_write`** through TypeORM (portable `SELECT … FOR UPDATE` / `UPDLOCK`)
   for the audit chain head and sequence counters.
9. **Audit hashes are computed over an ISO-8601 text timestamp** stored alongside the native
   timestamp, so verification does not depend on each engine's timestamp precision or time zone.

## Consequences
- Some engine-specific optimisations (JSONB indexes, native UUIDs, array columns) are deliberately
  not used.
- Adding a new engine (for example MySQL, which TypeORM also supports) is a scoped task: extend the
  helper, add a CI job, fix what the suite reveals.
