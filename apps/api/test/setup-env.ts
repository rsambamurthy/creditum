// Test defaults for operational settings (the application itself has none). Real values come from CI / .env.
const defaults: Record<string, string> = {
  DB_TYPE: 'postgres', AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true', DEV_JWT_SECRET: 'test-only-secret-not-for-any-deployment-000000',
  PORT: '0', TOKEN_TTL_SECONDS: '3600', RATE_LIMIT_WINDOW_SECONDS: '60', RATE_LIMIT_MAX: '100000', CORS_ORIGINS: 'http://localhost:5173',
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
