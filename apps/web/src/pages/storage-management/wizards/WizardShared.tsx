import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Save } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { useLeaveGuard } from '../../06_AddDataWizard/useLeaveGuard';
import { Banner, DraftChip, WizardHeader, WizardStepper as PillStepper } from '../../historian/hsUi';

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
  /** Wider card for table-heavy steps (columns, bindings, bulk matrix). */
  wide?: boolean;
}

// ============================================================================
// Hook: useWizardDraft
// ============================================================================

/** A saved confirmation must never come back ticked (R2-10): drafts are stored and restored without it. */
function withoutConfirm<T extends object>(d: T): T {
  if (d && typeof d === 'object' && 'confirmed' in (d as Record<string, unknown>)) return { ...d, confirmed: false };
  return d;
}

/** sessionStorage entry: `{v: 2, savedAt, data}`; older entries were the bare wizard data. */
export function readStoredDraft<T extends object>(storageKey: string): { savedAt: string | null; data: T } | null {
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object' && parsed.v === 2 && parsed.data && typeof parsed.data === 'object') {
      return { savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null, data: withoutConfirm(parsed.data as T) };
    }
    if (parsed && typeof parsed === 'object') return { savedAt: null, data: withoutConfirm(parsed as T) };
  } catch {
    // unreadable draft: ignore
  }
  return null;
}

/**
 * Wizard state + "Save draft" in this browser tab. A stored draft is NOT applied silently (R2-10): the wizard
 * starts empty and `pendingDraft` offers "Resume draft / Discard".
 */
export function useWizardDraft<T extends object>(
  storageKey: string,
  initialData: T
) {
  const [data, setData] = React.useState<T>(initialData);
  const [pendingDraft, setPendingDraft] = React.useState<{ savedAt: string | null; data: T } | null>(() => {
    const d = readStoredDraft<T>(storageKey);
    if (!d) return null;
    try {
      return JSON.stringify(d.data) === JSON.stringify(withoutConfirm(initialData)) ? null : d;
    } catch {
      return d;
    }
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
      sessionStorage.setItem(storageKey, JSON.stringify({ v: 2, savedAt: new Date().toISOString(), data: withoutConfirm(data) }));
      setPendingDraft(null);
      const timeStr = new Date().toLocaleTimeString();
      setLastSavedAt(`${timeStr} (this browser tab)`);
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
    setPendingDraft(null);
    setData(initialSnapshot);
    setIsDirty(false);
  }, [storageKey, initialSnapshot]);

  const resetData = React.useCallback((newData: T) => {
    const clean = withoutConfirm(newData);
    setData(clean);
    setInitialSnapshot(clean);
    setIsDirty(false);
  }, []);

  /** Apply the stored draft (the confirmation stays unticked). */
  const resumeDraft = React.useCallback(() => {
    setPendingDraft((p) => {
      if (p) {
        setData((prev) => ({ ...prev, ...p.data }));
        if (p.savedAt) setLastSavedAt(`${new Date(p.savedAt).toLocaleTimeString()} (this browser tab)`);
      }
      return null;
    });
  }, []);

  /** Forget the stored draft without applying it. */
  const discardPendingDraft = React.useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setPendingDraft(null);
  }, [storageKey]);

  return {
    data,
    setData,
    updateField,
    updateData,
    isDirty,
    setIsDirty,
    saveDraft,
    clearDraft,
    setLastSavedAt,
    resetData,
    lastSavedAt,
    pendingDraft,
    resumeDraft,
    discardPendingDraft,
  };
}

/** "A draft from … exists — Resume draft / Discard" (R2-10). */
export const PendingDraftBanner: React.FC<{
  draft: { savedAt: string | null } | null;
  onResume: () => void;
  onDiscard: () => void;
}> = ({ draft, onResume, onDiscard }) => {
  if (!draft) return null;
  const when = draft.savedAt ? new Date(draft.savedAt).toLocaleString() : 'an earlier session of this tab';
  return (
    <div className="mb-4">
      <Banner
        tone="info"
        action={
          <div className="flex gap-2 shrink-0">
            <Button type="button" size="sm" variant="outline" onClick={onResume}>
              Resume draft
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        }
      >
        A draft saved {draft.savedAt ? 'at ' : 'in '}
        {when} exists for this wizard. Resume it, or start fresh. (The confirmation on the Review step is never restored.)
      </Banner>
    </div>
  );
};

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
      title="Leave without saving?"
      message="You have unsaved changes in this wizard. Are you sure you want to leave? Your changes may be lost unless saved as a draft."
      confirmLabel="Discard & leave"
      cancelLabel="Stay"
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
// Component: WizardStepper (Data model wizard pill stepper, shared with hsUi)
// ============================================================================

export const WizardStepper: React.FC<WizardStepperProps> = ({
  steps,
  currentStep,
  onStepClick,
  maxVisitedStep,
}) => (
  <PillStepper
    steps={steps.map((s, i) => (typeof s === 'string' ? { id: `s${i}`, label: s } : { id: s.id || `s${i}`, label: s.label }))}
    current={currentStep}
    onGo={onStepClick}
    maxReachable={maxVisitedStep !== undefined ? Math.max(maxVisitedStep, currentStep) : currentStep}
  />
);

// ============================================================================
// Component: WizardFooter (inside the wizard card, Data model wizard style)
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
  submitLabel = 'Create',
  draftLabel = 'Save draft',
  error,
}) => {
  const isFirst = currentStep === 0;
  const isLast = currentStep === totalSteps - 1;

  return (
    <div className="space-y-3">
      {error && <Banner tone="error">{error}</Banner>}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
        <div className="flex flex-wrap items-center gap-2">
          {!isFirst && (
            <Button type="button" variant="outline" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack} disabled={loading}>
              {backLabel}
            </Button>
          )}
          {onSaveDraft && (
            <>
              <Button type="button" variant="ghost" size="sm" icon={<Save className="w-3.5 h-3.5" />} onClick={onSaveDraft} disabled={loading || !isDirty}>
                {draftLabel}
              </Button>
              {lastSavedAt && <span className="text-[11px] text-[#657794]">Draft saved {lastSavedAt}</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {!isLast ? (
            <Button type="button" variant="primary" size="sm" onClick={onNext} disabled={nextDisabled || loading}>
              {nextLabel} <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button type="button" variant="primary" size="sm" onClick={onSubmit} disabled={submitDisabled || loading} loading={loading} aria-busy={loading}>
              {submitLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

/** Where "Storage Management" back returns: the page the user came from (router state `from`), else `fallback`. */
export function useStorageBackTarget(fallback = '/historian/storage'): string {
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/historian/') ? from : fallback;
}

// ============================================================================
// Component: StorageWizardLayout - Data model wizard layout:
//   back link + title + chip on the left, pill stepper on the right,
//   the step in a card (max-w-3xl, wider for table-heavy steps) with Back / Save draft / Next inside it.
// ============================================================================

export const StorageWizardLayout: React.FC<StorageWizardLayoutProps> = ({
  title,
  subtitle,
  backTo = '/historian/storage',
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
  wide = false,
}) => {
  const navigate = useNavigate();
  const target = useStorageBackTarget(backTo);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const firstRender = React.useRef(true);

  // Move focus to the heading when the step changes (screen readers announce the new step).
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [currentStep]);

  const stepLabel = (i: number) => {
    const s = steps[i];
    return typeof s === 'string' ? s : s?.label || '';
  };

  return (
    <div className="space-y-4">
      <DirtyLeaveGuard isDirty={isDirty} onDiscard={onDiscard} />
      <WizardHeader
        backLabel="Storage Management"
        onBack={() => (onBackClick ? onBackClick() : navigate(target))}
        title={title}
        headingRef={headingRef}
        srStep={`step ${currentStep + 1} of ${steps.length}: ${stepLabel(currentStep)}`}
        chip={badge ?? <DraftChip state={lastSavedAt ? 'draft' : 'new'} />}
        note={
          <>
            {subtitle && <span>{subtitle}</span>}
            {isDirty && <span className="text-amber-700 font-semibold">Unsaved changes</span>}
          </>
        }
        stepper={<WizardStepper steps={steps} currentStep={currentStep} onStepClick={onStepClick} maxVisitedStep={maxVisitedStep} />}
      />

      <section
        aria-label={stepLabel(currentStep)}
        className={`${wide ? 'max-w-6xl' : 'max-w-4xl'} bg-white border border-[#CBD5E1] rounded-xl p-4 sm:p-5 space-y-5 min-w-0`}
      >
        <div className="min-w-0">{children}</div>
        {footer ?? (
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
            nextLabel={currentStep + 1 < steps.length ? `Next: ${stepLabel(currentStep + 1)}` : 'Next'}
            backLabel={currentStep > 0 ? stepLabel(currentStep - 1) : 'Back'}
            submitLabel={submitLabel}
          />
        )}
      </section>
    </div>
  );
};
