/**
 * Per-request context (tenant, actor, client address) carried through async calls.
 * Tenant scope is taken from here centrally, never passed around by hand (SDD Section 26.3).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenError } from './errors';

export interface Actor {
  userId: string;
  displayName: string;
  roles: string[];
}

export interface RequestContext {
  tenantId?: string;
  tenantCode?: string;
  actor?: Actor;
  ip?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function context(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No request context');
  return ctx;
}

export function requireTenant(): string {
  const id = storage.getStore()?.tenantId;
  if (!id) throw new ForbiddenError('No tenant in scope');
  return id;
}

export function requireActor(): Actor {
  const a = storage.getStore()?.actor;
  if (!a) throw new ForbiddenError('No authenticated user in scope');
  return a;
}
