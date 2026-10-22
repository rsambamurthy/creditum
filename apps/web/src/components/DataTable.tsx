import type { KeyboardEvent, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  num?: boolean;
  className?: string;
  hideSm?: boolean;
}

/**
 * Table in the design-system style. When `onRowClick` is set, rows are keyboard-reachable
 * (Enter/Space) and announced as links to the row's detail.
 */
export function DataTable<T>({ rows, columns, rowKey, onRowClick, rowLabel, empty, caption, compact, rowClass }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; rowLabel?: (r: T) => string;
  empty?: ReactNode; caption?: string; compact?: boolean; rowClass?: (r: T) => string | undefined;
}) {
  const onKey = (e: KeyboardEvent, r: T) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRowClick(r); }
  };
  return (
    <div className="table-wrap">
      <table className={`table${onRowClick ? '' : ' static'}${compact ? ' compact' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>{columns.map(c => <th key={c.key} scope="col" className={[c.num ? 'num' : '', c.hideSm ? 'hide-sm' : ''].join(' ').trim() || undefined}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="no-hover"><td colSpan={columns.length}><div className="empty">{empty ?? 'Nothing to show.'}</div></td></tr>
          ) : rows.map(r => (
            <tr key={rowKey(r)} className={rowClass?.(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined} onKeyDown={onRowClick ? e => onKey(e, r) : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(r) : undefined}>
              {columns.map(c => (
                <td key={c.key} className={[c.num ? 'num' : '', c.className ?? '', c.hideSm ? 'hide-sm' : ''].join(' ').trim() || undefined}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span className="muted small">{from}–{to} of {total}</span>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="small" style={{ alignSelf: 'center' }}>Page {page + 1} of {pages}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
