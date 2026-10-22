# Working on Creditum

Creditum is a banking product. Every change must keep it auditable, portable and configuration-first.
Read `README.md` and the SDD in `docs/` (Sections 18, 19, 25, 26) before changing behaviour.

## Rules for every change
- Never hardcode a currency, threshold, limit, fee, rate, rating scale or retention period. Read it from tenant configuration (`ConfigurationService`). Run `node tools/guardrails/check.mjs`; it must report no violations. Use `// guardrail-allow: <reason>` only for genuinely non-business numbers, and say why.
- Money, rates and ratios are decimal strings. Use `src/common/decimal.ts`; never `number`, `parseFloat` or float arithmetic.
- Database: column types only via `T` in `src/common/db-types.ts`; schema changes only as new migrations written with the TypeORM schema builder (no SQL strings); no stored procedures/triggers; no JSON queried by the database. Avoid nullable columns in unique keys (use `owner_scope`).
- Tenant data: every repository read/update/delete uses `tenantWhere()` (or `visibleScopes()` for shared-library tables).
- Business and configuration changes run in a transaction and call `AuditService.append` in the same transaction.
- Configuration writes go through `GovernanceService.submit` (maker-checker per tenant setting) with a validator.
- New behaviour needs tests: unit tests for pure logic, integration tests for API behaviour. Tests must pass on PostgreSQL locally; CI also runs SQL Server and Oracle.
- Reference tenants (XYZ Bank, ABC Finance) are fictional; their values live in `apps/api/seed/tenants/*.json` as configuration data. Never introduce real institution names, identifiers or data.

## Commands
- `npm run typecheck -w apps/api` · `npm run build -w apps/api` · `npm run test:unit -w apps/api`
- `TEST_DATABASE_URL=... npm run test:integration -w apps/api`
- `npm run build -w apps/web`
