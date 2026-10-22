/**
 * Request Number Generation Scheme (SDD Section 19.1 / 18.2). The format is tenant configuration:
 * prefix, separator, zero-padding, whether the year is included and when the sequence resets.
 */
import { DomainError } from '../../common/errors';

export interface NumberScheme { prefix: string; separator: string; padding: number; includeYear: boolean; reset: 'yearly' | 'never' }

/** "none" is the configured way to say "no separator" (portable: some engines store '' as NULL). */
export function separatorValue(configured: string): string {
  return configured === 'none' ? '' : configured;
}

export function sequenceScope(scheme: NumberScheme, year: number): string {
  return scheme.reset === 'yearly' ? `credit_request:${year}` : 'credit_request';
}

export function formatRequestNumber(scheme: NumberScheme, year: number, seq: number): string {
  if (!Number.isInteger(scheme.padding) || scheme.padding < 1) throw new DomainError('config_invalid', 'request_number.padding must be a positive whole number');
  if (scheme.reset !== 'yearly' && scheme.reset !== 'never') throw new DomainError('config_invalid', 'request_number.reset must be "yearly" or "never"');
  const parts = [scheme.prefix, ...(scheme.includeYear ? [String(year)] : []), String(seq).padStart(scheme.padding, '0')].filter(p => p !== '');
  return parts.join(scheme.separator);
}
