# Creditum

**Configuration-first corporate lending credit origination platform** — Integratatech.ai Pvt Ltd.

Creditum is a product, not a client build: its core contains only industry-standard fields, rules and
validations, and every bank or NBFC is onboarded by **configuration** — currencies, thresholds, approval
hierarchy, workflows, field labels and rules — never by changing code. The design is in
`docs/` (Solution Design Document v0.14 and the Core Field Library v1.0).

## What Phase 0 delivers

| Capability | Where | SDD |
|---|---|---|
| Field Registry seeded with the 703-field Core Field Library; tenant label/requirement overrides; tenant custom fields stored in a typed extension table | `apps/api/src/modules/field-registry` | 19.1 |
| Rules engine — condition → action rules stored as data, thresholds read from configuration, exact decimal comparisons | `modules/rules` | 19.2 |
| Workflow engine — per-tenant, per-request-type state machine with segregation of duties and delegated-authority checks | `modules/workflow` | 19.3 |
| Typed tenant configuration (no defaults in code), currency catalog with scale and rounding, FX to base, value lists, delegated authority matrix | `modules/configuration` | 18 |
| Configuration governance — maker-checker per tenant setting, every change audited | `GovernanceService` | 19.4, 26.1 |
| Credit Request — configurable numbering, base-currency conversion with the rate stored, required authority level, optimistic locking | `modules/credit-request` | 3, 26.1 |
| Append-only, hash-chained audit trail with verification endpoint | `modules/audit` | 26.2 |
| OIDC sign-in for banks; development sign-in only when explicitly enabled; role checks on every route | `modules/auth` | 22, 26.3 |
| Two fictional reference tenants: **XYZ Bank** (GCC-style) and **ABC Finance** (Indian NBFC) | `apps/api/seed/tenants` | 19.5 |
| Engineering guardrails enforced in CI | `tools/guardrails` | 25.4 |
| Web console in the Integrata design language | `apps/web` | 20 |

## Non-negotiables (enforced by the build)

- **Nothing hardcoded.** No currency code or symbol, threshold, limit, fee or rate appears in application code. `node tools/guardrails/check.mjs` fails the build otherwise; `--self-test` proves every rule fires.
- **Exact money.** Amounts, rates and ratios are decimal strings end to end and `DECIMAL`/`NUMBER` in the database — never JavaScript floating point.
- **Portable database.** One codebase on PostgreSQL, SQL Server and Oracle. Column types come only from `apps/api/src/common/db-types.ts`; migrations use TypeORM's schema builder (no SQL text); no stored procedures; no JSON columns queried by the database. CI runs the full integration suite on all three engines.
- **Tenant isolation.** Tenant scope comes from the authenticated request context (`tenantWhere()`); the guardrail check rejects unscoped repository reads and writes, and tests attempt cross-tenant access.
- **Audit everything.** Every business and configuration change appends a hash-chained audit record in the same transaction.

## Run locally

Requirements: Node.js 22, a PostgreSQL database (SQL Server or Oracle also work — see `apps/api/.env.example`).

```bash
npm ci
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL; for local dev use AUTH_MODE=dev + ALLOW_DEV_AUTH=true + DEV_JWT_SECRET
npm run build -w apps/api
(cd apps/api && set -a && . ./.env && set +a && node dist/database/cli.js migrate && node dist/database/cli.js seed && node dist/main.js)
npm run dev -w apps/web                      # http://localhost:5173 (proxies /api to :3000)
```

Sign in to workspace `xyz-bank` or `abc-finance` and pick a user (development sign-in only).

## Test

```bash
node tools/guardrails/check.mjs --self-test && node tools/guardrails/check.mjs
npm run test:unit -w apps/api
TEST_DATABASE_URL=postgres://user@localhost:5432/creditum_test npm run test:integration -w apps/api
# other engines: DB_TYPE=mssql|oracle with DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME / DB_SERVICE_NAME
```

The integration suite proves, among other things: no schema drift between migration and entities;
28-digit decimals round-trip exactly; KWD accepts 3 decimals while INR rejects them; the same rule
gives different outcomes under each tenant's thresholds; cross-tenant reads return 404; stale updates
return 409; a level-1 approver cannot approve a level-2 request; the maker of a configuration change
cannot approve it; and tampering with one audit record is detected.

## Deploy

The same container images run on Railway (build and test, demo data only), in a bank's cloud tenancy,
or on-premise. See `docs/deployment.md`.

## Repository layout

```
apps/api          NestJS + TypeORM API (TypeScript)
apps/web          React console (Vite)
tools/guardrails  Static checks for SDD 25.4
docs/             SDD, Core Field Library, design reference, ADRs, deployment notes
.github/workflows CI: guardrails, build, integration on 3 databases, security scans, containers
```
