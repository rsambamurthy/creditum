import type { ReactNode } from 'react';
import { formatDateTime, statusTone } from '../format';

export interface TimelineItem { id: string; title: ReactNode; meta: ReactNode; when: string; remarks?: string | null; statusCode: string; marker: ReactNode }

const TONE_CLASS: Record<string, string> = { ok: 'tl-approved', err: 'tl-rejected', sent_back: 'tl-sent_back', warn: 'tl-pending', info: 'tl-info', neutral: '' };

/** Vertical workflow history. Each entry's marker colour follows the status it moved to. */
export function Timeline({ items, empty }: { items: TimelineItem[]; empty?: ReactNode }) {
  if (!items.length) return <p className="muted small" style={{ margin: 0 }}>{empty ?? 'No history yet.'}</p>;
  return (
    <div className="timeline">
      <ol>
        {items.map(it => (
          <li key={it.id} className={TONE_CLASS[statusTone(it.statusCode)]}>
            <span className="tl-marker" aria-hidden="true">{it.marker}</span>
            <div className="tl-body">
              <div className="tl-top"><strong>{it.title}</strong><time className="muted small" dateTime={it.when}>{formatDateTime(it.when)}</time></div>
              <div className="muted small">{it.meta}</div>
              {it.remarks && <div className="tl-remarks">{it.remarks}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
