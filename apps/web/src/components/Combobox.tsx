import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface ComboOption { value: string; label: string; group?: string; hint?: string; badge?: ReactNode }

/**
 * Searchable, grouped picker (ARIA 1.2 combobox with a listbox popup). Type to filter by label, hint or value;
 * ArrowUp/ArrowDown move, Enter picks, Escape closes.
 */
export function Combobox({ options, value, onChange, placeholder = 'Search…', ariaLabel, id, invalid, disabled, maxShown = 80 }: {
  options: ComboOption[]; value: string; onChange: (v: string) => void; placeholder?: string; ariaLabel?: string; id?: string;
  invalid?: boolean; disabled?: boolean; maxShown?: number;
}) {
  const auto = useId();
  const inputId = id ?? `${auto}-in`;
  const listId = `${auto}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? options.filter(o => `${o.label} ${o.hint ?? ''} ${o.group ?? ''} ${o.value}`.toLowerCase().includes(q)) : options;
    return hits.slice(0, maxShown);
  }, [options, query, maxShown]);
  const total = query.trim() ? options.filter(o => `${o.label} ${o.hint ?? ''} ${o.group ?? ''} ${o.value}`.toLowerCase().includes(query.trim().toLowerCase())).length : options.length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open) document.getElementById(`${auto}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, auto]);

  const pick = (o: ComboOption) => { onChange(o.value); setOpen(false); setQuery(''); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive(a => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open && filtered[active]) { e.preventDefault(); pick(filtered[active]); } }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); } }
  };

  let lastGroup: string | undefined;
  return (
    <div className={`combo${invalid ? ' has-error' : ''}`} ref={wrap}>
      <input id={inputId} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel}
        aria-activedescendant={open && filtered[active] ? `${auto}-opt-${active}` : undefined} aria-invalid={invalid || undefined}
        value={open ? query : selected?.label ?? (value ? value : '')} placeholder={selected ? selected.label : placeholder} disabled={disabled}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); }} onKeyDown={onKey} autoComplete="off" />
      {selected?.hint && !open && <span className="combo-hint">{selected.hint}</span>}
      {open && (
        <ul className="combo-list" role="listbox" id={listId} aria-label={ariaLabel}>
          {filtered.length === 0 && <li className="combo-empty" role="presentation">No match for “{query}”</li>}
          {filtered.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? <li className="combo-group" role="presentation" key={`g-${o.group}-${i}`}>{o.group}</li> : null;
            lastGroup = o.group;
            return [head, (
              <li key={o.value} id={`${auto}-opt-${i}`} role="option" aria-selected={o.value === value} className={`combo-opt${i === active ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
                onMouseDown={e => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}>
                <span className="combo-label">{o.label}{o.badge}</span>
                {o.hint && <span className="combo-sub">{o.hint}</span>}
              </li>
            )];
          })}
          {total > filtered.length && <li className="combo-empty" role="presentation">{total - filtered.length} more — keep typing to narrow the list</li>}
        </ul>
      )}
    </div>
  );
}
