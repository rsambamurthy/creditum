/**
 * Tenant reference data used across screens (currencies, request types, authority levels, field labels).
 * Loaded once per session and cached; nothing here is hardcoded — it all comes from tenant configuration.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AuthorityLevel, type Currency, type EffectiveField, type ValueListEntry } from './api';

interface Reference {
  currencies: Currency[];
  baseCurrency: Currency | undefined;
  requestTypes: ValueListEntry[];
  authorityLevels: AuthorityLevel[];
  fields: EffectiveField[] | undefined;
  loaded: boolean;
  error: unknown;
  currency: (code: string) => Currency | undefined;
  requestTypeLabel: (code: string) => string;
  levelName: (code: string) => string;
  field: (key: string) => EffectiveField | undefined;
  /** Load (or reload) the field registry — large, so only on demand. */
  loadFields: (force?: boolean) => Promise<EffectiveField[]>;
  reload: () => void;
}

const Ctx = createContext<Reference | null>(null);

export function ReferenceProvider({ children }: { children: ReactNode }) {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [requestTypes, setRequestTypes] = useState<ValueListEntry[]>([]);
  const [authorityLevels, setLevels] = useState<AuthorityLevel[]>([]);
  const [fields, setFields] = useState<EffectiveField[] | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([api.currencies(), api.valueList('request_type'), api.authorityLevels()])
      .then(([c, t, l]) => { if (live) { setCurrencies(c.filter(x => x.isActive)); setRequestTypes(t); setLevels(l); setLoaded(true); setError(null); } })
      .catch(e => { if (live) { setError(e); setLoaded(true); } });
    return () => { live = false; };
  }, [tick]);

  const loadFields = useCallback(async (force = false) => {
    if (fields && !force) return fields;
    const f = await api.fields();
    setFields(f);
    return f;
  }, [fields]);

  const value = useMemo<Reference>(() => {
    const byKey = new Map((fields ?? []).map(f => [f.fieldKey, f]));
    return {
      currencies, requestTypes, authorityLevels, fields, loaded, error,
      baseCurrency: currencies.find(c => c.isBase),
      currency: code => currencies.find(c => c.code === code),
      requestTypeLabel: code => requestTypes.find(t => t.code === code)?.label ?? code,
      levelName: code => authorityLevels.find(l => l.levelCode === code)?.name ?? code,
      field: key => byKey.get(key),
      loadFields,
      reload: () => { setTick(t => t + 1); setFields(undefined); },
    };
  }, [currencies, requestTypes, authorityLevels, fields, loaded, error, loadFields]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReference(): Reference {
  const c = useContext(Ctx);
  if (!c) throw new Error('useReference must be used inside ReferenceProvider');
  return c;
}
