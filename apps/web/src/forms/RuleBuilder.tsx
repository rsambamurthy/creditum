/**
 * Visual rule builder: "When" (groups of conditions, nestable, All/Any/Not) and "Then" (actions).
 * Works on the tree from ruleModel.ts; never shows JSON.
 */
import { useMemo } from 'react';
import type { CatalogField, RuleCatalog } from '../api';
import { formatDecimal } from '../format';
import { Combobox, type ComboOption } from '../components/Combobox';
import {
  defaultOperand, kindOf, needsValue, newCondition, newGroup, opsFor, DECIMAL,
  type ActionNode, type ActionType, type CondNode, type GroupNode, type RuleNode, nid,
} from './ruleModel';

export interface BuilderCtx {
  catalog: RuleCatalog;
  field: (key: string) => CatalogField | undefined;
  fieldOptions: ComboOption[];
  disabled: boolean;
  problems: Map<string, string>;
}

export function useFieldOptions(catalog: RuleCatalog | undefined, filter?: (f: CatalogField) => boolean): ComboOption[] {
  return useMemo(() => (catalog?.fields ?? []).filter(f => !filter || filter(f)).map(f => ({
    value: f.key, label: f.label, group: f.group === f.section ? f.group : `${f.group} › ${f.section}`,
    hint: f.hidden ? `${f.dataType} · hidden on screens` : f.dataType,
    badge: f.hidden ? <span className="badge badge-neutral sm">Hidden</span> : undefined,
  })), [catalog, filter]); // eslint-disable-line react-hooks/exhaustive-deps
}

function move<T>(xs: T[], i: number, d: number): T[] {
  const j = i + d; if (j < 0 || j >= xs.length) return xs;
  const out = [...xs]; [out[i], out[j]] = [out[j], out[i]]; return out;
}

/** Settings that can stand in for a value of this kind of field. */
function settingsFor(catalog: RuleCatalog, kind: string) {
  return catalog.parameters.filter(p => (kind === 'decimal' ? p.valueType === 'decimal' || p.valueType === 'integer' : kind === 'text' ? p.valueType === 'text' : false));
}

function ValueEditor({ cond, ctx, onChange }: { cond: CondNode; ctx: BuilderCtx; onChange: (c: CondNode) => void }) {
  const f = ctx.field(cond.field);
  const kind = kindOf(f);
  if (!needsValue(cond.op)) return null;
  const settings = settingsFor(ctx.catalog, kind);
  const list = f?.list ? ctx.catalog.lists[f.list] ?? [] : [];
  const label = `Value for ${f?.label ?? 'the condition'}`;

  if (cond.operand.kind === 'values') {
    const values = cond.operand.values;
    if (kind === 'list') {
      return (
        <fieldset className="multi-pick" disabled={ctx.disabled}>
          <legend className="sr-only">{label}</legend>
          {list.map(e => (
            <label key={e.code} className="checkbox chip-check">
              <input type="checkbox" checked={values.includes(e.code)}
                onChange={ev => onChange({ ...cond, operand: { kind: 'values', values: ev.target.checked ? [...values, e.code] : values.filter(v => v !== e.code) } })} />
              {e.label}
            </label>
          ))}
          {list.length === 0 && <span className="muted small">This list has no entries.</span>}
        </fieldset>
      );
    }
    return <input aria-label={`${label} (separate with commas)`} placeholder="value 1, value 2" disabled={ctx.disabled} value={values.join(', ')}
      onChange={e => onChange({ ...cond, operand: { kind: 'values', values: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} />;
  }

  const useSetting = cond.operand.kind === 'setting';
  const toggle = settings.length > 0 && (
    <label className="checkbox setting-toggle">
      <input type="checkbox" checked={useSetting} disabled={ctx.disabled}
        onChange={e => onChange({ ...cond, operand: e.target.checked ? { kind: 'setting', key: '' } : { kind: 'value', value: '' } })} />
      Use a setting
    </label>
  );

  if (cond.operand.kind === 'setting') {
    const key = cond.operand.key;
    const p = ctx.catalog.parameters.find(x => x.key === key);
    return (
      <div className="value-cell">
        <select aria-label={`Setting for ${f?.label ?? 'the condition'}`} value={key} disabled={ctx.disabled}
          onChange={e => onChange({ ...cond, operand: { kind: 'setting', key: e.target.value } })}>
          <option value="">Choose a setting…</option>
          {settings.map(s => <option key={s.key} value={s.key}>{s.description ?? s.key}</option>)}
          {key && !settings.some(s => s.key === key) && <option value={key}>{key}</option>}
        </select>
        {p && <span className="field-help">Currently <strong>{DECIMAL.test(p.value) ? formatDecimal(p.value) : p.value}</strong> · <span className="mono">{p.key}</span></span>}
        {toggle}
      </div>
    );
  }

  const v = cond.operand.value;
  let input;
  if (kind === 'list') {
    input = (
      <select aria-label={label} value={v} disabled={ctx.disabled} onChange={e => onChange({ ...cond, operand: { kind: 'value', value: e.target.value } })}>
        <option value="">Choose…</option>
        {list.map(e => <option key={e.code} value={e.code}>{e.label}</option>)}
      </select>
    );
  } else if (kind === 'date') {
    input = <input type="date" aria-label={label} value={v} disabled={ctx.disabled} onChange={e => onChange({ ...cond, operand: { kind: 'value', value: e.target.value } })} />;
  } else {
    input = <input aria-label={label} value={v} disabled={ctx.disabled} inputMode={kind === 'decimal' ? 'decimal' : undefined} placeholder={kind === 'decimal' ? '0' : ''}
      onChange={e => onChange({ ...cond, operand: { kind: 'value', value: kind === 'decimal' ? e.target.value.replace(/[\s,]/g, '') : e.target.value } })} />;
  }
  return (
    <div className="value-cell">
      {input}
      {kind === 'decimal' && settings.length > 0 && <span className="field-help">Limits belong in settings so each bank sets its own.</span>}
      {toggle}
    </div>
  );
}

function CondEditor({ cond, ctx, onChange }: { cond: CondNode; ctx: BuilderCtx; onChange: (c: CondNode) => void }) {
  const f = ctx.field(cond.field);
  const kind = kindOf(f);
  const ops = opsFor(kind);
  const problem = ctx.problems.get(cond.id);
  return (
    <div className={`cond-row${problem ? ' has-problem' : ''}`}>
      <div className="cond-field">
        <Combobox options={ctx.fieldOptions} value={cond.field} ariaLabel="Field" placeholder="Choose a field…" disabled={ctx.disabled} invalid={!cond.field && !!problem}
          onChange={key => {
            const nk = kindOf(ctx.field(key));
            const op = opsFor(nk).some(o => o[0] === cond.op) && cond.field && kindOf(ctx.field(cond.field)) === nk ? cond.op : opsFor(nk)[0][0];
            onChange({ ...cond, field: key, op, operand: defaultOperand(op) });
          }} />
        {f?.hidden && <span className="field-help">Hidden on screens — the rule still reads it.</span>}
      </div>
      <select className="cond-op" aria-label="Comparison" value={cond.op} disabled={ctx.disabled || !cond.field}
        onChange={e => { const op = e.target.value as CondNode['op']; onChange({ ...cond, op, operand: (op === 'in') !== (cond.operand.kind === 'values') ? defaultOperand(op) : cond.operand }); }}>
        {ops.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
      </select>
      <div className="cond-value">{cond.field && <ValueEditor cond={cond} ctx={ctx} onChange={onChange} />}</div>
      {problem && <p className="cond-problem" role="alert">{problem}</p>}
    </div>
  );
}

export function GroupEditor({ group, ctx, onChange, onRemove, depth = 0 }: {
  group: GroupNode; ctx: BuilderCtx; onChange: (g: GroupNode) => void; onRemove?: () => void; depth?: number;
}) {
  const setItems = (items: RuleNode[]) => onChange({ ...group, items });
  const setItem = (i: number, n: RuleNode) => setItems(group.items.map((x, j) => (j === i ? n : x)));
  const problem = ctx.problems.get(group.id);
  return (
    <div className={`rule-group depth-${Math.min(depth, 3)}${group.not ? ' negated' : ''}`} role="group" aria-label={depth === 0 ? 'When' : 'Condition group'}>
      <div className="rg-head">
        <div className="seg" role="radiogroup" aria-label="How the conditions combine">
          {(['all', 'any'] as const).map(m => (
            <button key={m} type="button" role="radio" aria-checked={group.mode === m} className={`seg-btn${group.mode === m ? ' active' : ''}`} disabled={ctx.disabled}
              onClick={() => onChange({ ...group, mode: m })}>{m === 'all' ? 'All of these' : 'Any of these'}</button>
          ))}
        </div>
        <label className="checkbox not-toggle" title="The group matches when its conditions do NOT match">
          <input type="checkbox" checked={group.not} disabled={ctx.disabled} onChange={e => onChange({ ...group, not: e.target.checked })} /> Not
        </label>
        <span className="grow muted small">{group.not ? 'Matches when this group is NOT true' : group.mode === 'all' ? 'Every condition must be true' : 'At least one condition must be true'}</span>
        {onRemove && !ctx.disabled && <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove group</button>}
      </div>
      <ol className="rg-items">
        {group.items.map((n, i) => (
          <li key={n.id} className="rg-item">
            {i > 0 && <span className="rg-joiner" aria-hidden="true">{group.mode === 'all' ? 'and' : 'or'}</span>}
            <div className="rg-body">
              {n.type === 'group'
                ? <GroupEditor group={n} ctx={ctx} depth={depth + 1} onChange={g => setItem(i, g)} onRemove={() => setItems(group.items.filter((_, j) => j !== i))} />
                : <CondEditor cond={n} ctx={ctx} onChange={c => setItem(i, c)} />}
            </div>
            {!ctx.disabled && (
              <span className="row-tools rg-tools">
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => setItems(move(group.items, i, -1))} aria-label="Move up">↑</button>
                <button type="button" className="icon-btn" disabled={i === group.items.length - 1} onClick={() => setItems(move(group.items, i, 1))} aria-label="Move down">↓</button>
                {n.type === 'cond' && <button type="button" className="icon-btn danger" onClick={() => setItems(group.items.filter((_, j) => j !== i))} aria-label="Remove condition">✕</button>}
              </span>
            )}
          </li>
        ))}
      </ol>
      {group.items.length === 0 && <p className="muted small rg-empty">{problem ?? 'No conditions yet.'} Add a condition such as “Requested amount in base currency is more than a setting”.</p>}
      {!ctx.disabled && (
        <div className="rg-add">
          <button type="button" className="add-line" onClick={() => setItems([...group.items, newCondition()])}>+ Add condition</button>
          <button type="button" className="add-line" onClick={() => setItems([...group.items, { ...newGroup(group.mode === 'all' ? 'any' : 'all'), items: [newCondition()] }])}>+ Add group</button>
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<ActionType, string> = {
  block: 'Block saving, with a message', warn: 'Warn, with a message', require: 'Require a field, with a message', hide: 'Hide a field',
};

export function ActionsEditor({ actions, onChange, ctx, requireOptions }: {
  actions: ActionNode[]; onChange: (a: ActionNode[]) => void; ctx: BuilderCtx; requireOptions: ComboOption[];
}) {
  const set = (i: number, a: ActionNode) => onChange(actions.map((x, j) => (j === i ? a : x)));
  return (
    <div className="rule-actions">
      {actions.length === 0 && <p className="muted small" style={{ margin: '0 0 8px' }}>No actions yet. A rule needs at least one, for example “Require a field”.</p>}
      <ol className="ra-list">
        {actions.map((a, i) => {
          const problem = ctx.problems.get(a.id);
          const needsField = a.type === 'require' || a.type === 'hide';
          return (
            <li key={a.id} className={`ra-row${problem ? ' has-problem' : ''}`}>
              <select aria-label="Action" value={a.type} disabled={ctx.disabled} onChange={e => set(i, { ...a, type: e.target.value as ActionType })}>
                {(Object.keys(ACTION_LABEL) as ActionType[]).map(t => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
              </select>
              {needsField && (
                <div className="ra-field">
                  <Combobox options={requireOptions} value={a.field ?? ''} ariaLabel={a.type === 'require' ? 'Field to require' : 'Field to hide'} placeholder="Choose a field…"
                    disabled={ctx.disabled} onChange={field => set(i, { ...a, field })} invalid={!a.field && !!problem} />
                </div>
              )}
              {a.type !== 'hide' && (
                <input className="ra-message" aria-label="Message shown to the user" placeholder={a.type === 'require' ? 'e.g. Purpose code is required for new facilities' : 'Message shown to the user'}
                  value={a.message ?? ''} disabled={ctx.disabled} onChange={e => set(i, { ...a, message: e.target.value })} maxLength={500} />
              )}
              {!ctx.disabled && <button type="button" className="icon-btn danger" aria-label="Remove action" onClick={() => onChange(actions.filter((_, j) => j !== i))}>✕</button>}
              {problem && <p className="cond-problem" role="alert">{problem}</p>}
            </li>
          );
        })}
      </ol>
      {!ctx.disabled && <button type="button" className="add-line" onClick={() => onChange([...actions, { id: nid(), type: 'require', message: '' }])}>+ Add action</button>}
    </div>
  );
}
