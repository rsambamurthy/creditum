// Deliberate violations: the self-test proves every guardrail rule fires on this file.
// This file is never compiled or shipped.
declare const repo: { find(o?: unknown): unknown[]; query(s: string): unknown };
declare function compare(a: string, b: string): number;

export const defaultCurrency = 'KWD';                       // no-hardcoded-currency
export const label = 'Fee: ₹500';                           // no-hardcoded-currency
export function tooBig(amount: string) {
  return compare(amount, '250000') > 0;                     // no-hardcoded-threshold
}
export const maxExposure = 5000000;                         // no-hardcoded-threshold
export function coverageOk(ratio: number) { return ratio >= 1.25; } // no-float-money + no-hardcoded-threshold
export class Facility { approvedLimit: number; }            // no-float-money
export const sql = repo.query('SELECT NVL(x, 0) FROM t');   // no-vendor-sql (twice)
export const proc = 'CREATE OR REPLACE PROCEDURE approve_loan AS BEGIN NULL; END;'; // no-db-logic
export const leaky = repo.find({ where: { status: 'open' } }); // tenant-scope
