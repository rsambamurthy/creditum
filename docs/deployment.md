# Deployment

Two container images, built from the repository root:

| Image | Dockerfile | Listens | Notes |
|---|---|---|---|
| API | `apps/api/Dockerfile` | `PORT` (3000) | Non-root `node` user. Health: `GET /api/health`. |
| Web | `apps/web/Dockerfile` | 8080 | Unprivileged nginx; strict CSP; proxies `/api/` to `API_UPSTREAM` (same origin — no CORS). |

Database migrations are an explicit step: `node dist/database/cli.js migrate`. Reference-tenant seeding
(`node dist/database/cli.js seed`) is for build/test/demo environments only — never in a bank deployment,
where tenants are provisioned from the client's own configuration.

## Configuration (environment)
See `apps/api/.env.example`. Every operational setting is required — the service refuses to start
rather than fall back to a value baked into code. Bank deployments use `AUTH_MODE=oidc` with the
bank's identity provider; `AUTH_MODE=dev` additionally requires `ALLOW_DEV_AUTH=true` and must never
be enabled for a bank.

## Railway (build and test only)
Railway hosts the Integrata build/test environment with demo data only (fictional tenants XYZ Bank
and ABC Finance). Banks deploy the same images in their own environment (SDD Section 24).

Project **Creditum** (production environment):
- `Postgres` — Railway PostgreSQL template.
- `creditum-api` — Dockerfile `apps/api/Dockerfile`; pre-deploy `migrate && seed`; health `/api/health`;
  variables: `DB_TYPE=postgres`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `AUTH_MODE=dev`,
  `ALLOW_DEV_AUTH=true`, `DEV_JWT_SECRET=${{secret(48)}}`, `PORT`, `TOKEN_TTL_SECONDS`, rate-limit settings.
  Private network name `creditum-api`.
- `creditum-web` — Dockerfile `apps/web/Dockerfile`; `API_UPSTREAM=http://creditum-api.railway.internal:3000`;
  public domain.

## Bank deployment checklist (summary of SDD Sections 24 and 26)
- Database: the bank's engine (PostgreSQL, SQL Server or Oracle), TLS on, encryption at rest, the
  application account granted insert-only rights on `audit_events`.
- Identity: OIDC issuer, audience, JWKS URI and claim names for tenant, roles and display name.
- Network: web and API behind the bank's ingress; only the web image exposed.
- Observability: ship container logs and audit export to the bank's SIEM.
- Independent penetration test before first production go-live.
