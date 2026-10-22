import { createContext, useContext, useEffect, type ReactNode } from 'react';

export interface Crumb { label: string; to?: string }

export const CrumbContext = createContext<(c: Crumb[]) => void>(() => undefined);

/** Set the breadcrumb trail for the current page. */
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbContext);
  const key = JSON.stringify(crumbs);
  useEffect(() => { set(crumbs); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function CrumbProvider({ value, children }: { value: (c: Crumb[]) => void; children: ReactNode }) {
  return <CrumbContext.Provider value={value}>{children}</CrumbContext.Provider>;
}
