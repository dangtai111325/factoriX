import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Database,
  Layers,
  Table,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  HardDrive,
  Cpu,
  Radio,
  FileCode,
} from 'lucide-react';
import { StorageWizardLayout, useWizardDraft, useStorageBackTarget, PendingDraftBanner } from './WizardShared';
import { Button } from '../../../components/common/Button';
import { ActionToast, useActionToast } from '../../../components/common/ActionToast';
import { WizardHeader, DraftChip, Banner } from '../../historian/hsUi';
import { databaseIntent, draftNameFor, draftSpecFor, ServerDraftRef, stableIntent, subtableIntent, wizardDataFromSpec, WizardKind } from './serverDrafts';
import {
  DatabaseBasicsStep,
  DatabaseSettingsStep,
  DatabaseReviewStep,
  DatabaseWizardData,
  DB_NAME_REGEX,
} from './DatabaseWizardSteps';
import {
  StableTargetStep,
  StableColumnsStep,
  StableTagsStep,
  StableSourceMappingStep,
  StableRecordingStep,
  StableReviewStep,
  StableWizardData,
  splitTagType,
  TAG_MAX_LENGTH,
} from './StableWizardSteps';
import {
  SubtableIdentityStep,
  SubtableTagValuesStep,
  SubtableBindSourcesStep,
  SubtableRowAssemblyStep,
  SubtableReviewStep,
  SubtableWizardData,
} from './SubtableWizardSteps';
import { ApiError } from '../../../api/client';
import {
  createDatabase,
  createStable,
  createSubtable,
  getOperation,
  getStable,
  getStorageObject,
  getStorageDraft,
  createStorageDraft,
  patchStorageDraft,
  publishStorageDraft,
  StorageDraftItem,
  TDStable,
  StorageOperation,
  ColumnDefinition,
  TagDefinition,
  RecordingMode,
  RowAssemblyPolicy,
} from '../../../lib/storagePhysicalApi';

// ============================================================================
// Initial Values
// ============================================================================

const INITIAL_DB_DATA: DatabaseWizardData = {
  physical_name: '',
  display_name: '',
  description: '',
  precision: 'us',
  retention_days: null,
  vgroups: null,
  cache_mb: null,
  confirmed: false,
};

const INITIAL_STABLE_DATA: StableWizardData = {
  database_name: '',
  physical_name: '',
  display_name: '',
  description: '',
  columns: [
    { name: 'ts', td_type: 'TIMESTAMP', nullable: false, immutable: true },
    { name: 'value', td_type: 'DOUBLE', nullable: true },
  ],
  tags: [
    { name: 'machine_ref', td_type: 'VARCHAR(36)' },
  ],
  source_mapping_template: [],
  default_recording_mode: 'ON_CHANGE',
  retention_days: null,
  max_checkpoint_interval: null,
  late_tolerance: 10,
  skip_source_mapping: true,
  confirmed: false,
};

const INITIAL_SUBTABLE_DATA: SubtableWizardData = {
  stable_id: '',
  stable_name: '',
  database_name: '',
  physical_name: '',
  display_name: '',
  description: '',
  tag_values: [],
  bindings: [],
  row_assembly_policy: 'INDEPENDENT_EVENTS',
  recording_mode: 'ON_CHANGE',
  max_age_seconds: 5,
  time_bucket_seconds: 5,
  start_recording: false,
  no_binding: false,
  confirmed: false,
};

/** Human message of a failed create: server message + field errors (R1-04 / R1-27). */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const details = (err as unknown as { details?: { field_errors?: { field?: string; message: string }[] } }).details;
    const fieldErrors = details?.field_errors || [];
    const extra = fieldErrors.filter((f) => f.message && f.message !== err.message).slice(0, 5)
      .map((f) => `${f.field ? `${f.field}: ` : ''}${f.message}`);
    return [err.message, ...extra].join(' \u2022 ');
  }
  return err instanceof Error ? err.message : 'An error occurred during submission.';
}

// ============================================================================
// Helper: Poll Operation until terminal
// ============================================================================

async function pollOperationUntilTerminal(
  operationId: string,
  onStatusChange: (op: StorageOperation) => void
): Promise<StorageOperation> {
  const pollInterval = 2000;
  const maxAttempts = 30; // 60s timeout

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const op = await getOperation(operationId);
    onStatusChange(op);

    if (op.status === 'APPLIED' || (op.status as any) === 'COMPLETED' || op.status === 'FAILED' || op.status === 'CANCELLED') {
      return op;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error('Operation timed out waiting for completion.');
}

// ============================================================================
// Main Component
// ============================================================================

export const CreateStorageObjectWizard: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const kind = searchParams.get('kind'); // 'database' | 'stable' | 'subtable'
  const backTarget = useStorageBackTarget('/historian/storage');
  const { toast, show: showToast, dismiss: dismissToast } = useActionToast();

  // Wizard Step index
  const [currentStep, setCurrentStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Operation In-Progress State
  const [activeOperation, setActiveOperation] = useState<StorageOperation | null>(null);
  const [created, setCreated] = useState<{ kind: string; name: string; objectId: string } | null>(null);

  // Database wizard state
  const dbDraft = useWizardDraft<DatabaseWizardData>('fx_wizard_draft_database', INITIAL_DB_DATA);

  // Supertable wizard state
  const stableDraft = useWizardDraft<StableWizardData>('fx_wizard_draft_stable', INITIAL_STABLE_DATA);

  // Subtable wizard state
  const subtableDraft = useWizardDraft<SubtableWizardData>('fx_wizard_draft_subtable', INITIAL_SUBTABLE_DATA);
  // ---- server draft (D5 / H14): ?draft=<id> reopens it; "Save draft" keeps it on the server
  const location = useLocation();
  const draftParam = searchParams.get('draft');
  const [serverDraft, setServerDraft] = useState<ServerDraftRef | null>(null);
  const [draftState, setDraftState] = useState<{ loading: boolean; error: string | null; opened: string | null }>({ loading: false, error: null, opened: null });
  const wizardFor = (k: string | null) => (k === 'database' ? dbDraft : k === 'stable' ? stableDraft : subtableDraft);
  useEffect(() => {
    if (!draftParam) {
      setServerDraft(null);
      return;
    }
    if (serverDraft?.id === draftParam) return; // just created by "Save draft"
    let active = true;
    setDraftState({ loading: true, error: null, opened: null });
    const fromList = (location.state as { draft?: StorageDraftItem } | null)?.draft;
    getStorageDraft(draftParam)
      .catch((err: unknown) => {
        // Older Center without GET /td/drafts/{id}: the Drafts list already carried the spec.
        if (fromList && fromList.id === draftParam) return fromList;
        throw err;
      })
      .then((d) => {
        if (!active) return;
        const k = (d.object_kind || kind || 'stable') as WizardKind;
        if (kind !== k) {
          const next = new URLSearchParams(searchParams);
          next.set('kind', k);
          setSearchParams(next, { replace: true, state: location.state });
        }
        const w = wizardFor(k);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (w.resetData as (x: any) => void)(wizardDataFromSpec(k, (d.spec || {}) as Record<string, unknown>, w.data as never));
        setServerDraft({ id: d.id, revision: Number(d.revision || 1), name: d.name, updatedAt: d.updated_at });
        setDraftState({ loading: false, error: null, opened: `${d.name}${d.updated_at ? ` (saved ${new Date(d.updated_at).toLocaleString()})` : ''}` });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setDraftState({ loading: false, error: `Could not open the draft: ${describeError(err)}`, opened: null });
      });
    return () => { active = false; };
  }, [draftParam]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Save draft: on the server (create, then PATCH with the revision lock) and in this tab as a fallback. */
  const saveDraft = async () => {
    const k = (kind || 'stable') as WizardKind;
    const w = wizardFor(k);
    w.saveDraft();
    const spec = draftSpecFor(k, w.data as never);
    const name = draftNameFor(k, w.data as never);
    try {
      const saved = serverDraft
        ? await patchStorageDraft(serverDraft.id, { revision: serverDraft.revision, name, spec })
        : await createStorageDraft({ kind: k, name, spec });
      setServerDraft({ id: saved.id, revision: Number(saved.revision || 1), name: saved.name, updatedAt: saved.updated_at });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w.resetData as (x: any) => void)(w.data);
      w.setLastSavedAt(`${new Date().toLocaleTimeString()} on the server`);
      setDraftState((s0) => ({ ...s0, error: null }));
      if (!draftParam) {
        const next = new URLSearchParams(searchParams);
        next.set('draft', saved.id);
        setSearchParams(next, { replace: true });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      setDraftState((s0) => ({
        ...s0,
        error:
          status === 409
            ? 'This draft was changed elsewhere since you opened it. Reload the page to get the latest version (your edits are kept in this tab).'
            : `Saved in this browser tab only; the server did not keep the draft (${describeError(err)}).`,
      }));
    }
  };

  /** Create from a server draft: write the current input into it (revision lock), then publish it. */
  const publishFromDraft = async (k: WizardKind, data: unknown): Promise<StorageOperation> => {
    if (!serverDraft) throw new Error('No server draft');
    const saved = await patchStorageDraft(serverDraft.id, { revision: serverDraft.revision, name: draftNameFor(k, data as never), spec: draftSpecFor(k, data as never) });
    setServerDraft({ id: saved.id, revision: Number(saved.revision || 1), name: saved.name, updatedAt: saved.updated_at });
    const res = await publishStorageDraft(serverDraft.id);
    return {
      id: res.operation_id,
      status: res.status,
      object_name: res.object_key || saved.name,
      object_key: res.object_key,
      error_message: res.error_message,
    } as unknown as StorageOperation;
  };

  const draftNotice =
    draftState.loading || draftState.error || (serverDraft && draftState.opened) ? (
      <div className="mb-4">
        {draftState.loading ? (
          <Banner tone="info">Opening the saved draft…</Banner>
        ) : draftState.error ? (
          <Banner tone={draftState.error.startsWith('Saved in this browser') ? 'warning' : 'error'} onClose={() => setDraftState((s0) => ({ ...s0, error: null }))}>
            {draftState.error}
          </Banner>
        ) : (
          <Banner tone="info" onClose={() => setDraftState((s0) => ({ ...s0, opened: null }))}>
            Reopened the server draft <span className="font-mono font-semibold">{draftState.opened}</span>. “Save draft” updates it; “Create” publishes it.
          </Banner>
        )}
      </div>
    ) : null;

  const [parentStable, setParentStable] = useState<TDStable | null>(null);
  const stableId = subtableDraft.data.stable_id;
  const updateSubtableDraft = subtableDraft.updateData;

  // When subtable parent STable changes, load its full details
  useEffect(() => {
    if (kind !== 'subtable' || !stableId) {
      setParentStable(null);
      return;
    }

    let active = true;
    getStable(stableId)
      .then((stable) => {
        if (!active) return;
        setParentStable(stable);
        updateSubtableDraft((draft) => {
          if (draft.stable_id !== stableId) return draft;
          const previousValues = new Map(draft.tag_values.map((tag) => [tag.tag_name, tag.value]));
          return {
            ...draft,
            tag_values: stable.tags.map((tag) => ({ tag_name: tag.name, value: previousValues.get(tag.name) ?? '' })),
          };
        });
      })
      .catch(() => {});

    return () => { active = false; };
  }, [kind, stableId, updateSubtableDraft]);

  // "Resume" in the Drafts dialog (?resume=1) is an explicit choice: apply that tab draft once.
  const resumeParam = searchParams.get('resume');
  useEffect(() => {
    if (!resumeParam || draftParam) return;
    const w = kind === 'database' ? dbDraft : kind === 'stable' ? stableDraft : kind === 'subtable' ? subtableDraft : null;
    w?.resumeDraft();
    const next = new URLSearchParams(searchParams);
    next.delete('resume');
    setSearchParams(next, { replace: true, state: location.state });
  }, [resumeParam, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset step index when kind changes
  useEffect(() => {
    setCurrentStep(0);
    setErrors({});
    setSubmitError(null);
    setCreated(null);
  }, [kind]);

  // "New Subtable" from a supertable passes ?stable=<db>.<stable>: preselect it (review §1.5).
  // Duplicate (?duplicate=<object id>): start a new object from an existing one — the copy gets a
  // new name; for a subtable the same parent and machine/line tags, the field binding is cleared.
  const duplicateParam = searchParams.get('duplicate');
  useEffect(() => {
    if (!duplicateParam || (kind !== 'stable' && kind !== 'subtable')) return;
    let active = true;
    getStorageObject(duplicateParam)
      .then((obj) => {
        if (!active) return;
        const o = obj as unknown as Record<string, any>;
        if (kind === 'stable' && Array.isArray(o.columns)) {
          stableDraft.updateData((d) => ({
            ...d,
            database_name: o.database_name || d.database_name,
            physical_name: `${o.physical_name}_copy`.slice(0, 63),
            display_name: o.display_name ? `${o.display_name} (copy)` : '',
            description: o.description || '',
            columns: o.columns.map((c: any, i: number) => ({
              name: c.name, td_type: String(c.td_type || '').toUpperCase(), length: c.length ?? null,
              nullable: i !== 0, immutable: i === 0, primary_key: i === 1 && !!c.primary_key,
            })),
            tags: (o.tags || []).map((t: any) => ({ name: t.name, td_type: t.length ? `${String(t.td_type).toUpperCase()}(${t.length})` : String(t.td_type).toUpperCase() })),
            confirmed: false,
          }));
        }
        if (kind === 'subtable' && o.stable_name) {
          const stableRef = `${o.database_name}.${o.stable_name}`;
          subtableDraft.updateData((d) => ({
            ...d,
            stable_id: stableRef,
            stable_name: o.stable_name,
            database_name: o.database_name,
            physical_name: '',
            display_name: '',
            description: o.description || '',
            tag_values: (o.tag_values || []).map((t: any) => ({ tag_name: t.name, value: t.name === 'field_key' ? '' : String(t.value ?? '') })),
            bindings: [],
            no_binding: false,
            recording_mode: (o.recording?.mode as RecordingMode) || 'ON_CHANGE',
            confirmed: false,
          }));
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [duplicateParam, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const stableParam = searchParams.get('stable');
  useEffect(() => {
    if (kind !== 'subtable' || !stableParam || !stableParam.includes('.')) return;
    const [db, st] = stableParam.split('.', 2);
    updateSubtableDraft((draft) => (draft.stable_id === stableParam ? draft : {
      ...draft, stable_id: stableParam, stable_name: st, database_name: db, tag_values: [], bindings: [],
    }));
  }, [kind, stableParam, updateSubtableDraft]);

  // Clear the stale error banner as soon as the user edits again (R1-27).
  useEffect(() => { setSubmitError(null); }, [currentStep]);

  // Handle operation polling execution
  const executeWithPolling = async (opPromise: Promise<StorageOperation>) => {
    setSubmitting(true);
    setSubmitError(null);

    const finish = (op: StorageOperation) => {
      const key = String((op as unknown as { object_key?: string }).object_key || op.object_name || '');
      const objectId = kind === 'database' ? `db:${key}` : `${kind}:${key}`;
      setCreated({ kind: kind || 'object', name: key, objectId });
      setServerDraft(null);
      if (draftParam) {
        const next = new URLSearchParams(searchParams);
        next.delete('draft');
        setSearchParams(next, { replace: true });
      }
      const noun = kind === 'stable' ? 'supertable' : kind || 'object';
      showToast({
        tone: 'success',
        message: `Created ${noun} ${key.split('.').pop() || key}`,
        action: { label: 'View', run: () => navigate(`/historian/storage/object/${encodeURIComponent(objectId)}`) },
      });
      setSubmitting(false);
      setActiveOperation(null);
    };
    try {
      const initialOp = await opPromise;
      if (!initialOp || !initialOp.id) {
        navigate(backTarget);
        return;
      }

      // The backend saga is synchronous: APPLIED means DDL, read-back and registry all succeeded.
      if (initialOp.status === 'APPLIED') {
        finish(initialOp);
        return;
      }

      if (initialOp.status === 'FAILED') {
        setSubmitError(initialOp.error_message || 'Physical object creation failed in TDengine.');
        setSubmitting(false);
        return;
      }

      // Poll until terminal
      setActiveOperation(initialOp);
      const terminalOp = await pollOperationUntilTerminal(initialOp.id, (updated) => {
        setActiveOperation(updated);
      });

      if (terminalOp.status === 'APPLIED') {
        finish(terminalOp);
      } else {
        setSubmitError(terminalOp.error_message || 'Operation failed during execution.');
        setSubmitting(false);
        setActiveOperation(null);
      }
    } catch (err: unknown) {
      setSubmitError(describeError(err));
      setSubmitting(false);
      setActiveOperation(null);
    }
  };

  // ==========================================================================
  // Database Wizard Handlers
  // ==========================================================================

  const DB_STEPS = ['Name', 'Settings', 'Review'];

  const validateDbStep = (step: number): boolean => {
    const errs: Record<string, string> = {};
    if (step === 0) {
      if (!dbDraft.data.physical_name) {
        errs.physical_name = 'Database name is required.';
      } else if (!DB_NAME_REGEX.test(dbDraft.data.physical_name)) {
        errs.physical_name =
          'Must start with a letter and contain only lowercase letters, digits, and underscores (max 63 chars).';
      }
    } else if (step === 1) {
      if (!dbDraft.data.precision) {
        errs.precision = 'Timestamp precision is required.';
      }
      if (dbDraft.data.retention_days != null) {
        if (dbDraft.data.retention_days < 30) {
          errs.retention_days =
            'Retention days must be at least 30 days (TDengine requires KEEP >= 3 x DURATION).';
        } else if (!Number.isInteger(dbDraft.data.retention_days) || dbDraft.data.retention_days > 365000) {
          errs.retention_days = 'Enter a whole number of days up to 365,000.';
        }
      }
    } else if (step === 2) {
      if (!dbDraft.data.confirmed) {
        errs.confirmed = 'You must confirm before creating the physical database.';
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleDbNext = () => {
    if (validateDbStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, DB_STEPS.length - 1));
    }
  };

  const handleDbSubmit = () => {
    if (!validateDbStep(2)) return;

    executeWithPolling(
      (serverDraft ? publishFromDraft('database', dbDraft.data) : createDatabase(databaseIntent(dbDraft.data))).then((res) => {
        dbDraft.clearDraft();
        return res;
      })
    );
  };

  // ==========================================================================
  // Supertable Wizard Handlers
  // ==========================================================================

  const STABLE_STEPS = ['Name', 'Columns', 'Tags', 'Source mapping', 'Recording', 'Review'];

  const validateStableStep = (step: number): boolean => {
    const errs: Record<string, string> = {};
    if (step === 0) {
      if (!stableDraft.data.database_name) {
        errs.database_name = 'Please select a target database.';
      }
      if (!stableDraft.data.physical_name) {
        errs.physical_name = 'Supertable name is required.';
      } else if (!DB_NAME_REGEX.test(stableDraft.data.physical_name)) {
        errs.physical_name =
          'Must start with a letter and contain only lowercase letters, digits, and underscores.';
      }
    } else if (step === 1) {
      if (!stableDraft.data.columns || stableDraft.data.columns.length === 0) {
        errs.columns = 'At least one column is required.';
      } else {
        const names = new Set<string>();
        for (const col of stableDraft.data.columns) {
          if (!col.name) {
            errs.columns = 'All columns must have a valid identifier.';
            break;
          }
          if (names.has(col.name)) {
            errs.columns = `Duplicate column name "${col.name}".`;
            break;
          }
          names.add(col.name);
        }
      }
    } else if (step === 2) {
      if (!stableDraft.data.tags || stableDraft.data.tags.length === 0) {
        errs.tags = 'TDengine requires at least one tag per Supertable.';
      } else {
        const tagNames = new Set<string>();
        for (const t of stableDraft.data.tags) {
          if (!t.name) {
            errs.tags = 'All tags must have a valid identifier.';
            break;
          }
          if (tagNames.has(t.name)) {
            errs.tags = `Duplicate tag name "${t.name}".`;
            break;
          }
          const len = splitTagType(t.td_type, t.length).length;
          if (len != null && (len < 1 || len > TAG_MAX_LENGTH)) {
            errs.tags = `Tag "${t.name}": length must be between 1 and ${TAG_MAX_LENGTH}.`;
            break;
          }
          tagNames.add(t.name);
        }
      }
    } else if (step === 5) {
      if (!stableDraft.data.confirmed) {
        errs.confirmed = 'You must confirm before deploying the Supertable.';
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleStableNext = () => {
    if (validateStableStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, STABLE_STEPS.length - 1));
    }
  };

  const handleStableSubmit = () => {
    if (!validateStableStep(5)) return;

    executeWithPolling(
      (serverDraft ? publishFromDraft('stable', stableDraft.data) : createStable(stableIntent(stableDraft.data))).then((res) => {
        stableDraft.clearDraft();
        return res;
      })
    );
  };

  // ==========================================================================
  // Subtable Wizard Handlers
  // ==========================================================================

  const SUBTABLE_STEPS = ['Name', 'Tag values', 'Bind field', 'How rows are written', 'Review'];

  const validateSubtableStep = (step: number): boolean => {
    const errs: Record<string, string> = {};
    if (step === 0) {
      if (!subtableDraft.data.stable_id) {
        errs.stable_id = 'Please select a parent Supertable.';
      }
      if (!subtableDraft.data.physical_name) {
        errs.physical_name = 'Subtable name is required.';
      } else if (!DB_NAME_REGEX.test(subtableDraft.data.physical_name)) {
        errs.physical_name =
          'Must start with a letter and contain only lowercase letters, digits, and underscores.';
      }
    } else if (step === 1) {
      // Check if all tags have values
      if (parentStable?.tags) {
        for (const t of parentStable.tags) {
          const val = subtableDraft.data.tag_values.find((tv) => tv.tag_name === t.name)?.value;
          if (!val || !val.trim()) {
            errs.tag_values = `Please specify a value for tag "${t.name}".`;
            break;
          }
        }
      }
    } else if (step === 2) {
      if (subtableDraft.data.bindings.length === 0 && !subtableDraft.data.no_binding) {
        errs.bindings = 'Bind a Data Model field, or tick "Create this subtable without a binding".';
      }
    } else if (step === 4) {
      if (!subtableDraft.data.confirmed) {
        errs.confirmed = 'You must confirm before creating the subtable.';
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubtableNext = () => {
    if (validateSubtableStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, SUBTABLE_STEPS.length - 1));
    }
  };

  const handleSubtableSubmit = () => {
    if (!validateSubtableStep(4)) return;

    executeWithPolling(
      serverDraft
        ? publishFromDraft('subtable', subtableDraft.data)
        : createSubtable(subtableIntent(subtableDraft.data) as unknown as Parameters<typeof createSubtable>[0])
    );
  };

  // ==========================================================================
  // Render: Object Selection Page (when no ?kind is specified)
  // ==========================================================================

  if (!kind || !['database', 'stable', 'subtable'].includes(kind)) {
    const cards = [
      { k: 'database', icon: <Database className="w-5 h-5" />, title: 'Database', text: 'A TDengine database with its own timestamp precision and retention (KEEP). Usually one is enough.' },
      { k: 'stable', icon: <Layers className="w-5 h-5" />, title: 'Supertable', text: 'The shared schema (columns + tags) for a family of identical tables, e.g. one per field and machine.' },
      { k: 'subtable', icon: <Table className="w-5 h-5" />, title: 'Subtable', text: 'One table of a supertable with its tag values, bound to a Data Model field that it records.' },
    ];
    return (
      <div className="space-y-4">
        <WizardHeader backLabel="Storage Management" onBack={() => navigate(backTarget)} title="Create storage object" chip={<DraftChip state="new" />} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl">
          {cards.map((c) => (
            <div key={c.k} className="bg-white border border-[#CBD5E1] rounded-xl p-5 flex flex-col justify-between gap-4">
              <div>
                <div className="w-10 h-10 rounded-xl bg-[#EEF5FF] text-[#134074] flex items-center justify-center mb-3">{c.icon}</div>
                <h2 className="text-[15px] font-bold text-[#111B37]">{c.title}</h2>
                <p className="text-[13px] text-[#657794] mt-1.5 leading-relaxed">{c.text}</p>
              </div>
              <Button variant="outline" size="md" onClick={() => setSearchParams({ kind: c.k })}>
                Create {c.title.toLowerCase()} <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="max-w-5xl text-[12px] text-[#657794]">
          Many subtables at once? Use{' '}
          <button type="button" className="font-semibold text-[#2A82E7] hover:underline" onClick={() => navigate('/historian/storage/bulk')}>
            Subtables from Data Models
          </button>
          .
        </div>
      </div>
    );
  }

  // ==========================================================================
  // Render: Active Operation Polling Overlay Modal
  // ==========================================================================

  const renderOperationModal = () => {
    if (!activeOperation) return null;

    return (
      <div className="fixed inset-0 z-50 bg-[#111B37]/40 backdrop-blur-xs flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl border border-[#E3EAF3] shadow-2xl max-w-md w-full p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-[#657794] animate-spin flex-shrink-0" />
            <div>
              <h3 className="text-[16px] font-bold text-[#111B37]">
                Creating in TDengine…
              </h3>
              <p className="text-[12px] text-[#657794]">
                The object is created, read back and registered. This takes a few seconds.
              </p>
            </div>
          </div>

          <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-[#657794]">Operation ID:</span>
              <span className="font-mono text-[#111B37]">{activeOperation.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#657794]">Target Object:</span>
              <span className="font-mono font-bold text-[#111B37]">{activeOperation.object_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#657794]">Status:</span>
              <span className="font-semibold text-[#111B37]">{activeOperation.status}</span>
            </div>
          </div>

          <p className="text-[11px] text-[#657794] text-center">
            Polling status every 2 seconds. Please do not close your browser.
          </p>
        </div>
      </div>
    );
  };

  if (created) {
    const again = () => {
      setCreated(null);
      setCurrentStep(0);
      if (kind === 'subtable') {
        // Keep parent, mode and tag values of the same machine/line; clear name, field and binding.
        subtableDraft.updateData((d) => ({
          ...d, physical_name: '', display_name: '', description: '', bindings: [], no_binding: false, confirmed: false,
          tag_values: d.tag_values.map((t) => (t.tag_name === 'field_key' ? { ...t, value: '' } : t)),
        }));
      } else if (kind === 'stable') {
        stableDraft.clearDraft();
      } else {
        dbDraft.clearDraft();
      }
    };
    return (
      <div className="space-y-4">
        <ActionToast toast={toast} onDismiss={dismissToast} />
        <WizardHeader backLabel="Storage Management" onBack={() => navigate(backTarget)} title={`Created ${created.kind === 'stable' ? 'supertable' : created.kind}`} chip={<DraftChip state="saved" />} />
        <section className="max-w-3xl bg-white border border-[#CBD5E1] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-[#0DBA67] shrink-0" />
            <p className="text-[14px] font-bold text-[#111B37] font-mono break-all">{created.name}</p>
          </div>
          <p className="text-[13px] text-[#334568]">The object exists in TDengine, its schema and tags were read back, and it is registered.</p>
          <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
            <Button variant="primary" size="sm" onClick={again}>Create another</Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/historian/storage/object/${encodeURIComponent(created.objectId)}`, { state: { from: backTarget } })}>
              Open {created.kind === 'stable' ? 'supertable' : created.kind}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate(backTarget)}>Back to Storage Management</Button>
          </div>
        </section>
      </div>
    );
  }

  // ==========================================================================
  // Render: Kind === 'database'
  // ==========================================================================

  if (kind === 'database') {
    return (
      <>
        {renderOperationModal()}
        <ActionToast toast={toast} onDismiss={dismissToast} />
        <StorageWizardLayout
          title="Create database"
          subtitle="Timestamp precision and retention of a new TDengine database."
          currentStep={currentStep}
          steps={DB_STEPS}
          onStepClick={(step) => {
            if (step < currentStep || validateDbStep(currentStep)) {
              setCurrentStep(step);
            }
          }}
          onBack={() => setCurrentStep((prev) => Math.max(prev - 1, 0))}
          onNext={handleDbNext}
          onSubmit={handleDbSubmit}
          onSaveDraft={() => void saveDraft()}
          badge={serverDraft ? <DraftChip state="draft" label={`Server draft · revision ${serverDraft.revision}`} /> : undefined}
          isDirty={dbDraft.isDirty}
          lastSavedAt={dbDraft.lastSavedAt}
          loading={submitting}
          error={submitError}
          submitLabel="Create database"
        >
          {draftNotice}
          {!draftParam && <PendingDraftBanner draft={dbDraft.pendingDraft} onResume={dbDraft.resumeDraft} onDiscard={dbDraft.discardPendingDraft} />}
          {currentStep === 0 && (
            <DatabaseBasicsStep
              data={dbDraft.data}
              onChange={dbDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 1 && (
            <DatabaseSettingsStep
              data={dbDraft.data}
              onChange={dbDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 2 && (
            <DatabaseReviewStep
              data={dbDraft.data}
              onChange={dbDraft.updateData}
              errors={errors}
            />
          )}
        </StorageWizardLayout>
      </>
    );
  }

  // ==========================================================================
  // Render: Kind === 'stable'
  // ==========================================================================

  if (kind === 'stable') {
    return (
      <>
        {renderOperationModal()}
        <ActionToast toast={toast} onDismiss={dismissToast} />
        <StorageWizardLayout
          wide={currentStep === 1 || currentStep === 3 || currentStep === 5}
          title="Create supertable"
          subtitle="Columns and tags shared by a family of subtables."
          currentStep={currentStep}
          steps={STABLE_STEPS}
          onStepClick={(step) => {
            if (step < currentStep || validateStableStep(currentStep)) {
              setCurrentStep(step);
            }
          }}
          onBack={() => setCurrentStep((prev) => Math.max(prev - 1, 0))}
          onNext={handleStableNext}
          onSubmit={handleStableSubmit}
          onSaveDraft={() => void saveDraft()}
          badge={serverDraft ? <DraftChip state="draft" label={`Server draft · revision ${serverDraft.revision}`} /> : undefined}
          isDirty={stableDraft.isDirty}
          lastSavedAt={stableDraft.lastSavedAt}
          loading={submitting}
          error={submitError}
          submitLabel="Create supertable"
        >
          {draftNotice}
          {!draftParam && <PendingDraftBanner draft={stableDraft.pendingDraft} onResume={stableDraft.resumeDraft} onDiscard={stableDraft.discardPendingDraft} />}
          {currentStep === 0 && (
            <StableTargetStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 1 && (
            <StableColumnsStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 2 && (
            <StableTagsStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 3 && (
            <StableSourceMappingStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 4 && (
            <StableRecordingStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
          {currentStep === 5 && (
            <StableReviewStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
          )}
        </StorageWizardLayout>
      </>
    );
  }

  // ==========================================================================
  // Render: Kind === 'subtable'
  // ==========================================================================

  return (
    <>
      {renderOperationModal()}
      <ActionToast toast={toast} onDismiss={dismissToast} />
      <StorageWizardLayout
        wide={currentStep === 2 || currentStep === 4}
        title="Create subtable"
        subtitle="One subtable of a supertable, bound to a Data Model field."
        currentStep={currentStep}
        steps={SUBTABLE_STEPS}
        onStepClick={(step) => {
          if (step < currentStep || validateSubtableStep(currentStep)) {
            setCurrentStep(step);
          }
        }}
        onBack={() => setCurrentStep((prev) => Math.max(prev - 1, 0))}
        onNext={handleSubtableNext}
        onSubmit={handleSubtableSubmit}
        onSaveDraft={() => void saveDraft()}
        badge={serverDraft ? <DraftChip state="draft" label={`Server draft · revision ${serverDraft.revision}`} /> : undefined}
        isDirty={subtableDraft.isDirty}
        lastSavedAt={subtableDraft.lastSavedAt}
        loading={submitting}
        error={submitError}
        submitLabel="Create subtable"
      >
        {draftNotice}
        {!draftParam && <PendingDraftBanner draft={subtableDraft.pendingDraft} onResume={subtableDraft.resumeDraft} onDiscard={subtableDraft.discardPendingDraft} />}
        {currentStep === 0 && (
          <SubtableIdentityStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
            parentStable={parentStable}
            onSelectStable={(st) => setParentStable(st)}
          />
        )}
        {currentStep === 1 && (
          <SubtableTagValuesStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
            parentStable={parentStable}
          />
        )}
        {currentStep === 2 && (
          <SubtableBindSourcesStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
            parentStable={parentStable}
          />
        )}
        {currentStep === 3 && (
          <SubtableRowAssemblyStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
            parentStable={parentStable}
          />
        )}
        {currentStep === 4 && (
          <SubtableReviewStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
          />
        )}
      </StorageWizardLayout>
    </>
  );
};
