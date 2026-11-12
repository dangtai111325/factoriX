import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Save,
  Loader2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { useLeaveGuard } from '../../06_AddDataWizard/useLeaveGuard';

// ============================================================================
// Types
// ============================================================================

export interface WizardStepItem {
  id?: string;
  label: string;
  description?: string;
}

export interface WizardStepperProps {
  steps: (string | WizardStepItem)[];
  currentStep: number;
  onStepClick?: (stepIndex: number) => void;
  maxVisitedStep?: number;
}

export interface WizardFooterProps {
  currentStep: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  onSaveDraft?: () => void;
  nextDisabled?: boolean;
  submitDisabled?: boolean;
  loading?: boolean;
  isDirty?: boolean;
  lastSavedAt?: string | null;
  backLabel?: string;
  nextLabel?: string;
  submitLabel?: string;
  draftLabel?: string;
  error?: string | null;
}

export interface StorageWizardLayoutProps {
  title: string;
  subtitle?: string;
  backTo?: string;
  onBackClick?: () => void;
  badge?: React.ReactNode;
  currentStep: number;
  steps: (string | WizardStepItem)[];
  onStepClick?: (stepIndex: number) => void;
  maxVisitedStep?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  // Footer shortcut props if not passing custom footer element:
  onBack?: () => void;
  onNext?: () => void;
  onSubmit?: () => void;
  onSaveDraft?: () => void;
  nextDisabled?: boolean;
  submitDisabled?: boolean;
  loading?: boolean;
  isDirty?: boolean;
  lastSavedAt?: string | null;
  error?: string | null;
  submitLabel?: string;
  onDiscard?: () => void;
}

// ============================================================================
// Hook: useWizardDraft
// ============================================================================

export function useWizardDraft<T extends object>(
  storageKey: string,
  initialData: T
) {
  const [data, setData] = React.useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // ignore JSON parse error
    }
    return initialData;
  });

  const [initialSnapshot, setInitialSnapshot] = React.useState<T>(() => initialData);
  const [isDirty, setIsDirty] = React.useState(false);
  const [lastSavedAt, setLastSavedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const dirty = JSON.stringify(data) !== JSON.stringify(initialSnapshot);
      setIsDirty(dirty);
    } catch {
      setIsDirty(false);
    }
  }, [data, initialSnapshot]);

  const updateField = React.useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setData((prev) => ({ ...prev, [field]: value }));
  }, []);

  const updateData = React.useCallback((patch: Partial<T> | ((prev: T) => T)) => {
    setData((prev) => (typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }));
  }, []);

  const saveDraft = React.useCallback(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(data));
      const timeStr = new Date().toLocaleTimeString();
      setLastSavedAt(timeStr);
      return true;
    } catch {
      return false;
    }
  }, [storageKey, data]);

  const clearDraft = React.useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setData(initialSnapshot);
    setIsDirty(false);
  }, [storageKey, initialSnapshot]);

  const resetData = React.useCallback((newData: T) => {
    setData(newData);
    setInitialSnapshot(newData);
    setIsDirty(false);
  }, []);

  return {
    data,
    setData,
    updateField,
    updateData,
    isDirty,
    setIsDirty,
    saveDraft,
    clearDraft,
    resetData,
    lastSavedAt,
  };
}

// ============================================================================
// Component: DirtyLeaveGuard
// ============================================================================

export const DirtyLeaveGuard: React.FC<{
  isDirty: boolean;
  onDiscard?: () => void;
}> = ({ isDirty, onDiscard }) => {
  const { pending, proceed, cancel } = useLeaveGuard(isDirty);

  return (
    <ConfirmDialog
      isOpen={!!pending}
      title="Unsaved Changes"
      message="You have unsaved changes in this wizard. Are you sure you want to leave? Your changes may be lost unless saved as a draft."
      confirmLabel="Discard & Leave"
      cancelLabel="Stay on Page"
      variant="danger"
      onConfirm={() => {
        onDiscard?.();
        proceed();
      }}
      onCancel={cancel}
    />
  );
};

// ============================================================================
// Component: WizardStepper
// ============================================================================

export const WizardStepper: React.FC<WizardStepperProps> = ({
  steps,
  currentStep,
  onStepClick,
  maxVisitedStep,
}) => {
  const effectiveMaxVisited = maxVisitedStep !== undefined ? maxVisitedStep : currentStep;

  return (
    <div className="w-full py-3">
      <div className="flex items-center justify-between relative">
        {/* Background track */}
        <div className="absolute top-4 left-6 right-6 h-0.5 bg-[#E3EAF3] -z-0" />

        {steps.map((step, idx) => {
          const label = typeof step === 'string' ? step : step.label;
          const description = typeof step === 'string' ? undefined : step.description;
          const isCompleted = idx < currentStep;
          const isCurrent = idx === currentStep;
          const isClickable = onStepClick && idx <= effectiveMaxVisited && idx !== currentStep;

          return (
            <div
              key={idx}
              className={`flex-1 flex flex-col items-center relative z-10 ${
                isClickable ? 'cursor-pointer group' : 'cursor-default'
              }`}
              onClick={() => {
                if (isClickable) onStepClick(idx);
              }}
            >
              {/* Step indicator circle */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold transition-all duration-200 ${
                  isCompleted
                    ? 'bg-[#0DBA67] text-white shadow-xs'
                    : isCurrent
                    ? 'bg-[#EF1B24] text-white shadow-sm ring-4 ring-[#FEE2E2]'
                    : 'bg-white text-[#657794] border border-[#D4DFEC]'
                } ${isClickable ? 'group-hover:scale-105' : ''}`}
              >
                {isCompleted ? <Check className="w-4 h-4 stroke-[2.5]" /> : <span>{idx + 1}</span>}
              </div>

              {/* Step Label */}
              <div className="mt-2 text-center">
                <div
                  className={`text-[12px] font-semibold transition-colors ${
                    isCurrent
                      ? 'text-[#EF1B24]'
                      : isCompleted
                      ? 'text-[#111B37]'
                      : 'text-[#657794]'
                  } ${isClickable ? 'group-hover:text-[#111B37]' : ''}`}
                >
                  {label}
                </div>
                {description && (
                  <div className="text-[11px] text-[#8C9BAE] hidden sm:block max-w-[120px] truncate">
                    {description}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ============================================================================
// Component: WizardFooter
// ============================================================================

export const WizardFooter: React.FC<WizardFooterProps> = ({
  currentStep,
  totalSteps,
  onBack,
  onNext,
  onSubmit,
  onSaveDraft,
  nextDisabled = false,
  submitDisabled = false,
  loading = false,
  isDirty = false,
  lastSavedAt,
  backLabel = 'Back',
  nextLabel = 'Next',
  submitLabel = 'Publish',
  draftLabel = 'Save Draft',
  error,
}) => {
  const isFirst = currentStep === 0;
  const isLast = currentStep === totalSteps - 1;

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-center gap-2 p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-[13px] text-[#EF1B24]">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        {/* Left: Back + Save Draft */}
        <div className="flex items-center gap-2.5">
          {!isFirst && (
            <Button
              type="button"
              variant="outline"
              size="md"
              icon={<ArrowLeft className="w-4 h-4" />}
              onClick={onBack}
              disabled={loading}
            >
              {backLabel}
            </Button>
          )}

          {onSaveDraft && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="md"
                icon={<Save className="w-4 h-4" />}
                onClick={onSaveDraft}
                disabled={loading || !isDirty}
              >
                {draftLabel}
              </Button>
              {lastSavedAt && (
                <span className="text-[11px] text-[#8C9BAE] hidden sm:inline">
                  Draft saved {lastSavedAt}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: Next or Submit */}
        <div className="flex items-center gap-2">
          {!isLast ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={onNext}
              disabled={nextDisabled || loading}
            >
              <span>{nextLabel}</span>
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={onSubmit}
              disabled={submitDisabled || loading}
              loading={loading}
            >
              {submitLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Component: StorageWizardLayout
// ============================================================================

export const StorageWizardLayout: React.FC<StorageWizardLayoutProps> = ({
  title,
  subtitle,
  backTo = '/historian/storage?tab=objects',
  onBackClick,
  badge,
  currentStep,
  steps,
  onStepClick,
  maxVisitedStep,
  children,
  footer,
  onBack,
  onNext,
  onSubmit,
  onSaveDraft,
  nextDisabled = false,
  submitDisabled = false,
  loading = false,
  isDirty = false,
  lastSavedAt,
  error,
  submitLabel,
  onDiscard,
}) => {
  const navigate = useNavigate();

  const handleHeaderBack = () => {
    if (onBackClick) {
      onBackClick();
    } else {
      navigate(backTo);
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F8FC] flex flex-col justify-between">
      {/* Dirty leave blocker */}
      <DirtyLeaveGuard isDirty={isDirty} onDiscard={onDiscard} />

      {/* Sticky Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-[#E3EAF3] shadow-xs">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleHeaderBack}
                className="p-1.5 rounded-lg border border-[#D4DFEC] hover:bg-[#F9FAFD] text-[#334568] transition-colors"
                title="Back to Storage Management"
                aria-label="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[17px] font-bold text-[#111B37] tracking-tight">{title}</h1>
                  {badge}
                </div>
                {subtitle && <p className="text-[12px] text-[#657794] mt-0.5">{subtitle}</p>}
              </div>
            </div>

            <div className="text-[12px] font-medium text-[#657794] hidden sm:block">
              Step <span className="font-bold text-[#111B37]">{currentStep + 1}</span> of{' '}
              <span className="font-bold text-[#111B37]">{steps.length}</span>
            </div>
          </div>

          {/* Stepper bar */}
          <div className="mt-2 pt-2 border-t border-[#F1F5FA]">
            <WizardStepper
              steps={steps}
              currentStep={currentStep}
              onStepClick={onStepClick}
              maxVisitedStep={maxVisitedStep}
            />
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-[#E3EAF3] shadow-xs p-6 sm:p-8">
          {children}
        </div>
      </main>

      {/* Sticky Footer */}
      <footer className="sticky bottom-0 z-20 bg-white/95 backdrop-blur-sm border-t border-[#E3EAF3] shadow-lg">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5">
          {footer ? (
            footer
          ) : (
            <WizardFooter
              currentStep={currentStep}
              totalSteps={steps.length}
              onBack={onBack || (() => {})}
              onNext={onNext || (() => {})}
              onSubmit={onSubmit || (() => {})}
              onSaveDraft={onSaveDraft}
              nextDisabled={nextDisabled}
              submitDisabled={submitDisabled}
              loading={loading}
              isDirty={isDirty}
              lastSavedAt={lastSavedAt}
              error={error}
              submitLabel={submitLabel}
            />
          )}
        </div>
      </footer>
    </div>
  );
};
