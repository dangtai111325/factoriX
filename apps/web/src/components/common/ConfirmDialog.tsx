import React from 'react';
import { AlertTriangle, AlertCircle, HelpCircle } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import { ModalPortal } from '../modals/ModalPortal';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmText?: string;
  cancelLabel?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel,
  confirmText,
  cancelLabel,
  cancelText,
  variant = 'danger',
  onConfirm,
  onCancel,
}) => {
  const messageId = React.useId();
  if (!isOpen) return null;

  const resolvedConfirm = confirmLabel || confirmText || 'Confirm';
  const resolvedCancel = cancelLabel || cancelText || 'Cancel';

  return (
    <ModalPortal>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={messageId}
        className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      >
        <Card className="w-full max-w-sm p-5 bg-white border border-slate-300 shadow-2xl space-y-4">
          <div className="flex items-start gap-3">
            {variant === 'danger' ? (
              <div className="p-2 bg-red-100 text-red-600 rounded-full flex-shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
            ) : variant === 'warning' ? (
              <div className="p-2 bg-amber-100 text-amber-600 rounded-full flex-shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
            ) : (
              <div className="p-2 bg-blue-100 text-blue-600 rounded-full flex-shrink-0">
                <HelpCircle className="w-5 h-5" />
              </div>
            )}
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37] leading-snug">{title}</h3>
              <p id={messageId} className="text-[12px] text-[#657794] mt-1.5 leading-relaxed">{message}</p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {resolvedCancel}
            </Button>
            <Button
              variant={variant === 'danger' ? 'danger' : 'primary'}
              size="sm"
              onClick={onConfirm}
            >
              {resolvedConfirm}
            </Button>
          </div>
        </Card>
      </div>
    </ModalPortal>
  );
};
