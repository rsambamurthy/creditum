/**
 * Typed client for the Creditum API. Amounts are always decimal strings — they are never converted to
 * JavaScript numbers here or anywhere in the UI.
 */

const BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

/** An API failure: `status` is the HTTP status (0 = network failure), `code` the stable error code from the API. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  get isConflict() { return this.status === 409; }
  get isForbidden() { return this.status === 403; }
  /** Fields reported missing by a `required_fields` domain error. */
  get missingFields(): MissingField[] {
    if (this.code !== 'required_fields') return [];
    const d = this.details as { missing?: MissingField[] } | undefined;
    return Array.isArray(d?.missing) ? d!.missing : [];
  }
}

export interface MissingField { rule: string; field: string; message: string }

let token: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setToken(t: string | null) { token = t; }
export function setUnauthenticatedHandler(fn: (() => void) | null) { onUnauthenticated = fn; }

async function request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'The Creditum service could not be reached. Check your connection and try again.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = undefined; }
  }
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: unknown; details?: unknown };
    const message = Array.isArray(e.message) ? e.message.join('; ') : typeof e.message === 'string' ? e.message : `Request failed (${res.status})`;
    const err = new ApiError(res.status, e.error ?? 'error', message, e.details);
    if (res.status === 401 && opts.auth !== false && onUnauthenticated) onUnauthenticated();
    throw err;
  }
  return data as T;
}

// ---------------------------------------------------------------- types
export interface DevUser { loginName: string; displayName: string; roles: string[] }
export interface Me { userId: string; displayName: string; roles: string[]; tenant: { code: string; name?: string } }

export interface Currency { id: string; code: string; name: string; minorUnits: number; roundingMode: string; isBase: boolean; isActive: boolean }
export interface ValueListEntry { id: string; listKey: string; code: string; label: string; sortOrder: number; isActive: boolean }
export interface AuthorityLevel { id: string; levelCode: string; name: string; rankNo: number; maxAmount: string | null; approverRole: string }
export interface Parameter {
  id: string; paramKey: string; valueType: 'decimal' | 'integer' | 'text' | 'boolean' | 'currency'; paramValue: string;
  description: string | null; rowVersion: number; updatedBy: string; updatedAt: string;
}
export interface ConfigChange {
  id: string; targetType: string; targetRef: string; payload: string; status: 'pending' | 'applied' | 'rejected';
  makerId: string; checkerId: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null;
}
export type WriteResult = { status: 'applied' } | { status: 'pending'; changeId: string };

export interface CreditRequest {
  id: string; requestNumber: string; borrowerName: string; borrowerRef: string; requestType: string; status: string; statusLabel: string;
  requestedAmount: string; currencyCode: string; baseAmount: string; fxRateUsed: string; requiredLevel: string; makerId: string;
  rowVersion: number; createdAt: string; updatedAt: string;
}
export interface TransitionAction { action: string; label: string; remarksRequired: boolean }
export interface CreditRequestDetail extends CreditRequest {
  editable: boolean; fields: Record<string, unknown>; actions: TransitionAction[];
}
export interface RuleMessage { rule: string; message: string }
export interface Outcome {
  blocks: RuleMessage[]; warnings: RuleMessage[]; required: MissingField[]; hidden: string[]; fired: string[];
}
export interface SaveResult { request: CreditRequestDetail; warnings: RuleMessage[] }
export interface CreditRequestInput {
  borrowerName: string; borrowerRef: string; requestType: string; requestedAmount: string; currencyCode: string; fields?: Record<string, unknown>;
}
export interface WorkflowEvent {
  id: string; entityId: string; fromState: string; toState: string; actionCode: string; actorId: string; actorName: string;
  remarks: string | null; occurredAt: string;
}

export interface EffectiveField {
  fieldKey: string; libraryId: string; module: string; group: string; label: string; coreLabel: string; dataType: string; source: string;
  adapter: string | null; requirement: string; coreRequirement: string; hidden: boolean; helpText: string | null; origin: string;
  scope: 'core' | 'tenant'; configurable: string | null; reviewNotes: string | null; overrideVersion: number | null;
}
export interface FieldOverrideInput { labelOverride?: string; requirementOverride?: string; hidden?: boolean; helpText?: string; expectedVersion?: number }
export interface CustomFieldInput { label: string; module: string; group: string; dataType: string; requirement?: string; requirementBasis?: string }

export interface RuleRow {
  id: string; ownerScope: string; ruleKey: string; name: string; entityType: string; triggerOn: 'on_save' | 'on_submit';
  conditionJson: string; actionsJson: string; isActive: boolean; rowVersion: number; updatedBy: string; updatedAt: string; scope: 'core' | 'tenant';
}
export interface RuleInput {
  name: string; entityType?: string; triggerOn?: 'on_save' | 'on_submit'; condition: object; actions: unknown[]; isActive?: boolean; expectedVersion?: number;
}

export interface WfState { code: string; label: string; final?: boolean; editable?: boolean }
export interface WfTransition { action: string; label: string; from: string; to: string; roles: string[]; checker?: boolean; authority?: boolean; remarksRequired?: boolean }
export interface WfDefinition { initial: string; states: WfState[]; transitions: WfTransition[] }
export interface WorkflowRow { id: string; requestType: string; definitionJson: string; isActive: boolean; rowVersion: number; updatedBy: string; updatedAt: string }
export interface WorkflowDetail extends WorkflowRow { definition: WfDefinition }

export interface AuditEvent {
  id: string; seq: number | string; occurredAtUtc: string; occurredAt: string; actorId: string; actorName: string; action: string;
  entityType: string; entityRef: string; beforeData: string | null; afterData: string | null; clientIp: string | null; sessionRef: string | null;
  prevHash: string; hash: string;
}
export interface VerifyResult { valid: boolean; checked: number; brokenAtSeq?: number | string; reason?: string }

// ---------------------------------------------------------------- endpoints
const enc = encodeURIComponent;

export const api = {
  devUsers: (tenant: string) => request<DevUser[]>('GET', `/auth/dev-users?tenant=${enc(tenant)}`, undefined, { auth: false }),
  devLogin: (tenantCode: string, loginName: string) =>
    request<{ token: string; expiresIn: number }>('POST', '/auth/dev-login', { tenantCode, loginName }, { auth: false }),
  me: () => request<Me>('GET', '/auth/me'),

  listRequests: () => request<CreditRequest[]>('GET', '/credit-requests'),
  getRequest: (id: string) => request<CreditRequestDetail>('GET', `/credit-requests/${enc(id)}`),
  history: (id: string) => request<WorkflowEvent[]>('GET', `/credit-requests/${enc(id)}/history`),
  createRequest: (input: CreditRequestInput) => request<SaveResult>('POST', '/credit-requests', input),
  updateRequest: (id: string, expectedVersion: number, input: Partial<CreditRequestInput>) =>
    request<SaveResult>('PUT', `/credit-requests/${enc(id)}`, { expectedVersion, ...input }),
  transition: (id: string, action: string, expectedVersion: number, remarks?: string) =>
    request<CreditRequestDetail>('POST', `/credit-requests/${enc(id)}/transitions`, { action, expectedVersion, ...(remarks ? { remarks } : {}) }),

  fields: () => request<EffectiveField[]>('GET', '/fields'),
  overrideField: (key: string, body: FieldOverrideInput) => request<WriteResult>('PUT', `/fields/${enc(key)}/override`, body),
  customField: (key: string, body: CustomFieldInput) => request<WriteResult>('POST', `/fields/custom/${enc(key)}`, body),

  parameters: () => request<Parameter[]>('GET', '/config/parameters'),
  setParameter: (key: string, value: string, expectedVersion?: number) =>
    request<WriteResult>('PUT', `/config/parameters/${enc(key)}`, { value, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }),
  currencies: () => request<Currency[]>('GET', '/config/currencies'),
  valueListKeys: () => request<string[]>('GET', '/config/value-lists'),
  valueList: (key: string) => request<ValueListEntry[]>('GET', `/config/value-lists/${enc(key)}`),
  authorityLevels: () => request<AuthorityLevel[]>('GET', '/config/authority-levels'),
  pendingChanges: () => request<ConfigChange[]>('GET', '/config/changes'),
  decideChange: (id: string, approve: boolean, note?: string) =>
    request<{ status: string }>('POST', `/config/changes/${enc(id)}/decision`, { approve, ...(note ? { note } : {}) }),

  rules: () => request<RuleRow[]>('GET', '/rules'),
  saveRule: (key: string, body: RuleInput) => request<WriteResult>('PUT', `/rules/${enc(key)}`, body),
  testRule: (rule: unknown, record: Record<string, unknown>) => request<Outcome>('POST', '/rules/test', { rule, record }),

  workflows: () => request<WorkflowRow[]>('GET', '/workflows'),
  workflow: (requestType: string) => request<WorkflowDetail>('GET', `/workflows/${enc(requestType)}`),
  saveWorkflow: (requestType: string, definition: unknown, expectedVersion?: number) =>
    request<WriteResult>('PUT', `/workflows/${enc(requestType)}`, { definition, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }),

  audit: (pageSize: number, beforeSeq?: number | string) =>
    request<AuditEvent[]>('GET', `/audit?limit=${pageSize}${beforeSeq !== undefined ? `&beforeSeq=${enc(String(beforeSeq))}` : ''}`),
  verifyAudit: () => request<VerifyResult>('GET', '/audit/verify'),
};

/** Human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
