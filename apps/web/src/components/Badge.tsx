import type { ReactNode } from 'react';
import { statusTone, type Tone } from '../format';

export function Badge({ tone = 'neutral', children, small, title }: { tone?: Tone | 'auto'; children: ReactNode; small?: boolean; title?: string }) {
  return <span className={`badge badge-${tone}${small ? ' sm' : ''}`} title={title}>{children}</span>;
}

/** Workflow status badge (tone derived from the tenant's status code). */
export function StatusBadge({ code, label }: { code: string; label: string }) {
  return <Badge tone={statusTone(code)}>{label}</Badge>;
}

const REQUIREMENT_TONE: Record<string, Tone> = { Mandatory: 'err', Conditional: 'warn', Optional: 'neutral', 'System-populated': 'info' };
export function RequirementBadge({ value }: { value: string }) {
  return <Badge tone={REQUIREMENT_TONE[value] ?? 'neutral'}>{value}</Badge>;
}

export function ScopeBadge({ scope }: { scope: string }) {
  return scope === 'core' ? <Badge tone="info">Core</Badge> : <Badge tone="auto">Tenant</Badge>;
}

export function OriginChip({ origin }: { origin: string }) {
  const o = origin.toLowerCase();
  const cls = o.includes('tenant') ? 'tenant' : o.includes('replacement') ? 'replacement' : o.includes('generic') ? 'generic' : o.includes('industry') ? 'std' : '';
  return <span className={`origin-chip ${cls}`}>{origin}</span>;
}
