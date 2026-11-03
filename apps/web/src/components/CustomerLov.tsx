import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, type CoreBankingCustomer } from '../api';
import { useDebounced } from '../hooks';

const MIN_CHARS = 2;

/**
 * List of values for the customer number: type part of a name or a customer number and pick from the customers
 * core banking returns (customer number and name). Typing a number that is not in the list is still allowed.
 * ARIA 1.2 combobox with a listbox popup; ArrowUp/ArrowDown move, Enter picks, Escape closes.
 */
export function CustomerLov({ value, onType, onPick, source, maxLength, placeholder, invalid, describedBy, id }: {
  value: string; onType: (text: string) => void; onPick: (c: CoreBankingCustomer) => void; source: string;
  maxLength?: number; placeholder?: string; invalid?: boolean; describedBy?: string; id?: string;
}) {
  const auto = useId();
  const listId = `${auto}-list`;
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [items, setItems] = useState<CoreBankingCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const q = useDebounced(value.trim(), 250);

  useEffect(() => {
    if (!typed || q.length < MIN_CHARS) { setItems([]); setTotal(0); setError(null); return; }
    let live = true;
    setLoading(true); setError(null);
    api.coreBankingCustomers(q)
      .then(r => { if (live) { setItems(r.items); setTotal(r.total); setActive(0); setOpen(true); } })
      .catch(e => { if (live) { setItems([]); setTotal(0); setError(errorMessage(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [q, typed]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${auto}-opt-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, open, auto]);

  const pick = (c: CoreBankingCustomer) => { onPick(c); setTyped(false); setOpen(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive(a => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open && items[active]) { e.preventDefault(); pick(items[active]); } }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } }
  };
  const showList = open && typed && value.trim().length >= MIN_CHARS && (items.length > 0 || (!loading && (error || q === value.trim())));

  return (
    <div className="combo lov" ref={wrap}>
      <input id={id} role="combobox" aria-expanded={!!showList} aria-controls={listId} aria-autocomplete="list" aria-describedby={describedBy}
        aria-activedescendant={showList && items[active] ? `${auto}-opt-${active}` : undefined} aria-invalid={invalid || undefined}
        value={value} maxLength={maxLength} placeholder={placeholder ?? `Customer number or name — search ${source.toLowerCase()}`} autoComplete="off" className="ltr"
        onChange={e => { onType(e.target.value); setTyped(true); setOpen(true); }} onFocus={() => { if (items.length) setOpen(true); }} onKeyDown={onKey} />
      {loading && <span className="lov-spin" aria-hidden="true" />}
      {showList && (
        <div className="combo-list lov-list" id={listId} role="listbox" aria-label={`Customers in ${source.toLowerCase()}`}>
          {items.length > 0 && <div className="lov-head" aria-hidden="true"><span>Customer number</span><span>Name</span></div>}
          {items.map((c, i) => (
            <div key={c.cif} id={`${auto}-opt-${i}`} role="option" aria-selected={i === active} className={`lov-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); pick(c); }}>
              <span className="mono lov-cif">{c.cif}</span>
              <span className="lov-name">{c.name ?? '—'}{c.newOrExisting === 'new' && <span className="lov-tag">New customer</span>}</span>
            </div>
          ))}
          {error ? <div className="lov-note err-text">{error}</div>
            : items.length === 0 ? <div className="lov-note">No customer in {source.toLowerCase()} matches “{value.trim()}”. You can still use this number.</div>
              : total > items.length ? <div className="lov-note">Showing {items.length} of {total} — type more to narrow the list.</div> : null}
        </div>
      )}
    </div>
  );
}
