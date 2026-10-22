/**
 * Display formatting. Amounts are decimal strings and are formatted as strings — never converted to
 * JavaScript numbers. Grouping uses thousands separators (Indian grouping is not required).
 */

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const UNSIGNED_DECIMAL_TEXT = /^\d+(\.\d+)?$/;

export function isDecimalText(s: string): boolean { return DECIMAL_TEXT.test(s); }
export function isUnsignedDecimalText(s: string): boolean { return UNSIGNED_DECIMAL_TEXT.test(s); }

/** Number of digits after the decimal point. */
export function scaleOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** True when the decimal text has at least one non-zero digit. */
export function isNonZeroDecimal(s: string): boolean { return /[1-9]/.test(s); }

function groupThousands(intPart: string): string {
  const digits = intPart.replace(/^0+(?=\d)/, '');
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ',';
  }
  return out;
}

/**
 * Format a decimal string with thousands separators. With `scale`, the fraction is padded or trimmed of
 * trailing zeros to that many digits (significant digits beyond the scale are kept, never rounded away).
 * Without `scale`, trailing fractional zeros are removed.
 */
export function formatDecimal(value: string | null | undefined, scale?: number): string {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  if (!DECIMAL_TEXT.test(s)) return s;
  const negative = s.startsWith('-');
  const [intPart, fracRaw = ''] = (negative ? s.slice(1) : s).split('.');
  let frac = fracRaw;
  if (scale === undefined) {
    frac = frac.replace(/0+$/, '');
  } else {
    while (frac.length > scale && frac.endsWith('0')) frac = frac.slice(0, -1);
    while (frac.length < scale) frac += '0';
  }
  return `${negative ? '-' : ''}${groupThousands(intPart)}${frac ? `.${frac}` : ''}`;
}

/** Remove trailing fractional zeros ("0.307000000000" -> "0.307"). */
export function trimDecimal(value: string | null | undefined): string {
  return formatDecimal(value).replace(/,/g, '');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const minutes = Math.round((Date.now() - d) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(iso);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** "senior_committee_member" -> "Senior Committee Member". */
export function humanize(code: string): string {
  return code.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}

export function rolesLabel(roles: string[]): string { return roles.map(humanize).join(', '); }

export function prettyJson(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export function shortHash(h: string, n = 12): string { return h.length > n ? `${h.slice(0, n)}…` : h; }

/**
 * Visual tone of a workflow status. Statuses are tenant-configured codes, so this is a presentation
 * heuristic only (no business logic depends on it).
 */
export type Tone = 'neutral' | 'info' | 'warn' | 'sent_back' | 'ok' | 'err';
export function statusTone(code: string): Tone {
  const c = code.toLowerCase();
  if (/approv|sanction|disburs|complete|closed_won/.test(c)) return 'ok';
  if (/declin|reject|cancel|withdraw|lapsed/.test(c)) return 'err';
  if (/sent_back|return|rework/.test(c)) return 'sent_back';
  if (/draft|new|initiat/.test(c)) return 'neutral';
  if (/committee|board|approval/.test(c)) return 'info';
  return 'warn';
}
