import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
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
import { StorageWizardLayout, useWizardDraft } from './WizardShared';
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
} from './StableWizardSteps';
import {
  SubtableIdentityStep,
  SubtableTagValuesStep,
  SubtableBindSourcesStep,
  SubtableRowAssemblyStep,
  SubtableReviewStep,
  SubtableWizardData,
} from './SubtableWizardSteps';
import {
  createDatabase,
  createStable,
  createSubtable,
  getOperation,
  getStable,
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
  precision: 'ms',
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
    { name: 'resource_id', td_type: 'VARCHAR(64)' },
  ],
  source_mapping_template: [],
  default_recording_mode: 'ON_CHANGE',
  retention_days: null,
  max_checkpoint_interval: 60,
  late_tolerance: 10,
  skip_source_mapping: false,
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
  start_recording: true,
  confirmed: false,
};

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

    if (op.status === 'APPLIED' || op.status === 'FAILED' || op.status === 'CANCELLED') {
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

  // Wizard Step index
  const [currentStep, setCurrentStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Operation In-Progress State
  const [activeOperation, setActiveOperation] = useState<StorageOperation | null>(null);

  // Database wizard state
  const dbDraft = useWizardDraft<DatabaseWizardData>('fx_wizard_draft_database', INITIAL_DB_DATA);

  // Supertable wizard state
  const stableDraft = useWizardDraft<StableWizardData>('fx_wizard_draft_stable', INITIAL_STABLE_DATA);

  // Subtable wizard state
  const subtableDraft = useWizardDraft<SubtableWizardData>('fx_wizard_draft_subtable', INITIAL_SUBTABLE_DATA);
  const [parentStable, setParentStable] = useState<TDStable | null>(null);

  // When subtable parent STable changes, load its full details
  useEffect(() => {
    if (kind === 'subtable' && subtableDraft.data.stable_id) {
      getStable(subtableDraft.data.stable_id)
        .then((st) => {
          setParentStable(st);
          // Initialize tag_values if not set
          if (st.tags && st.tags.length > 0) {
            const currentTagNames = new Set(subtableDraft.data.tag_values.map((tv) => tv.tag_name));
            const newTags = [...subtableDraft.data.tag_values];
            st.tags.forEach((t) => {
              if (!currentTagNames.has(t.name)) {
                newTags.push({ tag_name: t.name, value: '' });
              }
            });
            subtableDraft.updateField('tag_values', newTags);
          }
        })
        .catch(() => {});
    }
  }, [kind, subtableDraft.data.stable_id]);

  // Reset step index when kind changes
  useEffect(() => {
    setCurrentStep(0);
    setErrors({});
    setSubmitError(null);
  }, [kind]);

  // Handle operation polling execution
  const executeWithPolling = async (opPromise: Promise<StorageOperation>) => {
    setSubmitting(true);
    setSubmitError(null);

    try {
      const initialOp = await opPromise;
      if (!initialOp || !initialOp.id) {
        // Direct success without async operation
        navigate('/historian/storage?tab=objects');
        return;
      }

      // If initial operation is already terminal
      if (initialOp.status === 'APPLIED') {
        navigate('/historian/storage?tab=objects');
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
        navigate('/historian/storage?tab=objects');
      } else {
        setSubmitError(terminalOp.error_message || 'Operation failed during execution.');
        setSubmitting(false);
        setActiveOperation(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred during submission.';
      setSubmitError(msg);
      setSubmitting(false);
      setActiveOperation(null);
    }
  };

  // ==========================================================================
  // Database Wizard Handlers
  // ==========================================================================

  const DB_STEPS = ['Identity', 'Settings', 'Review'];

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
      if (dbDraft.data.retention_days != null && dbDraft.data.retention_days < 1) {
        errs.retention_days = 'Retention days must be at least 1 day.';
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
      createDatabase({
        physical_name: dbDraft.data.physical_name,
        display_name: dbDraft.data.display_name || undefined,
        description: dbDraft.data.description || undefined,
        precision: dbDraft.data.precision,
        retention_days: dbDraft.data.retention_days,
        vgroups: dbDraft.data.vgroups,
        cache_mb: dbDraft.data.cache_mb,
      }).then((res) => {
        dbDraft.clearDraft();
        return res;
      })
    );
  };

  // ==========================================================================
  // Supertable Wizard Handlers
  // ==========================================================================

  const STABLE_STEPS = [
    'Target & Name',
    'Columns Schema',
    'Metadata Tags',
    'Source Mapping',
    'Recording Policy',
    'Review',
  ];

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
      createStable({
        database_name: stableDraft.data.database_name,
        physical_name: stableDraft.data.physical_name,
        display_name: stableDraft.data.display_name || undefined,
        description: stableDraft.data.description || undefined,
        columns: stableDraft.data.columns,
        tags: stableDraft.data.tags,
        default_recording_mode: stableDraft.data.default_recording_mode,
        retention_days: stableDraft.data.retention_days,
        source_mapping_template: stableDraft.data.skip_source_mapping
          ? undefined
          : stableDraft.data.source_mapping_template.map((m) => ({
              id: `tmpl_${m.column_name}`,
              destination_column: m.column_name,
              source_id: m.source_id,
              source_kind: m.source_kind,
              source_path: m.source_path,
              source_type: m.source_type,
              source_unit: m.source_unit,
              status: 'ACTIVE',
              created_at: new Date().toISOString(),
            })),
      }).then((res) => {
        stableDraft.clearDraft();
        return res;
      })
    );
  };

  // ==========================================================================
  // Subtable Wizard Handlers
  // ==========================================================================

  const SUBTABLE_STEPS = [
    'Identity',
    'Tag Values',
    'Bind Sources',
    'Row Assembly',
    'Review',
  ];

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
    } else if (step === 4) {
      if (!subtableDraft.data.confirmed) {
        errs.confirmed = 'You must confirm before instantiating the Subtable.';
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
      createSubtable({
        stable_id: subtableDraft.data.stable_id,
        physical_name: subtableDraft.data.physical_name,
        display_name: subtableDraft.data.display_name || undefined,
        description: subtableDraft.data.description || undefined,
        tag_values: subtableDraft.data.tag_values,
        bindings: subtableDraft.data.bindings,
        row_assembly_policy: subtableDraft.data.row_assembly_policy,
        recording_mode: subtableDraft.data.recording_mode,
        max_age_seconds: subtableDraft.data.max_age_seconds,
        time_bucket_seconds: subtableDraft.data.time_bucket_seconds,
        start_recording: subtableDraft.data.start_recording,
      }).then((res) => {
        subtableDraft.clearDraft();
        return res;
      })
    );
  };

  // ==========================================================================
  // Render: Object Selection Page (when no ?kind is specified)
  // ==========================================================================

  if (!kind || !['database', 'stable', 'subtable'].includes(kind)) {
    return (
      <div className="min-h-screen bg-[#F6F8FC] py-10 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Header */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => navigate('/historian/storage?tab=objects')}
              className="p-2 rounded-lg border border-[#D4DFEC] hover:bg-white text-[#334568] transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-[22px] font-bold text-[#111B37] tracking-tight">
                Create Storage Object
              </h1>
              <p className="text-[13px] text-[#657794] mt-0.5">
                Choose the physical TDengine storage archetype you want to instantiate.
              </p>
            </div>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Database Card */}
            <div className="bg-white border border-[#E3EAF3] rounded-2xl p-6 shadow-xs hover:shadow-md transition-all flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-xl bg-[#FFF5F5] border border-[#FAC6C9] flex items-center justify-center text-[#EF1B24] mb-4">
                  <Database className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[16px] font-bold text-[#111B37]">Database</h2>
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-[#EAEFF5] text-[#334568]">
                    Root
                  </span>
                </div>
                <p className="text-[13px] text-[#657794] mt-2 leading-relaxed">
                  Provision an isolated time-series database with configurable timestamp precision,
                  automatic retention pruning (KEEP), and multi-core vgroups.
                </p>
              </div>

              <div className="pt-6">
                <button
                  type="button"
                  onClick={() => setSearchParams({ kind: 'database' })}
                  className="w-full py-2.5 px-4 bg-white border border-[#D4DFEC] hover:border-[#EF1B24] hover:bg-[#FFF5F5] text-[#111B37] hover:text-[#EF1B24] rounded-xl text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-2xs"
                >
                  <span>Create Database</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Supertable Card */}
            <div className="bg-white border border-[#E3EAF3] rounded-2xl p-6 shadow-xs hover:shadow-md transition-all flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-xl bg-[#F0F9FF] border border-[#BAE6FD] flex items-center justify-center text-[#0284C7] mb-4">
                  <Layers className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[16px] font-bold text-[#111B37]">Supertable (STable)</h2>
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-[#E0F2FE] text-[#0284C7]">
                    Template
                  </span>
                </div>
                <p className="text-[13px] text-[#657794] mt-2 leading-relaxed">
                  Define a time-series metric schema and metadata tag dimensions for a family of
                  identical machines, sensors, or industrial devices.
                </p>
              </div>

              <div className="pt-6">
                <button
                  type="button"
                  onClick={() => setSearchParams({ kind: 'stable' })}
                  className="w-full py-2.5 px-4 bg-white border border-[#D4DFEC] hover:border-[#0284C7] hover:bg-[#F0F9FF] text-[#111B37] hover:text-[#0284C7] rounded-xl text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-2xs"
                >
                  <span>Create Supertable</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Subtable Card */}
            <div className="bg-white border border-[#E3EAF3] rounded-2xl p-6 shadow-xs hover:shadow-md transition-all flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-xl bg-[#F5F3FF] border border-[#DDD6FE] flex items-center justify-center text-[#7C3AED] mb-4">
                  <Table className="w-6 h-6" />
                </div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[16px] font-bold text-[#111B37]">Subtable</h2>
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-[#EDE9FE] text-[#7C3AED]">
                    Instance
                  </span>
                </div>
                <p className="text-[13px] text-[#657794] mt-2 leading-relaxed">
                  Instantiate a physical table from an existing Supertable. Assign device-specific
                  static tag values and bind real-time streaming signals.
                </p>
              </div>

              <div className="pt-6">
                <button
                  type="button"
                  onClick={() => setSearchParams({ kind: 'subtable' })}
                  className="w-full py-2.5 px-4 bg-white border border-[#D4DFEC] hover:border-[#7C3AED] hover:bg-[#F5F3FF] text-[#111B37] hover:text-[#7C3AED] rounded-xl text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-2xs"
                >
                  <span>Create Subtable</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
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
            <Loader2 className="w-6 h-6 text-[#EF1B24] animate-spin flex-shrink-0" />
            <div>
              <h3 className="text-[16px] font-bold text-[#111B37]">
                Executing Storage Operation
              </h3>
              <p className="text-[12px] text-[#657794]">
                Deploying changes directly to the physical storage engine...
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
              <span className="font-semibold text-[#EF1B24]">{activeOperation.status}</span>
            </div>
          </div>

          <p className="text-[11px] text-[#8C9BAE] text-center">
            Polling status every 2 seconds. Please do not close your browser.
          </p>
        </div>
      </div>
    );
  };

  // ==========================================================================
  // Render: Kind === 'database'
  // ==========================================================================

  if (kind === 'database') {
    return (
      <>
        {renderOperationModal()}
        <StorageWizardLayout
          title="Create TDengine Database"
          subtitle="Define time-series database parameters, timestamp precision, and retention."
          badge={
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#FFF5F5] text-[#EF1B24] border border-[#FAC6C9]">
              <Database className="w-3 h-3" />
              Database
            </span>
          }
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
          onSaveDraft={dbDraft.saveDraft}
          isDirty={dbDraft.isDirty}
          lastSavedAt={dbDraft.lastSavedAt}
          loading={submitting}
          error={submitError}
          submitLabel="Create Database"
        >
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
        <StorageWizardLayout
          title="Create Supertable (STable)"
          subtitle="Define shared schema columns, static metadata tags, and recording policies."
          badge={
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#F0F9FF] text-[#0284C7] border border-[#BAE6FD]">
              <Layers className="w-3 h-3" />
              Supertable
            </span>
          }
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
          onSaveDraft={stableDraft.saveDraft}
          isDirty={stableDraft.isDirty}
          lastSavedAt={stableDraft.lastSavedAt}
          loading={submitting}
          error={submitError}
          submitLabel="Deploy Supertable"
        >
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
      <StorageWizardLayout
        title="Create Subtable"
        subtitle="Instantiate a subtable from a Supertable template and bind operational data sources."
        badge={
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#F5F3FF] text-[#7C3AED] border border-[#DDD6FE]">
            <Table className="w-3 h-3" />
            Subtable
          </span>
        }
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
        onSaveDraft={subtableDraft.saveDraft}
        isDirty={subtableDraft.isDirty}
        lastSavedAt={subtableDraft.lastSavedAt}
        loading={submitting}
        error={submitError}
        submitLabel="Instantiate Subtable"
      >
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
