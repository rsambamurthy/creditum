import { DataSource, DataSourceOptions } from 'typeorm';
import { Env } from '../config/env';
import { Tenant, AppUser } from '../modules/tenancy/tenancy.entities';
import { AuditEvent, AuditChainHead } from '../modules/audit/audit.entities';
import { TenantCurrency, FxRate, ConfigParameter, ValueListEntry, AuthorityLevel, ConfigChange, SequenceCounter } from '../modules/configuration/configuration.entities';
import { FieldDefinition, TenantFieldOverride, FieldValue } from '../modules/field-registry/field-registry.entities';
import { RuleDefinition } from '../modules/rules/rules.entities';
import { WorkflowDefinition, WorkflowEvent } from '../modules/workflow/workflow.entities';
import { CreditRequest } from '../modules/credit-request/credit-request.entities';
import { Foundation1761100000000 } from './migrations/1761100000000-Foundation';
import { CreditRequestModules1761200000000 } from './migrations/1761200000000-CreditRequestModules';
import { FieldFormula, FormLayout, FormRow } from '../modules/forms/forms.entities';
import { applyExactDecimalReads } from './exact-decimals';

export const ENTITIES = [Tenant, AppUser, AuditEvent, AuditChainHead, TenantCurrency, FxRate, ConfigParameter, ValueListEntry, AuthorityLevel,
  ConfigChange, SequenceCounter, FieldDefinition, TenantFieldOverride, FieldValue, RuleDefinition, WorkflowDefinition, WorkflowEvent, CreditRequest,
  FormRow, FormLayout, FieldFormula];
export const MIGRATIONS = [Foundation1761100000000, CreditRequestModules1761200000000];

export function dataSourceOptions(env: Pick<Env, 'dbType' | 'dbUrl' | 'db' | 'dbSsl'>): DataSourceOptions {
  const common = { entities: ENTITIES, migrations: MIGRATIONS, synchronize: false, logging: false as const, migrationsTransactionMode: 'each' as const };
  switch (env.dbType) {
    case 'postgres':
      return { type: 'postgres', url: env.dbUrl, host: env.db.host, port: env.db.port, username: env.db.username, password: env.db.password,
        database: env.db.database, ssl: env.dbSsl ? { rejectUnauthorized: true } : false, ...common };
    case 'mssql':
      return { type: 'mssql', url: env.dbUrl, host: env.db.host, port: env.db.port, username: env.db.username, password: env.db.password,
        database: env.db.database, options: { encrypt: env.dbSsl, trustServerCertificate: !env.dbSsl, useUTC: true }, ...common };
    case 'oracle': {
      return { type: 'oracle', host: env.db.host, port: env.db.port, username: env.db.username, password: env.db.password,
        serviceName: env.db.serviceName, connectString: env.dbUrl, ...common };
    }
  }
}

export function createDataSource(env: Pick<Env, 'dbType' | 'dbUrl' | 'db' | 'dbSsl'>): DataSource {
  applyExactDecimalReads(env.dbType); // SQL Server and Oracle drivers would otherwise read DECIMAL as floating point
  return new DataSource(dataSourceOptions(env));
}
