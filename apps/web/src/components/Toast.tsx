import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WriteResult } from '../api';

type ToastTone = 'info' | 'ok' | 'err';
interface ToastItem { id: number; tone: ToastTone; text: string }
interface ToastApi {
  show: (text: string, tone?: ToastTone) => void;
  /** Standard message for a governed configuration write. */
  configResult: (r: WriteResult, appliedText?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
export const PENDING_APPROVAL = 'Pending approval by a second administrator';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems(xs => xs.filter(x => x.id !== id)), []);
  const show = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = next.current++;
    setItems(xs => [...xs.slice(-3), { id, tone, text }]);
    window.setTimeout(() => dismiss(id), tone === 'err' ? 8000 : 5000);
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({
    show,
    configResult: (r, appliedText = 'Change applied') => show(r.status === 'pending' ? PENDING_APPROVAL : appliedText, r.status === 'pending' ? 'info' : 'ok'),
  }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite" aria-atomic="false">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast must be used inside ToastProvider');
  return c;
}
