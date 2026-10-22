/** Creditum wordmark in the Integrata house style (Philosopher 700 with the red superscript dot, as VendorGate). */
export function Wordmark({ light, size }: { light?: boolean; size?: number }) {
  return <span className={`wordmark${light ? ' light' : ''}`} style={size ? { fontSize: size } : undefined}>Creditum</span>;
}
