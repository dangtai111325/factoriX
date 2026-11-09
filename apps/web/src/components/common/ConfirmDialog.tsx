import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, AlertCircle, HelpCircle } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import { ModalPortal } from '../modals/ModalPortal';
import { useDialogA11y } from '../modals/useDialogA11y';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  /** Extra content under the message (impact list, options such as a checkbox). */
  children?: React.ReactNode;
  confirmLabel?: string;
  confirmText?: string;
  /** Label shown while onConfirm runs (default "Working…"). */
  busyLabel?: string;
  cancelLabel?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
  /** Disable the confirm button (e.g. while the impact is still loading). */
  confirmDisabled?: boolean;
  /** Error text shown inside the dialog (the caller keeps the dialog open on failure). */
  error?: string | null;
  /** Wider dialog for long impact lists. */
  wide?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Confirmation dialog. `onConfirm` runs at most once at a time (in-flight guard, R3-DM-04): the
 * confirm button is disabled and Escape / Cancel are ignored while it runs.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  children,
  confirmLabel,
  confirmText,
  busyLabel,
  cancelLabel,
  cancelText,
  variant = 'danger',
  confirmDisabled = false,
  error,
  wide = false,
  onConfirm,
  onCancel,
}) => {
  const messageId = React.useId();
  const titleId = React.useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      runningRef.current = false;
      setBusy(false);
    }
  }, [isOpen]);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!runningRef.current) onCancel();
  });

  if (!isOpen) return null;

  const resolvedConfirm = confirmLabel || confirmText || 'Confirm';
  const resolvedCancel = cancelLabel || cancelText || 'Cancel';

  const handleConfirm = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !runningRef.current) onCancel();
        }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={messageId}
          tabIndex={-1}
          onKeyDown={(event) => {
            // Enter confirms a non-destructive dialog from any field (buttons and links act natively).
            // A destructive (danger) dialog starts on Cancel, so Enter right after opening cancels.
            if (variant === 'danger' || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            if ((event.target as HTMLElement).closest('button, a, textarea, select')) return;
            event.preventDefault();
            if (!confirmDisabled) void handleConfirm();
          }}
          className={`w-full ${wide ? 'max-w-lg' : 'max-w-sm'} max-h-[calc(100vh-2rem)] flex outline-none`}
        >
          <Card className="w-full p-5 bg-white border border-slate-300 shadow-2xl space-y-4 flex flex-col min-h-0">
            <div className="flex items-start gap-3 min-h-0">
              {variant === 'danger' ? (
                <div className="p-2 bg-red-100 text-red-600 rounded-full flex-shrink-0">
                  <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                </div>
              ) : variant === 'warning' ? (
                <div className="p-2 bg-amber-100 text-amber-600 rounded-full flex-shrink-0">
                  <AlertCircle className="w-5 h-5" aria-hidden="true" />
                </div>
              ) : (
                <div className="p-2 bg-blue-100 text-blue-600 rounded-full flex-shrink-0">
                  <HelpCircle className="w-5 h-5" aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0 flex-1 flex flex-col min-h-0">
                <h3 id={titleId} className="text-[14px] font-bold text-[#111B37] leading-snug break-words">{title}</h3>
                <div className="overflow-y-auto min-h-0">
                  <p id={messageId} className="text-[12px] text-[#657794] mt-1.5 leading-relaxed">{message}</p>
                  {children && <div className="mt-3 text-[12px] text-[#334568]">{children}</div>}
                  {error && (
                    <p role="alert" className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 flex-wrap">
              <Button variant="outline" size="sm" onClick={onCancel} disabled={busy} data-autofocus={variant === 'danger' ? true : undefined}>
                {resolvedCancel}
              </Button>
              <Button
                variant={variant === 'danger' ? 'danger' : 'primary'}
                size="sm"
                onClick={() => void handleConfirm()}
                disabled={busy || confirmDisabled}
                aria-busy={busy}
                data-autofocus={variant === 'danger' ? undefined : true}
              >
                {busy ? busyLabel || 'Working…' : resolvedConfirm}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </ModalPortal>
  );
};
