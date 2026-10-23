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
  /** Mandatory form fields reported by a `mandatory_fields` submission error. */
  get missingMandatory(): MissingEntry[] {
    if (this.code !== 'mandatory_fields') return [];
    const d = this.details as { missing?: MissingEntry[] } | undefined;
    return Array.isArray(d?.missing) ? d!.missing : [];
  }
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
  id: string; ownerScope: string; ruleKey: string; name: string; entityType: string; triggerOn: RuleTrigger;
  /** Where the rule runs: ["request"] and/or module codes (on_save), workflow action codes (on_action). */
  contexts?: string[] | null;
  conditionJson: string; actionsJson: string; isActive: boolean; rowVersion: number; updatedBy: string; updatedAt: string; scope: 'core' | 'tenant';
}
export type RuleTrigger = 'on_save' | 'on_submit' | 'on_action';
export interface RuleInput {
  name: string; entityType?: string; triggerOn?: RuleTrigger; scope?: string[]; condition: object; actions: unknown[]; isActive?: boolean; expectedVersion?: number;
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


// ---------------------------------------------------------------- Credit Request modules (Phase 2 contract: docs/api/credit-request-modules.md)
export type FormValue = string | boolean | null;
export type ValueKind = 'text' | 'decimal' | 'date' | 'bool' | 'composite' | 'none';
export interface CalcMeta { status: 'active' | 'pending'; description?: string; note?: string }
export interface FieldMeta {
  key: string; label: string; helpText?: string | null; dataType: string; valueKind: ValueKind; parts?: string[];
  source?: string; adapter?: string | null; requirement: string; list?: string; bind?: 'borrowerName' | 'borrowerRef';
  display?: 'chart' | 'table' | 'heading'; calc?: CalcMeta; readOnly?: boolean;
}
export interface SectionMeta {
  code: string; title: string; kind: 'record' | 'grid' | 'periods'; grid: string | null; rowLabel: string | null;
  fields: FieldMeta[]; columns?: FieldMeta[];
}
export interface ModuleMeta { code: string; letter: string; title: string; sections: SectionMeta[] }
export interface ListEntry { code: string; label: string }
export interface Layout {
  version: number; baseCurrency: string; currencies: { code: string; minorUnits: number }[];
  grids: Record<string, GridMeta>; lists: Record<string, ListEntry[]>; modules: ModuleMeta[];
  /** Tenant display rounding of calculated values (number of decimal places — display only, never stored). */
  display?: DisplayPlaces;
  /** Record-level fields shown on the New Credit Request form besides the header (tenant-configurable). */
  createForm?: FieldMeta[];
}
export interface GridMeta { rowLabel: string; ordered: boolean; /** Field whose value names a row (e.g. the period's statement date). */ labelField?: string }
export interface DisplayPlaces {
  percentagePlaces: number;
  // guardrail-allow: a count of decimal places for display, not a ratio value
  ratioPlaces: number;
}
export interface GridRowData { rowKey?: string; values: Record<string, FormValue> }
export interface MissingEntry { key: string; label: string; module: string; section: string; sectionTitle?: string; rowKey: string | null }
export interface Completeness {
  mode: 'off' | 'warn' | 'block';
  modules: Record<string, { mandatory: number; filled: number }>;
  missing: MissingEntry[];
}
export interface RequestData {
  requestId: string; rowVersion: number; editable: boolean;
  record: Record<string, FormValue>; grids: Record<string, GridRowData[]>; completeness: Completeness; warnings?: string[];
}
export interface RequestDataInput {
  expectedVersion: number; record?: Record<string, FormValue>; grids?: Record<string, GridRowData[]>;
}


// ---------------------------------------------------------------- Administration (value lists, formulas, screen layout)
export interface ValueListAdminEntry { id: string; code: string; label: string; sortOrder: number; isActive: boolean }
export interface ValueListInputEntry { code: string; label: string; active?: boolean }
export type FormulaExpr = { [op: string]: unknown };
export interface FormulaRow {
  fieldKey: string; label: string; scope: 'core' | 'tenant'; status: 'active' | 'pending'; expression: FormulaExpr | null;
  description: string | null; note: string | null; grid: string | null; rowVersion: number;
  /** Spreadsheet-style text of the expression (null when the formula has none). */
  text?: string | null;
}
export interface FormulaInput { status?: 'active' | 'pending'; expression?: FormulaExpr | null; text?: string; description: string; note?: string; expectedVersion?: number }
export interface FormulaParse { expression: FormulaExpr; text: string }
export type FormulaPreview = { value: string | null } | { rows: { rowKey: string; label: string; value: string | null }[] };
// ---- rule builder catalog
export interface CatalogField {
  key: string; label: string; dataType: string; valueKind: 'text' | 'decimal' | 'date' | 'bool'; group: string; section: string; hidden: boolean; list?: string;
  /** Module code, or "request" for the request header. */ module?: string; onCreateForm?: boolean;
}
export interface CatalogParameter { key: string; valueType: string; value: string; description: string | null }
export interface RuleCatalog {
  fields: CatalogField[]; parameters: CatalogParameter[]; lists: Record<string, ListEntry[]>; currencies: { code: string; name: string }[];
  contexts?: { modules: { code: string; title: string }[]; createFields: string[]; actions: { code: string; label: string }[] };
}
/** Layout document as stored. Unknown properties are preserved untouched when the document is sent back. */
export interface LayoutDocField { key: string; [prop: string]: unknown }
export interface LayoutDocSection { code: string; title: string; kind: 'record' | 'grid' | 'periods'; grid?: string; rowLabel?: string; fields: LayoutDocField[]; columns?: LayoutDocField[]; [prop: string]: unknown }
export interface LayoutDocModule { code: string; letter: string; title: string; sections: LayoutDocSection[]; [prop: string]: unknown }
export interface LayoutDocument { modules: LayoutDocModule[]; createFields?: string[]; [prop: string]: unknown }
export interface LayoutAdminField { label: string; dataType: string; requirement: string; hidden: boolean; scope: 'core' | 'tenant'; calculated: boolean }
export interface LayoutAdmin { scope: 'core' | 'tenant'; coreVersion: number; updatedAt: string; document: LayoutDocument; fields: Record<string, LayoutAdminField> }

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
    request<CreditRequestDetail & { warnings?: string[] }>('POST', `/credit-requests/${enc(id)}/transitions`, { action, expectedVersion, ...(remarks ? { remarks } : {}) }),

  layout: () => request<Layout>('GET', '/layout'),
  requestData: (id: string) => request<RequestData>('GET', `/credit-requests/${enc(id)}/data`),
  saveRequestData: (id: string, body: RequestDataInput) => request<RequestData>('PUT', `/credit-requests/${enc(id)}/data`, body),

  fields: () => request<EffectiveField[]>('GET', '/fields'),
  overrideField: (key: string, body: FieldOverrideInput) => request<WriteResult>('PUT', `/fields/${enc(key)}/override`, body),
  customField: (key: string, body: CustomFieldInput) => request<WriteResult>('POST', `/fields/custom/${enc(key)}`, body),

  parameters: () => request<Parameter[]>('GET', '/config/parameters'),
  setParameter: (key: string, value: string, expectedVersion?: number) =>
    request<WriteResult>('PUT', `/config/parameters/${enc(key)}`, { value, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }),
  currencies: () => request<Currency[]>('GET', '/config/currencies'),
  valueListKeys: () => request<string[]>('GET', '/config/value-lists'),
  valueList: (key: string) => request<ValueListEntry[]>('GET', `/config/value-lists/${enc(key)}`),
  valueListEntries: (key: string) => request<ValueListAdminEntry[]>('GET', `/config/value-lists/${enc(key)}/entries`),
  saveValueList: (key: string, entries: ValueListInputEntry[]) => request<WriteResult>('PUT', `/config/value-lists/${enc(key)}`, { entries }),

  formulas: () => request<FormulaRow[]>('GET', '/formulas'),
  formulaFunctions: () => request<string[]>('GET', '/formulas/functions'),
  parseFormula: (key: string, text: string) => request<FormulaParse>('POST', `/formulas/${enc(key)}/parse`, { text }),
  previewFormula: (key: string, text: string, requestId: string) => request<FormulaPreview>('POST', `/formulas/${enc(key)}/preview`, { text, requestId }),
  saveFormula: (key: string, body: FormulaInput) => request<WriteResult>('PUT', `/formulas/${enc(key)}`, body),
  revertFormula: (key: string) => request<WriteResult>('DELETE', `/formulas/${enc(key)}`),
  checkFormula: (key: string, expression: FormulaExpr | null, status?: 'active' | 'pending') =>
    request<{ valid: true }>('POST', `/formulas/${enc(key)}/check`, { expression, ...(status ? { status } : {}) }),

  layoutAdmin: () => request<LayoutAdmin>('GET', '/layout/admin'),
  saveLayout: (document: LayoutDocument) => request<WriteResult>('PUT', '/layout', { document }),
  resetLayout: () => request<WriteResult>('PUT', '/layout', { reset: true }),
  authorityLevels: () => request<AuthorityLevel[]>('GET', '/config/authority-levels'),
  pendingChanges: () => request<ConfigChange[]>('GET', '/config/changes'),
  decideChange: (id: string, approve: boolean, note?: string) =>
    request<{ status: string }>('POST', `/config/changes/${enc(id)}/decision`, { approve, ...(note ? { note } : {}) }),

  rules: () => request<RuleRow[]>('GET', '/rules'),
  rulesCatalog: () => request<RuleCatalog>('GET', '/rules/catalog'),
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
