import type { Tone } from '../format';

export interface StatTile { key: string; label: string; count: number | string; tone?: Tone | 'brand' | 'accent' }

/** Row of stat tiles (buttons). When `onSelect` is given, tiles act as filters; `active` marks the selected one. */
export function StatTiles({ tiles, active, onSelect, label }: {
  tiles: StatTile[]; active?: string; onSelect?: (key: string) => void; label: string;
}) {
  return (
    <div className="stat-row stat-row-auto" role="group" aria-label={label}>
      {tiles.map(t => (
        <button key={t.key} type="button" className={`stat stat-${t.tone ?? 'neutral'}${active === t.key ? ' active' : ''}`}
          aria-pressed={onSelect ? active === t.key : undefined} onClick={() => onSelect?.(t.key)} title={t.label}
          style={onSelect ? undefined : { cursor: 'default' }}>
          <span className="stat-n">{t.count}</span>
          <span className="stat-l">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
