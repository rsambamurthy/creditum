import { useRef, type TextareaHTMLAttributes } from 'react';

/**
 * Rich-text area for narrative fields. Phase 0 stores text with lightweight markup (bullets, numbering, **bold**)
 * in the field's typed text value; the toolbar inserts that markup at the cursor.
 */
export function RichText({ value, onChange, maxLength, disabled, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string; onChange: (v: string) => void; maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const apply = (kind: 'bold' | 'bullet' | 'number') => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    let next: string; let caret: number;
    if (kind === 'bold') {
      const sel = value.slice(s, e) || 'text';
      next = `${value.slice(0, s)}**${sel}**${value.slice(e)}`; caret = s + sel.length + 4;
    } else {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const prefix = kind === 'bullet' ? '• ' : '1. ';
      next = `${value.slice(0, lineStart)}${prefix}${value.slice(lineStart)}`; caret = e + prefix.length;
    }
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  };
  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label="Formatting">
        <button type="button" disabled={disabled} onClick={() => apply('bold')} aria-label="Bold"><strong>B</strong></button>
        <button type="button" disabled={disabled} onClick={() => apply('bullet')} aria-label="Bulleted line">•</button>
        <button type="button" disabled={disabled} onClick={() => apply('number')} aria-label="Numbered line">1.</button>
      </div>
      <textarea ref={ref} value={value} onChange={ev => onChange(ev.target.value)} maxLength={maxLength} rows={7} disabled={disabled} {...rest} />
      <div className="rte-foot" aria-hidden="true"><span>Markup: **bold**, • bullets</span><span>{value.length}{maxLength ? ` / ${maxLength}` : ''}</span></div>
    </div>
  );
}
