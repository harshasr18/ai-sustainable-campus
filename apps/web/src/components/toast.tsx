/**
 * Transient notifications.
 *
 * Used for outcomes of actions the user already took ("Issue approved", "Category updated")
 * — never as the only place an error appears. An error that vanishes after five seconds is
 * an error the user may have missed, so failures are also rendered inline next to the
 * control that caused them (see `InlineAlert` and the `useMutation` hook's `error`).
 *
 * The region is `aria-live="polite"` so a screen reader announces the outcome without
 * interrupting.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastVariant = 'success' | 'error';

interface Toast {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, variant, message }]);
      // Errors stay longer: they usually need reading, and sometimes copying.
      window.setTimeout(() => dismiss(id), variant === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('error', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.variant === 'error' ? ' toast--error' : ''}`}>
            <span aria-hidden="true" className="strong">
              {toast.variant === 'error' ? '!' : '✓'}
            </span>
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
