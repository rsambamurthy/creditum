/**
 * Workflow engine (SDD Section 19.3): a per-tenant, per-Request-Type state machine read from data.
 *
 * Definition shape:
 * {
 *   "initial": "draft",
 *   "states": [{"code":"draft","label":"Draft"}, ..., {"code":"approved","label":"Approved","final":true}],
 *   "transitions": [
 *     {"action":"submit","label":"Submit","from":"draft","to":"credit_review","roles":["relationship_officer"]},
 *     {"action":"approve","label":"Approve","from":"committee","to":"approved","roles":["committee_member"],
 *      "checker": true, "authority": true}
 *   ]
 * }
 * "checker": the actor must not be the maker of the request (segregation of duties).
 * "authority": the actor must hold the approver role of the required delegated-authority level or a higher one.
 */
import { DomainError, ForbiddenError } from '../../common/errors';

export interface WfState { code: string; label: string; final?: boolean; editable?: boolean }
export interface WfTransition { action: string; label: string; from: string; to: string; roles: string[]; checker?: boolean; authority?: boolean; remarksRequired?: boolean }
export interface WfDefinition { initial: string; states: WfState[]; transitions: WfTransition[] }

export function validateDefinition(def: WfDefinition): void {
  if (!def || !Array.isArray(def.states) || !Array.isArray(def.transitions)) throw new DomainError('invalid_workflow', 'Workflow needs states and transitions');
  const codes = new Set<string>();
  for (const s of def.states) {
    if (!s.code || !s.label) throw new DomainError('invalid_workflow', 'Every state needs a code and a label — no undefined stage codes');
    if (codes.has(s.code)) throw new DomainError('invalid_workflow', `Duplicate state "${s.code}"`);
    codes.add(s.code);
  }
  if (!codes.has(def.initial)) throw new DomainError('invalid_workflow', `Initial state "${def.initial}" is not defined`);
  const seen = new Set<string>();
  for (const t of def.transitions) {
    if (!codes.has(t.from) || !codes.has(t.to)) throw new DomainError('invalid_workflow', `Transition "${t.action}" refers to an undefined state`);
    if (!t.label || !Array.isArray(t.roles) || t.roles.length === 0) throw new DomainError('invalid_workflow', `Transition "${t.action}" needs a label and at least one role`);
    const k = `${t.from}|${t.action}`;
    if (seen.has(k)) throw new DomainError('invalid_workflow', `Action "${t.action}" is defined twice from state "${t.from}"`);
    seen.add(k);
  }
  const reachable = new Set([def.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of def.transitions) if (reachable.has(t.from) && !reachable.has(t.to)) { reachable.add(t.to); grew = true; }
  }
  const unreachable = [...codes].filter(c => !reachable.has(c));
  if (unreachable.length) throw new DomainError('invalid_workflow', `Unreachable states: ${unreachable.join(', ')}`);
}

export interface TransitionContext {
  actorId: string; actorRoles: string[]; makerId: string;
  /** Approver roles allowed for the request's required authority level: that level's role and all higher-ranked levels' roles. */
  authorityRoles: string[];
}

export function availableTransitions(def: WfDefinition, state: string, ctx: TransitionContext): WfTransition[] {
  return def.transitions.filter(t => t.from === state && check(t, ctx) === null);
}

function check(t: WfTransition, ctx: TransitionContext): string | null {
  if (!t.roles.some(r => ctx.actorRoles.includes(r))) return `Your role cannot perform "${t.label}"`;
  if (t.checker && ctx.actorId === ctx.makerId) return `The maker of a request cannot perform "${t.label}" (segregation of duties)`;
  if (t.authority && !ctx.authorityRoles.some(r => ctx.actorRoles.includes(r))) return `"${t.label}" needs a higher delegated authority level`;
  return null;
}

export function resolveTransition(def: WfDefinition, state: string, action: string, ctx: TransitionContext, remarks?: string): WfTransition {
  const t = def.transitions.find(x => x.from === state && x.action === action);
  if (!t) throw new DomainError('invalid_transition', `Action "${action}" is not available from state "${state}"`);
  const reason = check(t, ctx);
  if (reason) throw new ForbiddenError(reason);
  if (t.remarksRequired && !(remarks && remarks.trim())) throw new DomainError('remarks_required', `"${t.label}" requires remarks`);
  return t;
}
