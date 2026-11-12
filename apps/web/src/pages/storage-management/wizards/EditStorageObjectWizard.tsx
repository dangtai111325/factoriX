import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil,
  ArrowLeft,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  GitCompare,
  Database,
  Layers,
  Table,
  Loader2,
  Info,
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
  getStorageObject,
  getStable,
  getOperation,
  TDDatabase,
  TDStable,
  TDSubtable,
  StorageOperation,
  ApiError,
} from '../../../lib/storagePhysicalApi';
import { api } from '../../../api/client';

// ============================================================================
// Type guards
// ============================================================================

function isSubtable(obj: TDDatabase | TDStable | TDSubtable): obj is TDSubtable {
  return 'stable_id' in obj || 'tag_values' in obj;
}

function isStable(obj: TDDatabase | TDStable | TDSubtable): obj is TDStable {
  return 'columns' in obj && !('stable_id' in obj);
}

function isDatabase(obj: TDDatabase | TDStable | TDSubtable): obj is TDDatabase {
  return 'precision' in obj && !('columns' in obj);
}

// ============================================================================
// Main Edit Component
// ============================================================================

export const EditStorageObjectWizard: React.FC = () => {
  const { objectId } = useParams<{ objectId: string }>();
  const navigate = useNavigate();

  // Loading & error state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originalObject, setOriginalObject] = useState<TDDatabase | TDStable | TDSubtable | null>(
    null
  );
  const [objectKind, setObjectKind] = useState<'database' | 'stable' | 'subtable' | null>(null);

  // Stepper state
  const [currentStep, setCurrentStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [activeOperation, setActiveOperation] = useState<StorageOperation | null>(null);

  // Subtable parent STable ref
  const [parentStable, setParentStable] = useState<TDStable | null>(null);

  // Form drafts
  const dbDraft = useWizardDraft<DatabaseWizardData>(`fx_edit_db_${objectId}`, {
    physical_name: '',
    display_name: '',
    description: '',
    precision: 'ms',
    retention_days: null,
    vgroups: null,
    cache_mb: null,
    confirmed: false,
  });

  const stableDraft = useWizardDraft<StableWizardData>(`fx_edit_stable_${objectId}`, {
    database_name: '',
    physical_name: '',
    display_name: '',
    description: '',
    columns: [],
    tags: [],
    source_mapping_template: [],
    default_recording_mode: 'ON_CHANGE',
    retention_days: null,
    max_checkpoint_interval: 60,
    late_tolerance: 10,
    skip_source_mapping: false,
    confirmed: false,
  });

  const subtableDraft = useWizardDraft<SubtableWizardData>(`fx_edit_subtable_${objectId}`, {
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
  });

  // Load object from API
  const fetchObject = useCallback(async () => {
    if (!objectId) return;
    setLoading(true);
    setLoadError(null);
    setVersionConflict(false);

    try {
      const obj = await getStorageObject(objectId);
      setOriginalObject(obj);

      if (isDatabase(obj)) {
        setObjectKind('database');
        dbDraft.resetData({
          physical_name: obj.physical_name,
          display_name: obj.display_name || '',
          description: obj.description || '',
          precision: obj.precision,
          retention_days: obj.retention_days ?? null,
          vgroups: obj.vgroups ?? null,
          cache_mb: obj.cache_mb ?? null,
          confirmed: false,
        });
      } else if (isSubtable(obj)) {
        setObjectKind('subtable');
        subtableDraft.resetData({
          stable_id: obj.stable_id,
          stable_name: obj.stable_name,
          database_name: obj.database_name,
          physical_name: obj.physical_name,
          display_name: obj.display_name || '',
          description: obj.description || '',
          tag_values: (obj.tag_values || []).map((t) => ({
            tag_name: t.name,
            value: t.value || '',
          })),
          bindings: (obj.bindings || []).map((b) => ({
            column_name: b.destination_column,
            source_kind: b.source_kind,
            source_id: b.source_id,
            source_path: b.source_path,
          })),
          row_assembly_policy: obj.row_assembly_policy || 'INDEPENDENT_EVENTS',
          recording_mode: obj.recording_mode || 'ON_CHANGE',
          max_age_seconds: 5,
          time_bucket_seconds: 5,
          start_recording: obj.write_active,
          confirmed: false,
        });

        // Load parent STable
        if (obj.stable_id) {
          getStable(obj.stable_id)
            .then(setParentStable)
            .catch(() => {});
        }
      } else if (isStable(obj)) {
        setObjectKind('stable');
        stableDraft.resetData({
          database_name: obj.database_name,
          physical_name: obj.physical_name,
          display_name: obj.display_name || '',
          description: obj.description || '',
          columns: obj.columns || [],
          tags: obj.tags || [],
          source_mapping_template: (obj.source_mapping_template || []).map((m) => ({
            column_name: m.destination_column,
            source_id: m.source_id,
            source_kind: m.source_kind,
            source_path: m.source_path,
            source_type: m.source_type || undefined,
            source_unit: m.source_unit || undefined,
          })),
          default_recording_mode: obj.default_recording_mode || 'ON_CHANGE',
          retention_days: obj.retention_days ?? null,
          max_checkpoint_interval: 60,
          late_tolerance: 10,
          skip_source_mapping: false,
          confirmed: false,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load storage object.';
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [objectId]);

  useEffect(() => {
    fetchObject();
  }, [fetchObject]);

  // Compute Diffs for "Compare Changes"
  const diffItems = useMemo(() => {
    if (!originalObject) return [];
    const diffs: { label: string; oldVal: string; newVal: string }[] = [];

    if (objectKind === 'database' && isDatabase(originalObject)) {
      if ((originalObject.display_name || '') !== (dbDraft.data.display_name || '')) {
        diffs.push({
          label: 'Display Name',
          oldVal: originalObject.display_name || '(none)',
          newVal: dbDraft.data.display_name || '(none)',
        });
      }
      if ((originalObject.description || '') !== (dbDraft.data.description || '')) {
        diffs.push({
          label: 'Description',
          oldVal: originalObject.description || '(none)',
          newVal: dbDraft.data.description || '(none)',
        });
      }
      if ((originalObject.retention_days ?? null) !== dbDraft.data.retention_days) {
        diffs.push({
          label: 'Retention Days',
          oldVal: originalObject.retention_days ? `${originalObject.retention_days} d` : 'Unlimited',
          newVal: dbDraft.data.retention_days ? `${dbDraft.data.retention_days} d` : 'Unlimited',
        });
      }
    } else if (objectKind === 'stable' && isStable(originalObject)) {
      if ((originalObject.display_name || '') !== (stableDraft.data.display_name || '')) {
        diffs.push({
          label: 'Display Name',
          oldVal: originalObject.display_name || '(none)',
          newVal: stableDraft.data.display_name || '(none)',
        });
      }
      if ((originalObject.description || '') !== (stableDraft.data.description || '')) {
        diffs.push({
          label: 'Description',
          oldVal: originalObject.description || '(none)',
          newVal: stableDraft.data.description || '(none)',
        });
      }
      if (originalObject.columns.length !== stableDraft.data.columns.length) {
        diffs.push({
          label: 'Columns Count',
          oldVal: `${originalObject.columns.length} columns`,
          newVal: `${stableDraft.data.columns.length} columns`,
        });
      }
      if (originalObject.tags.length !== stableDraft.data.tags.length) {
        diffs.push({
          label: 'Tags Count',
          oldVal: `${originalObject.tags.length} tags`,
          newVal: `${stableDraft.data.tags.length} tags`,
        });
      }
      if (originalObject.default_recording_mode !== stableDraft.data.default_recording_mode) {
        diffs.push({
          label: 'Recording Mode',
          oldVal: originalObject.default_recording_mode || 'ON_CHANGE',
          newVal: stableDraft.data.default_recording_mode,
        });
      }
    } else if (objectKind === 'subtable' && isSubtable(originalObject)) {
      if ((originalObject.display_name || '') !== (subtableDraft.data.display_name || '')) {
        diffs.push({
          label: 'Display Name',
          oldVal: originalObject.display_name || '(none)',
          newVal: subtableDraft.data.display_name || '(none)',
        });
      }
      if ((originalObject.description || '') !== (subtableDraft.data.description || '')) {
        diffs.push({
          label: 'Description',
          oldVal: originalObject.description || '(none)',
          newVal: subtableDraft.data.description || '(none)',
        });
      }
      if (originalObject.bindings.length !== subtableDraft.data.bindings.length) {
        diffs.push({
          label: 'Bound Signals',
          oldVal: `${originalObject.bindings.length} signals`,
          newVal: `${subtableDraft.data.bindings.length} signals`,
        });
      }
      if (originalObject.row_assembly_policy !== subtableDraft.data.row_assembly_policy) {
        diffs.push({
          label: 'Assembly Policy',
          oldVal: originalObject.row_assembly_policy || 'INDEPENDENT_EVENTS',
          newVal: subtableDraft.data.row_assembly_policy,
        });
      }
    }

    return diffs;
  }, [originalObject, objectKind, dbDraft.data, stableDraft.data, subtableDraft.data]);

  // Diff Panel Renderer
  const renderDiffPanel = () => {
    return (
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden bg-white mt-4">
        <div className="bg-[#F8FAFC] px-4 py-2.5 border-b border-[#E3EAF3] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-[#EF1B24]" />
            <span className="text-[12px] font-bold text-[#111B37]">Compare Changes</span>
          </div>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EAEFF5] text-[#334568]">
            {diffItems.length} {diffItems.length === 1 ? 'change' : 'changes'}
          </span>
        </div>

        <div className="p-4 text-[12px]">
          {diffItems.length === 0 ? (
            <p className="text-[#8C9BAE] italic">No modifications detected compared to stored version.</p>
          ) : (
            <div className="divide-y divide-[#F1F5FA]">
              {diffItems.map((d, idx) => (
                <div key={idx} className="py-2 flex items-center justify-between">
                  <span className="font-semibold text-[#111B37] w-40">{d.label}:</span>
                  <div className="flex items-center gap-3 font-mono text-[11px] flex-1 justify-end">
                    <span className="text-[#EF1B24] bg-[#FEF2F2] px-2 py-0.5 rounded line-through">
                      {d.oldVal}
                    </span>
                    <span className="text-[#8C9BAE]">→</span>
                    <span className="text-[#0DBA67] bg-[#E8FAF0] px-2 py-0.5 rounded font-bold">
                      {d.newVal}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Submit Handler with 409 VERSION_CONFLICT detection
  const handleSave = async (payload: Record<string, unknown>) => {
    if (!objectId) return;
    setSubmitting(true);
    setSubmitError(null);
    setVersionConflict(false);

    try {
      const res = await api<StorageOperation | TDDatabase | TDStable | TDSubtable>(
        `/api/v1/storage/td/objects/${encodeURIComponent(objectId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );

      // Clear draft
      if (objectKind === 'database') dbDraft.clearDraft();
      if (objectKind === 'stable') stableDraft.clearDraft();
      if (objectKind === 'subtable') subtableDraft.clearDraft();

      // Check if operation needs polling
      if (res && 'id' in res && 'operation_kind' in res) {
        const op = res as StorageOperation;
        if (op.status === 'APPLIED') {
          navigate('/historian/storage?tab=objects');
          return;
        }

        // Poll operation
        setActiveOperation(op);
        const pollInterval = 2000;
        let attempts = 0;
        while (attempts < 30) {
          const updated = await getOperation(op.id);
          setActiveOperation(updated);
          if (updated.status === 'APPLIED') {
            navigate('/historian/storage?tab=objects');
            return;
          }
          if (updated.status === 'FAILED' || updated.status === 'CANCELLED') {
            throw new Error(updated.error_message || 'Operation failed.');
          }
          await new Promise((r) => setTimeout(r, pollInterval));
          attempts++;
        }
      }

      navigate('/historian/storage?tab=objects');
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'VERSION_CONFLICT')) {
        setVersionConflict(true);
        setSubmitError(
          'Version Conflict: This object was modified by another session while you were editing.'
        );
      } else {
        const msg = err instanceof Error ? err.message : 'Failed to save changes.';
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ==========================================================================
  // Loading and Error States
  // ==========================================================================

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F6F8FC] flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-[#EF1B24] animate-spin" />
          <div className="text-[14px] font-semibold text-[#111B37]">
            Loading storage object "{objectId}"...
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !originalObject || !objectKind) {
    return (
      <div className="min-h-screen bg-[#F6F8FC] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E3EAF3] rounded-2xl p-8 max-w-md w-full text-center space-y-4 shadow-sm">
          <AlertTriangle className="w-10 h-10 text-[#EF1B24] mx-auto" />
          <h2 className="text-[18px] font-bold text-[#111B37]">Object Not Found</h2>
          <p className="text-[13px] text-[#657794]">
            {loadError || `Unable to load physical object for ID "${objectId}".`}
          </p>
          <button
            type="button"
            onClick={() => navigate('/historian/storage?tab=objects')}
            className="w-full py-2.5 px-4 bg-[#EF1B24] text-white rounded-xl text-[13px] font-semibold hover:bg-[#D9141D] transition-colors"
          >
            Back to Storage Management
          </button>
        </div>
      </div>
    );
  }

  // ==========================================================================
  // Render: Database Edit Wizard
  // ==========================================================================

  if (objectKind === 'database') {
    const DB_STEPS = ['Identity', 'Settings', 'Review & Diff'];

    const handleNext = () => {
      const errs: Record<string, string> = {};
      if (currentStep === 0 && !dbDraft.data.physical_name) {
        errs.physical_name = 'Database name is required.';
      }
      setErrors(errs);
      if (Object.keys(errs).length === 0) {
        setCurrentStep((p) => Math.min(p + 1, DB_STEPS.length - 1));
      }
    };

    const handleSubmit = () => {
      handleSave({
        display_name: dbDraft.data.display_name,
        description: dbDraft.data.description,
        retention_days: dbDraft.data.retention_days,
        vgroups: dbDraft.data.vgroups,
        cache_mb: dbDraft.data.cache_mb,
      });
    };

    return (
      <StorageWizardLayout
        title={`Edit Database: ${originalObject.physical_name}`}
        subtitle="Modify database metadata, retention periods, and vgroups allocation."
        badge={
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]">
            <Pencil className="w-3 h-3" />
            Edit Mode
          </span>
        }
        currentStep={currentStep}
        steps={DB_STEPS}
        onStepClick={(s) => setCurrentStep(s)}
        onBack={() => setCurrentStep((p) => Math.max(p - 1, 0))}
        onNext={handleNext}
        onSubmit={handleSubmit}
        onSaveDraft={dbDraft.saveDraft}
        isDirty={dbDraft.isDirty}
        lastSavedAt={dbDraft.lastSavedAt}
        loading={submitting}
        error={submitError}
        submitLabel="Save Changes"
      >
        {versionConflict && (
          <div className="mb-6 p-4 bg-[#FEF2F2] border border-[#FAC6C9] rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-[#EF1B24] text-[13px]">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <div>
                <span className="font-bold">Version Conflict (409):</span> This object was updated on the server. Reload to view the latest revision.
              </div>
            </div>
            <button
              type="button"
              onClick={fetchObject}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#FAC6C9] text-[#EF1B24] rounded-lg text-[12px] font-semibold hover:bg-[#FEF2F2] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reload Latest</span>
            </button>
          </div>
        )}

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
          <>
            <DatabaseReviewStep
              data={dbDraft.data}
              onChange={dbDraft.updateData}
              errors={errors}
            />
            {renderDiffPanel()}
          </>
        )}
      </StorageWizardLayout>
    );
  }

  // ==========================================================================
  // Render: Supertable Edit Wizard
  // ==========================================================================

  if (objectKind === 'stable') {
    const STABLE_STEPS = [
      'Target',
      'Columns',
      'Tags',
      'Mapping',
      'Recording',
      'Review & Diff',
    ];

    const handleNext = () => {
      setCurrentStep((p) => Math.min(p + 1, STABLE_STEPS.length - 1));
    };

    const handleSubmit = () => {
      handleSave({
        display_name: stableDraft.data.display_name,
        description: stableDraft.data.description,
        columns: stableDraft.data.columns,
        tags: stableDraft.data.tags,
        default_recording_mode: stableDraft.data.default_recording_mode,
        retention_days: stableDraft.data.retention_days,
        source_mapping_template: stableDraft.data.source_mapping_template,
      });
    };

    return (
      <StorageWizardLayout
        title={`Edit Supertable: ${originalObject.physical_name}`}
        subtitle="Update column schemas, tags, and recording policies."
        badge={
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]">
            <Pencil className="w-3 h-3" />
            Edit Mode
          </span>
        }
        currentStep={currentStep}
        steps={STABLE_STEPS}
        onStepClick={(s) => setCurrentStep(s)}
        onBack={() => setCurrentStep((p) => Math.max(p - 1, 0))}
        onNext={handleNext}
        onSubmit={handleSubmit}
        onSaveDraft={stableDraft.saveDraft}
        isDirty={stableDraft.isDirty}
        lastSavedAt={stableDraft.lastSavedAt}
        loading={submitting}
        error={submitError}
        submitLabel="Save Supertable"
      >
        {versionConflict && (
          <div className="mb-6 p-4 bg-[#FEF2F2] border border-[#FAC6C9] rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-[#EF1B24] text-[13px]">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <div>
                <span className="font-bold">Version Conflict (409):</span> This Supertable was altered concurrently.
              </div>
            </div>
            <button
              type="button"
              onClick={fetchObject}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#FAC6C9] text-[#EF1B24] rounded-lg text-[12px] font-semibold hover:bg-[#FEF2F2] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reload Latest</span>
            </button>
          </div>
        )}

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
          <>
            <StableReviewStep
              data={stableDraft.data}
              onChange={stableDraft.updateData}
              errors={errors}
            />
            {renderDiffPanel()}
          </>
        )}
      </StorageWizardLayout>
    );
  }

  // ==========================================================================
  // Render: Subtable Edit Wizard
  // ==========================================================================

  const SUBTABLE_STEPS = ['Identity', 'Tag Values', 'Bindings', 'Policy', 'Review & Diff'];

  const handleSubtableNext = () => {
    setCurrentStep((p) => Math.min(p + 1, SUBTABLE_STEPS.length - 1));
  };

  const handleSubtableSubmit = () => {
    handleSave({
      display_name: subtableDraft.data.display_name,
      description: subtableDraft.data.description,
      tag_values: subtableDraft.data.tag_values,
      bindings: subtableDraft.data.bindings,
      row_assembly_policy: subtableDraft.data.row_assembly_policy,
      recording_mode: subtableDraft.data.recording_mode,
      start_recording: subtableDraft.data.start_recording,
    });
  };

  return (
    <StorageWizardLayout
      title={`Edit Subtable: ${originalObject.physical_name}`}
      subtitle="Modify static tag values, signal bindings, or row assembly policy."
      badge={
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]">
          <Pencil className="w-3 h-3" />
          Edit Mode
        </span>
      }
      currentStep={currentStep}
      steps={SUBTABLE_STEPS}
      onStepClick={(s) => setCurrentStep(s)}
      onBack={() => setCurrentStep((p) => Math.max(p - 1, 0))}
      onNext={handleSubtableNext}
      onSubmit={handleSubtableSubmit}
      onSaveDraft={subtableDraft.saveDraft}
      isDirty={subtableDraft.isDirty}
      lastSavedAt={subtableDraft.lastSavedAt}
      loading={submitting}
      error={submitError}
      submitLabel="Save Subtable"
    >
      {versionConflict && (
        <div className="mb-6 p-4 bg-[#FEF2F2] border border-[#FAC6C9] rounded-xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-[#EF1B24] text-[13px]">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              <span className="font-bold">Version Conflict (409):</span> This subtable was updated on the server.
            </div>
          </div>
          <button
            type="button"
            onClick={fetchObject}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#FAC6C9] text-[#EF1B24] rounded-lg text-[12px] font-semibold hover:bg-[#FEF2F2] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Reload Latest</span>
          </button>
        </div>
      )}

      {currentStep === 0 && (
        <SubtableIdentityStep
          data={subtableDraft.data}
          onChange={subtableDraft.updateData}
          errors={errors}
          parentStable={parentStable}
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
        <>
          <SubtableReviewStep
            data={subtableDraft.data}
            onChange={subtableDraft.updateData}
            errors={errors}
          />
          {renderDiffPanel()}
        </>
      )}
    </StorageWizardLayout>
  );
};
