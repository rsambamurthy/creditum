/**
 * Rule builder model: converts between the stored rule language (var / cfg / and / or / not / comparisons / in / empty)
 * and an editable tree of groups and conditions. Pure functions; a stored shape the builder cannot show returns null so
 * the screen can fall back to the advanced (JSON) editor without losing anything.
 */
import type { CatalogField, CatalogParameter, ListEntry } from '../api';
import { formatDecimal } from '../format';

export type Op = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'in' | 'empty' | 'notempty' | 'yes' | 'no';
export type Operand = { kind: 'value'; value: string } | { kind: 'values'; values: string[] } | { kind: 'setting'; key: string };
export interface CondNode { type: 'cond'; id: string; field: string; op: Op; operand: Operand }
export interface GroupNode { type: 'group'; id: string; mode: 'all' | 'any'; not: boolean; items: RuleNode[] }
export type RuleNode = CondNode | GroupNode;
export type ActionType = 'block' | 'warn' | 'require' | 'hide';
export interface ActionNode { id: string; type: ActionType; field?: string; message?: string }

let seq = 0;
export const nid = () => `n${Date.now().toString(36)}${++seq}`;

export const DECIMAL = /^-?\d+(\.\d+)?$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FieldKind = 'decimal' | 'text' | 'list' | 'bool' | 'date';
export function kindOf(f: CatalogField | undefined): FieldKind {
  if (!f) return 'text';
  if (f.valueKind === 'bool') return 'bool';
  if (f.valueKind === 'date') return 'date';
  if (f.valueKind === 'decimal') return 'decimal';
  return f.list ? 'list' : 'text';
}

const OPS: Record<FieldKind, [Op, string][]> = {
  decimal: [['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['eq', 'equals'], ['ne', 'is not'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  text: [['eq', 'equals'], ['ne', 'is not'], ['in', 'is one of'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  list: [['eq', 'is'], ['ne', 'is not'], ['in', 'is one of'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  bool: [['yes', 'is Yes'], ['no', 'is No'], ['empty', 'is empty']],
  date: [['lt', 'is before'], ['lte', 'is on or before'], ['gt', 'is after'], ['gte', 'is on or after'], ['eq', 'is on'], ['empty', 'is empty'], ['notempty', 'is not empty']],
};
export const opsFor = (k: FieldKind) => OPS[k];
export const opLabel = (k: FieldKind, op: Op) => OPS[k].find(o => o[0] === op)?.[1] ?? op;
export const needsValue = (op: Op) => !['empty', 'notempty', 'yes', 'no'].includes(op);

export function defaultOperand(op: Op): Operand {
  return op === 'in' ? { kind: 'values', values: [] } : { kind: 'value', value: '' };
}
export function newCondition(field = ''): CondNode { return { type: 'cond', id: nid(), field, op: 'eq', operand: { kind: 'value', value: '' } }; }
export function newGroup(mode: 'all' | 'any' = 'all'): GroupNode { return { type: 'group', id: nid(), mode, not: false, items: [] }; }

// ---------------------------------------------------------------- serialise (builder -> stored)
const CMP: Partial<Record<Op, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', ne: '!=' };

function serNode(n: RuleNode): unknown {
  if (n.type === 'group') {
    const core = { [n.mode === 'all' ? 'and' : 'or']: n.items.map(serNode) };
    return n.not ? { not: core } : core;
  }
  const v = { var: n.field };
  if (n.op === 'empty') return { empty: v };
  if (n.op === 'notempty') return { not: { empty: v } };
  if (n.op === 'yes') return { '==': [v, true] };
  if (n.op === 'no') return { '==': [v, false] };
  if (n.op === 'in') return { in: [v, n.operand.kind === 'values' ? n.operand.values : []] };
  const rhs = n.operand.kind === 'setting' ? { cfg: n.operand.key } : n.operand.kind === 'value' ? n.operand.value.trim() : '';
  return { [CMP[n.op]!]: [v, rhs] };
}

/** The stored condition. A top-level "All of these" group with one condition is stored as that condition alone. */
export function serialiseCondition(root: GroupNode): unknown {
  if (root.items.length === 1 && !root.not && root.mode === 'all') return serNode(root.items[0]);
  return serNode(root);
}

export function serialiseActions(actions: ActionNode[]): { type: ActionType; field?: string; message?: string }[] {
  return actions.map(a => ({ type: a.type, ...(a.type === 'require' || a.type === 'hide' ? { field: a.field } : {}),
    ...(a.type !== 'hide' && a.message?.trim() ? { message: a.message.trim() } : {}) }));
}

// ---------------------------------------------------------------- parse (stored -> builder)
const REV: Record<string, Op> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '==': 'eq', '!=': 'ne' };
const isVar = (x: unknown): x is { var: string } => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 1 && typeof (x as { var?: unknown }).var === 'string';
const prim = (x: unknown) => typeof x === 'string' || typeof x === 'number';

function parseNode(c: unknown): RuleNode | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const keys = Object.keys(c);
  if (keys.length !== 1) return null;
  const op = keys[0];
  const a = (c as Record<string, unknown>)[op];
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(a)) return null;
    const items = a.map(parseNode);
    if (items.some(i => i === null)) return null;
    return { type: 'group', id: nid(), mode: op === 'and' ? 'all' : 'any', not: false, items: items as RuleNode[] };
  }
  if (op === 'not') {
    if (a && typeof a === 'object' && !Array.isArray(a) && 'empty' in a && isVar((a as { empty: unknown }).empty)) {
      return { type: 'cond', id: nid(), field: (a as { empty: { var: string } }).empty.var, op: 'notempty', operand: { kind: 'value', value: '' } };
    }
    const inner = parseNode(a);
    if (!inner) return null;
    if (inner.type === 'group' && !inner.not) return { ...inner, not: true };
    return { type: 'group', id: nid(), mode: 'all', not: true, items: [inner] };
  }
  if (op === 'empty') return isVar(a) ? { type: 'cond', id: nid(), field: a.var, op: 'empty', operand: { kind: 'value', value: '' } } : null;
  if (op === 'in') {
    if (!Array.isArray(a) || a.length !== 2 || !isVar(a[0]) || !Array.isArray(a[1]) || !a[1].every(prim)) return null;
    return { type: 'cond', id: nid(), field: a[0].var, op: 'in', operand: { kind: 'values', values: (a[1] as (string | number)[]).map(String) } };
  }
  if (op in REV) {
    if (!Array.isArray(a) || a.length !== 2 || !isVar(a[0])) return null;
    const [lhs, rhs] = a as [{ var: string }, unknown];
    if (op === '==' && typeof rhs === 'boolean') return { type: 'cond', id: nid(), field: lhs.var, op: rhs ? 'yes' : 'no', operand: { kind: 'value', value: '' } };
    if (rhs && typeof rhs === 'object' && !Array.isArray(rhs) && Object.keys(rhs).length === 1 && typeof (rhs as { cfg?: unknown }).cfg === 'string') {
      return { type: 'cond', id: nid(), field: lhs.var, op: REV[op], operand: { kind: 'setting', key: (rhs as { cfg: string }).cfg } };
    }
    if (prim(rhs)) return { type: 'cond', id: nid(), field: lhs.var, op: REV[op], operand: { kind: 'value', value: String(rhs) } };
    return null;
  }
  return null;
}

/** Builder tree for a stored condition, or null when it uses a shape the builder cannot show. */
export function parseCondition(c: unknown): GroupNode | null {
  const n = parseNode(c);
  if (!n) return null;
  return n.type === 'group' ? n : { type: 'group', id: nid(), mode: 'all', not: false, items: [n] };
}

export function parseActions(raw: unknown): ActionNode[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ActionNode[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || !['block', 'warn', 'require', 'hide'].includes((a as { type?: string }).type ?? '')) return null;
    const x = a as { type: ActionType; field?: string; message?: string };
    out.push({ id: nid(), type: x.type, field: x.field, message: x.message });
  }
  return out;
}

// ---------------------------------------------------------------- validation and plain-English summary
export interface Names {
  field: (key: string) => CatalogField | undefined;
  param: (key: string) => CatalogParameter | undefined;
  list: (key: string) => ListEntry[] | undefined;
}

export function conditionProblems(n: RuleNode, names: Names, out: Map<string, string> = new Map()): Map<string, string> {
  if (n.type === 'group') {
    if (!n.items.length) out.set(n.id, 'Add at least one condition to this group');
    n.items.forEach(i => conditionProblems(i, names, out));
    return out;
  }
  const f = names.field(n.field);
  if (!n.field) { out.set(n.id, 'Choose a field'); return out; }
  if (!needsValue(n.op)) return out;
  const k = kindOf(f);
  if (n.operand.kind === 'setting') { if (!n.operand.key) out.set(n.id, 'Choose a setting'); return out; }
  if (n.operand.kind === 'values') { if (!n.operand.values.length) out.set(n.id, 'Choose at least one value'); return out; }
  const v = n.operand.value.trim();
  if (!v) out.set(n.id, 'Enter a value');
  else if (k === 'decimal' && !DECIMAL.test(v)) out.set(n.id, 'Enter a number (digits and an optional decimal point)');
  else if (k === 'date' && !DATE.test(v)) out.set(n.id, 'Enter a date');
  return out;
}

export function actionProblems(actions: ActionNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of actions) {
    if ((a.type === 'require' || a.type === 'hide') && !a.field) out.set(a.id, 'Choose the field');
    else if ((a.type === 'block' || a.type === 'warn') && !a.message?.trim()) out.set(a.id, 'Write the message the user will see');
  }
  return out;
}

function valueText(n: CondNode, names: Names): string {
  const f = names.field(n.field);
  if (n.operand.kind === 'setting') {
    const p = names.param(n.operand.key);
    const shown = p ? (DECIMAL.test(p.value) ? formatDecimal(p.value) : p.value) : '?';
    return `the setting ‘${p?.description ?? n.operand.key}’ (${shown})`;
  }
  const label = (code: string) => (f?.list ? names.list(f.list)?.find(e => e.code === code)?.label ?? code : code);
  if (n.operand.kind === 'values') return n.operand.values.map(label).join(', ') || '…';
  const v = n.operand.value.trim();
  if (!v) return '…';
  return kindOf(f) === 'decimal' && DECIMAL.test(v) ? formatDecimal(v) : label(v);
}

function sumNode(n: RuleNode, names: Names, nested: boolean): string {
  if (n.type === 'group') {
    const inner = n.items.map(i => sumNode(i, names, true)).join(n.mode === 'all' ? ' and ' : ' or ') || '…';
    const wrapped = nested && n.items.length > 1 ? `(${inner})` : inner;
    return n.not ? `not (${inner})` : wrapped;
  }
  const f = names.field(n.field);
  const label = f?.label ?? (n.field || '…');
  return needsValue(n.op) ? `${label} ${opLabel(kindOf(f), n.op)} ${valueText(n, names)}` : `${label} ${opLabel(kindOf(f), n.op)}`;
}

export function summarise(root: GroupNode, actions: ActionNode[], names: Names, context?: string): string {
  const when = sumNode(root, names, false);
  const then = actions.map(a => {
    const fl = a.field ? names.field(a.field)?.label ?? a.field : '…';
    const msg = a.message?.trim() ? `: “${a.message.trim()}”` : '';
    return a.type === 'require' ? `require ${fl}${msg}` : a.type === 'hide' ? `hide ${fl}` : a.type === 'block' ? `block saving${msg}` : `warn${msg}`;
  }).join('; ');
  return context ? `${context}: if ${when} → ${then || '…'}` : `When ${when} → ${then || '…'}`;
}

// ---------------------------------------------------------------- rule context (where a rule runs)
export type Trigger = 'on_save' | 'on_submit' | 'on_action';
/** Where a rule runs: the New Credit Request form and/or module tabs being saved, submission, or workflow actions. */
export interface RuleContext { trigger: Trigger; form: boolean; modules: string[]; actions: string[] }

export function contextFromRule(trigger: Trigger, contexts: string[] | null | undefined): RuleContext {
  const list = contexts ?? [];
  if (trigger === 'on_save') {
    const form = list.length === 0 || list.includes('request');
    return { trigger, form, modules: list.filter(c => c !== 'request'), actions: [] };
  }
  return { trigger, form: false, modules: [], actions: trigger === 'on_action' ? list : [] };
}

export function contextScope(c: RuleContext): string[] | undefined {
  if (c.trigger === 'on_save') return [...(c.form ? ['request'] : []), ...c.modules];
  if (c.trigger === 'on_action') return c.actions;
  return undefined;
}

export function contextProblem(c: RuleContext): string | null {
  if (c.trigger === 'on_save' && !c.form && c.modules.length === 0) return 'Choose the form or at least one module the rule checks when saved';
  if (c.trigger === 'on_action' && c.actions.length === 0) return 'Choose at least one workflow action';
  return null;
}

export interface ContextNames { module: (code: string) => string; action: (code: string) => string }

function orList(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

/** "When Borrower Profile is saved", "When the request is submitted", "When Approve is taken". */
export function contextPhrase(c: RuleContext, n: ContextNames): string {
  if (c.trigger === 'on_submit') return 'When the request is submitted';
  if (c.trigger === 'on_action') return `When ${orList(c.actions.map(n.action)) || '…'} is taken`;
  const parts = [...(c.form ? ['the New Credit Request form'] : []), ...c.modules.map(n.module)];
  return `When ${orList(parts) || '…'} is saved`;
}

/**
 * Why a field cannot be used here, or null when it can. Conditions of a form-only rule may read the header and the
 * form's fields; Require / Hide actions of a save rule must name a field on the screen being saved.
 */
export function fieldUnavailable(f: CatalogField | undefined, c: RuleContext, purpose: 'condition' | 'action', n: ContextNames): string | null {
  if (!f || c.trigger !== 'on_save') return null;
  const onForm = f.module === 'request' || !!f.onCreateForm;
  if (purpose === 'condition') {
    if (c.form && c.modules.length === 0 && !onForm) return 'Not on the New Credit Request form';
    return null;
  }
  if (c.form && f.onCreateForm) return null;
  if (f.module && c.modules.includes(f.module)) return null;
  if (c.modules.length === 0) return 'Not on the New Credit Request form';
  return `Not on the ${orList(c.modules.map(n.module))} tab${c.form ? ' or the New Credit Request form' : ''}`;
}

/** Field keys a condition reads (for the test panel). */
export function usedFields(n: RuleNode, out: string[] = []): string[] {
  if (n.type === 'group') n.items.forEach(i => usedFields(i, out));
  else if (n.field && !out.includes(n.field)) out.push(n.field);
  return out;
}
