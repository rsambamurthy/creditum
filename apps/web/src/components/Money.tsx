import { formatDecimal } from '../format';
import { useReference } from '../reference';

/** Amount (decimal string) in a currency, formatted to that currency's configured minor units. */
export function Amount({ value, code, showCode = true }: { value: string | null | undefined; code: string | undefined; showCode?: boolean }) {
  const { currency } = useReference();
  const c = code ? currency(code) : undefined;
  return (
    <span className="mono-num nowrap">
      {formatDecimal(value, c?.minorUnits)}
      {showCode && code && <span className="ccy"> {code}</span>}
    </span>
  );
}
