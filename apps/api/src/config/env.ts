/**
 * Operational settings come from the environment and are validated at start-up.
 * There are no fallback values for anything security- or business-relevant: a missing setting
 * stops the service rather than silently running with a default baked into code.
 */
import { currentDbType, DbType } from '../common/db-types';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`Missing required environment variable ${name}`);
  return v.trim();
}

function requiredInt(name: string): number {
  const v = required(name);
  if (!/^\d+$/.test(v)) throw new Error(`Environment variable ${name} must be a whole number`);
  return Number(v);
}

export interface Env {
  dbType: DbType;
  dbUrl?: string;
  db: { host?: string; port?: number; username?: string; password?: string; database?: string; serviceName?: string };
  dbSsl: boolean;
  port: number;
  authMode: 'oidc' | 'dev';
  devJwtSecret?: string;
  allowDevAuth: boolean;
  oidc?: { issuer: string; audience: string; jwksUri: string; tenantClaim: string; rolesClaim: string; nameClaim: string };
  tokenTtlSeconds: number;
  corsOrigins: string[];
  rateLimit: { windowSeconds: number; max: number };
  migrateOnStart: boolean;
  /** Outbound connectors. Absent when the deployment has none configured (the tenant setting alone cannot enable one). */
  connectors: { coreBanking?: { url: string; apiKey: string; timeoutMs: number } };
}

export function loadEnv(): Env {
  const dbType = currentDbType();
  const authMode = required('AUTH_MODE') as Env['authMode'];
  if (authMode !== 'oidc' && authMode !== 'dev') throw new Error('AUTH_MODE must be "oidc" or "dev"');
  const allowDevAuth = process.env.ALLOW_DEV_AUTH === 'true';
  if (authMode === 'dev' && !allowDevAuth) {
    throw new Error('AUTH_MODE=dev requires ALLOW_DEV_AUTH=true. Development sign-in must be enabled explicitly and never in a bank deployment.');
  }
  const env: Env = {
    dbType,
    dbUrl: process.env.DATABASE_URL,
    db: {
      host: process.env.DB_HOST, port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
      username: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      serviceName: process.env.DB_SERVICE_NAME,
    },
    dbSsl: process.env.DB_SSL === 'true',
    port: requiredInt('PORT'),
    authMode,
    allowDevAuth,
    tokenTtlSeconds: requiredInt('TOKEN_TTL_SECONDS'),
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    rateLimit: { windowSeconds: requiredInt('RATE_LIMIT_WINDOW_SECONDS'), max: requiredInt('RATE_LIMIT_MAX') },
    migrateOnStart: process.env.MIGRATE_ON_START === 'true',
    connectors: loadConnectors(),
  };
  if (authMode === 'dev') {
    env.devJwtSecret = required('DEV_JWT_SECRET');
    if (env.devJwtSecret.length < 32) throw new Error('DEV_JWT_SECRET must be at least 32 characters');
  } else {
    env.oidc = {
      issuer: required('OIDC_ISSUER'), audience: required('OIDC_AUDIENCE'), jwksUri: required('OIDC_JWKS_URI'),
      tenantClaim: required('OIDC_TENANT_CLAIM'), rolesClaim: required('OIDC_ROLES_CLAIM'), nameClaim: required('OIDC_NAME_CLAIM'),
    };
  }
  return env;
}

/**
 * Core banking connector: its endpoint and credential belong to the deployment (the bank's network and secrets
 * store), never to tenant configuration — so a configuration change cannot point Creditum at another host.
 */
function loadConnectors(): Env['connectors'] {
  const url = process.env.CONNECTOR_CORE_BANKING_URL?.trim();
  if (!url) return {};
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('CONNECTOR_CORE_BANKING_URL must be an absolute URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('CONNECTOR_CORE_BANKING_URL must use http or https');
  const apiKey = required('CONNECTOR_CORE_BANKING_KEY');
  // guardrail-allow: minimum credential length, a security rule rather than a business value
  if (apiKey.length < 24) throw new Error('CONNECTOR_CORE_BANKING_KEY must be at least 24 characters');
  return { coreBanking: { url: url.replace(/\/+$/, ''), apiKey, timeoutMs: requiredInt('CONNECTOR_TIMEOUT_MS') } };
}

/** Database settings only — used by the migration / seed command line. */
export function loadDbEnv(): Pick<Env, 'dbType' | 'dbUrl' | 'db' | 'dbSsl'> {
  return {
    dbType: currentDbType(), dbUrl: process.env.DATABASE_URL, dbSsl: process.env.DB_SSL === 'true',
    db: { host: process.env.DB_HOST, port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined, username: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME, serviceName: process.env.DB_SERVICE_NAME },
  };
}
