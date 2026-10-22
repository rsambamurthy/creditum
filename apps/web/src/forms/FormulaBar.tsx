/**
 * Spreadsheet-style formula input. Typing "[" opens a list of fields (tenant labels; fields of the same table and of
 * the request record first); a functions menu inserts templates such as PERCENT(, ); a settings menu inserts PARAM("…").
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface BarField {
  key: string; label: string; section: string;
  /** "same" = same table as the formula, "record" = request record, "other" = another table (use inside SUM). */
  scope: 'same' | 'record' | 'other';
  /** Text to insert, e.g. "[Gross Profit]" or "[Income Statement › Gross Profit]" when the label repeats. */
  insert: string;
}
export interface BarSetting { key: string; description: string | null; value: string }

const SCOPE_LABEL = { same: 'This table', record: 'Request record', other: 'Other tables (use inside SUM)' };

/** Where a "[" field reference is being typed: the position of "[" and the text typed after it. */
function fieldContext(text: string, caret: number): { start: number; query: string } | null {
  const open = text.lastIndexOf('[', caret - 1);
  if (open < 0) return null;
  const between = text.slice(open + 1, caret);
  if (between.includes(']')) return null;
  return { start: open, query: between };
}

function template(sig: string): { text: string; caret: number } {
  const name = sig.split('(')[0].trim();
  const inside = sig.slice(sig.indexOf('(') + 1, sig.indexOf(')'));
  if (!inside.trim()) return { text: `${name}()`, caret: name.length + 2 };
  if (name === 'PREVIOUS') return { text: 'PREVIOUS([])', caret: 'PREVIOUS(['.length };
  const args = inside.split(',').length;
  return { text: `${name}(${', '.repeat(args - 1)})`, caret: name.length + 1 };
}

export function FormulaBar({ value, onChange, fields, functions, settings, disabled, errorAt, id, describedBy }: {
  value: string; onChange: (v: string) => void; fields: BarField[]; functions: string[]; settings: BarSetting[];
  disabled?: boolean; errorAt?: number | null; id?: string; describedBy?: string;
}) {
  const auto = useId();
  const listId = `${auto}-fields`;
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menu, setMenu] = useState<'functions' | 'settings' | null>(null);
  const blurTimer = useRef<number | null>(null);

  const ctx = fieldContext(value, caret);
  const matches = useMemo(() => {
    if (!ctx) return [];
    const q = ctx.query.trim().toLowerCase();
    const order = { same: 0, record: 1, other: 2 };
    return fields.filter(f => !q || f.label.toLowerCase().includes(q) || f.section.toLowerCase().includes(q))
      .sort((a, b) => order[a.scope] - order[b.scope] || a.label.localeCompare(b.label)).slice(0, 60);
  }, [ctx?.query, ctx?.start, fields]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = !!ctx && !dismissed && !disabled && matches.length > 0;

  const replace = (from: number, to: number, text: string, caretAt = text.length) => {
    const next = value.slice(0, from) + text + value.slice(to);
    onChange(next);
    const pos = from + caretAt;
    setCaret(pos); setDismissed(false);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(pos, pos); });
  };
  const insertAtCaret = (text: string, caretAt = text.length) => {
    const el = area.current;
    const s = el ? el.selectionStart : value.length; const e = el ? el.selectionEnd : value.length;
    replace(s, e, text, caretAt);
  };
  const pick = (f: BarField) => {
    if (!ctx) return;
    const closeAfter = value[caret] === ']' ? 1 : 0;
    replace(ctx.start, caret + closeAfter, f.insert);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, matches.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[Math.min(active, matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
    }
    if (e.key === 'Enter') e.preventDefault(); // a formula is one expression; line breaks are not needed
  };
  const sync = () => { const el = area.current; if (el) { setCaret(el.selectionStart); } };

  let lastScope: string | null = null;
  return (
    <div className="formula-bar">
      <div className="fb-tools">
        <span className="fb-fx" aria-hidden="true">fx</span>
        <div className="fb-menu">
          <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="true" aria-expanded={menu === 'functions'} disabled={disabled}
            onClick={() => setMenu(m => (m === 'functions' ? null : 'functions'))}>Functions ▾</button>
          {menu === 'functions' && (
            <ul className="fb-pop" role="menu" aria-label="Functions">
              {functions.map(fn => {
                const [sig, help] = fn.split(' — ');
                return (
                  <li key={fn} role="none">
                    <button type="button" role="menuitem" onClick={() => {
                      setMenu(null);
                      if (sig.startsWith('PARAM')) { setMenu('settings'); return; }
                      const t = template(sig); insertAtCaret(t.text, t.caret);
                    }}><span className="mono">{sig}</span>{help && <span className="muted small">{help}</span>}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="fb-menu">
          <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="true" aria-expanded={menu === 'settings'} disabled={disabled || settings.length === 0}
            onClick={() => setMenu(m => (m === 'settings' ? null : 'settings'))}>Settings ▾</button>
          {menu === 'settings' && (
            <ul className="fb-pop" role="menu" aria-label="Settings">
              {settings.map(s => (
                <li key={s.key} role="none">
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); insertAtCaret(`PARAM("${s.key}")`); }}>
                    <span>{s.description ?? s.key}</span><span className="muted small mono">{s.key} = {s.value}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => { insertAtCaret('[]', 1); setDismissed(false); }}>Insert field</button>
        <span className="grow" />
        <span className="muted small">Type <span className="kbd">[</span> to insert a field · <span className="kbd">+ − × ÷</span> and brackets work as in a spreadsheet</span>
      </div>
      <textarea ref={area} id={id} className="fb-input" rows={3} value={value} disabled={disabled} spellCheck={false} aria-describedby={describedBy}
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open ? `${auto}-o${active}` : undefined}
        onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart); setActive(0); setDismissed(false); }}
        onKeyDown={onKey} onKeyUp={sync} onClick={sync} onSelect={sync} onBlur={() => { blurTimer.current = window.setTimeout(() => setDismissed(true), 150); }}
        onFocus={() => { if (blurTimer.current) window.clearTimeout(blurTimer.current); blurTimer.current = null; setDismissed(false); }}
        placeholder="e.g. PERCENT([Gross Profit], [Revenue / Sales])" />
      {errorAt != null && errorAt >= 0 && value && !open && (
        <div className="fb-error-line mono" aria-hidden="true">
          {value.slice(0, errorAt)}<mark>{value.slice(errorAt, errorAt + 1) || ' '}</mark>{value.slice(errorAt + 1)}
        </div>
      )}
      {open && (
        <ul className="combo-list fb-list" role="listbox" id={listId} aria-label="Fields">
          {matches.map((f, i) => {
            const head = f.scope !== lastScope ? <li key={`h-${f.scope}`} className="combo-group" role="presentation">{SCOPE_LABEL[f.scope]}</li> : null;
            lastScope = f.scope;
            return [head, (
              <li key={f.key} id={`${auto}-o${i}`} role="option" aria-selected={i === active} className={`combo-opt${i === active ? ' active' : ''}`}
                onMouseDown={e => { e.preventDefault(); pick(f); }} onMouseEnter={() => setActive(i)}>
                <span className="combo-label">{f.label}</span><span className="combo-sub">{f.section}</span>
              </li>
            )];
          })}
        </ul>
      )}
    </div>
  );
}
