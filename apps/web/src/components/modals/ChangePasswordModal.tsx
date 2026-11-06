import React, { useEffect, useRef, useState } from 'react';
import { X, Lock, CheckCircle, AlertCircle } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { useDialogA11y } from './useDialogA11y';
import { ModalPortal } from './ModalPortal';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccessToast?: (msg: string) => void;
}

export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({
  isOpen,
  onClose,
  onSuccessToast,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!isSubmitting) onClose();
  });

  // Never keep passwords in memory between two openings of the dialog.
  useEffect(() => {
    if (!isOpen) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setFieldErrors({});
    setGeneralError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);
    const errors: Record<string, string> = {};

    if (!currentPassword) {
      errors.currentPassword = 'Enter your current password.';
    }
    if (!newPassword) {
      errors.newPassword = 'Password must be 12–128 characters.';
    } else if (newPassword.length < 12 || newPassword.length > 128) {
      errors.newPassword = 'Password must be 12–128 characters.';
    }
    if (newPassword !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      await api('/api/v1/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      setIsSubmitting(false);
      onClose();
      if (onSuccessToast) {
        onSuccessToast('Password changed');
      }
    } catch (err: unknown) {
      setIsSubmitting(false);
      const msg = err instanceof Error && err.message ? err.message : 'The password could not be changed.';
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setFieldErrors({ currentPassword: 'The current password is incorrect.' });
      } else {
        setGeneralError(msg);
      }
    }
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-[#D4DFEC] overflow-hidden outline-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="change-password-title"
        >
          <div className="p-6">
            <div className="flex items-center justify-between pb-3 border-b border-[#E3EAF3]">
              <div className="flex items-center gap-2.5 text-[#111B37]">
                <div className="p-2 rounded-lg bg-[#EEF5FF] text-[#1D63BD]">
                  <Lock className="w-5 h-5" />
                </div>
                <h3 id="change-password-title" className="text-[16px] font-bold">
                  Change Password
                </h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="text-[#94A3B8] hover:text-[#334568] transition-colors p-1 rounded-md"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="py-4 space-y-4">
              {generalError && (
                <div className="p-3 bg-[#FFF5F5] rounded-lg border border-[#FAC6C9] flex items-center gap-2 text-[12px] text-[#EF1B24]">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{generalError}</span>
                </div>
              )}

              <div>
                <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    if (fieldErrors.currentPassword) {
                      setFieldErrors((prev) => ({ ...prev, currentPassword: '' }));
                    }
                  }}
                  className={`w-full px-3 py-2 text-[13px] border rounded-lg focus:outline-none focus:ring-2 ${
                    fieldErrors.currentPassword
                      ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]'
                      : 'border-[#CBD5E1] focus:ring-[#1D63BD]/20 focus:border-[#1D63BD]'
                  }`}
                  autoFocus
                />
                {fieldErrors.currentPassword && (
                  <p className="text-[11px] text-[#EF1B24] mt-1 font-medium">{fieldErrors.currentPassword}</p>
                )}
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    if (fieldErrors.newPassword) {
                      setFieldErrors((prev) => ({ ...prev, newPassword: '' }));
                    }
                  }}
                  className={`w-full px-3 py-2 text-[13px] border rounded-lg focus:outline-none focus:ring-2 ${
                    fieldErrors.newPassword
                      ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]'
                      : 'border-[#CBD5E1] focus:ring-[#1D63BD]/20 focus:border-[#1D63BD]'
                  }`}
                />
                {fieldErrors.newPassword ? (
                  <p className="text-[11px] text-[#EF1B24] mt-1 font-medium">{fieldErrors.newPassword}</p>
                ) : (
                  <p className="text-[11px] text-[#657794] mt-1">Must be at least 12 characters.</p>
                )}
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (fieldErrors.confirmPassword) {
                      setFieldErrors((prev) => ({ ...prev, confirmPassword: '' }));
                    }
                  }}
                  className={`w-full px-3 py-2 text-[13px] border rounded-lg focus:outline-none focus:ring-2 ${
                    fieldErrors.confirmPassword
                      ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]'
                      : 'border-[#CBD5E1] focus:ring-[#1D63BD]/20 focus:border-[#1D63BD]'
                  }`}
                />
                {fieldErrors.confirmPassword && (
                  <p className="text-[11px] text-[#EF1B24] mt-1 font-medium">{fieldErrors.confirmPassword}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F1F5F9]">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-[13px] font-medium text-[#475569] hover:bg-[#F1F5F9] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-[13px] font-semibold bg-[#0B2545] text-white hover:bg-[#134074] rounded-lg shadow-sm transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Updating…' : 'Change password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
