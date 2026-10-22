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
3. **Exact decimals are strings in the application.** PostgreSQL returns DECIMAL as text. CI proved
   that SQL Server and Oracle did not: both returned `12345678901234567000` for
   `12345678901234567890.12345678`. Fixed in `apps/api/src/database/exact-decimals.ts`:
   - *Oracle* — a node-oracledb `fetchTypeHandler` returns NUMBER (and CLOB) as text. (TypeORM resets
     `fetchAsString` when it connects, so that setting cannot be used.)
   - *SQL Server* — the tedious driver divides the wire integer by 10^scale in floating point and
     offers no option to avoid it. Creditum wraps the driver's exported `readValue` for DECIMAL/NUMERIC
     only, reads the sign byte and 4–16-byte little-endian magnitude with BigInt, and formats it with the
     column scale. Every other type is delegated untouched. Unit tests encode real wire-format values
     (including 28-digit, negative, zero, NULL and split-packet cases); the integration round-trip runs
     on all three engines. Because this relies on a driver internal, the tedious version is covered by
     those tests on every upgrade — a layout change fails CI rather than corrupting values.
   All values then pass a transformer that normalises trailing zeros.
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
