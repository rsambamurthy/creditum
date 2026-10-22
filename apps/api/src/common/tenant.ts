import { randomUUID } from 'node:crypto';
import { FindOptionsWhere } from 'typeorm';
import { requireTenant } from './request-context';
import { CORE_SCOPE } from './db-types';

/**
 * Every query on a tenant-owned table goes through tenantWhere(), which injects the tenant from
 * the request context. The guardrail check (tools/guardrails) rejects repository reads and writes
 * that do not, and integration tests attempt cross-tenant access (SDD Section 25.4).
 */
export function tenantWhere<T extends { tenantId: string }>(where: Omit<FindOptionsWhere<T>, 'tenantId'> = {} as Omit<FindOptionsWhere<T>, 'tenantId'>): FindOptionsWhere<T> {
  return { ...(where as object), tenantId: requireTenant() } as FindOptionsWhere<T>;
}

/** Scopes visible to the current tenant for shared-library tables: the core library and the tenant's own rows. */
export function visibleScopes(): string[] {
  return [CORE_SCOPE, requireTenant()];
}

export function newId(): string {
  return randomUUID();
}
