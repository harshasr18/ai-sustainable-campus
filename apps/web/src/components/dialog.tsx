/**
 * Modal and confirmation dialog.
 *
 * §11 of the brief requires "a confirmation step before consequential actions". Consequential
 * here means: approving work, resolving an issue, changing someone's role, suspending an
 * account. Each of those is irreversible or nearly so, and each gets an explicit confirm.
 *
 * Implemented without a dependency, but not naively — a modal that traps focus, closes on
 * Escape, restores focus on close, and sets `aria-modal` is about thirty lines and is the
 * difference between a dialog a keyboard user can operate and one they cannot.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  onClose,
  footer,
  labelledBy = 'modal-title',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap: Tab cycles within the dialog rather than escaping to the page behind it.
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);

    // Focus the dialog itself first, so screen readers announce the title before the body.
    dialogRef.current?.focus();

    // Lock background scroll while the dialog is open.
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
      previouslyFocused.current?.focus();
    };
  }, [handleKeyDown]);

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal__head">
          <h2 className="modal__title" id={labelledBy}>
            {title}
          </h2>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation dialog.
 *
 * `destructive` changes the confirm button's styling so a status change and an account
 * suspension do not look identical at the moment of the click.
 *
 * `pending` disables both buttons while the request is in flight — the same double-submit
 * protection the forms use, because a double-confirmed approval is a real problem.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={pending ? () => {} : onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
