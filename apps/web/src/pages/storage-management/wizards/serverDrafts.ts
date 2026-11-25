/**
 * Server drafts of the create wizards (contract H14 / D5).
 *
 * A server draft's `spec` is exactly the body the create endpoint of its kind accepts (the backend
 * publishes it with the same parser), so the wizard sends the same intent it would POST to
 * /td/databases|stables|subtables. The full wizard state rides along under `_ui_wizard` (the backend
 * parsers ignore unknown keys) so a reopened draft restores every field, labels included; drafts
 * created elsewhere (e.g. a failed create) are prefilled from the intent itself.
 */
import type { DatabaseWizardData } from './DatabaseWizardSteps';
import type { StableWizardData } from './StableWizardSteps';
import { stableSpecFromWizard } from './StableWizardSteps';
import type { SubtableWizardData } from './SubtableWizardSteps';
import { buildSubtableSpec } from './SubtableWizardSteps';
import type {
  ColumnDefinition,
  CreateDatabaseIntent,
  CreateStableIntent,
  FieldBindingIntent,
  RecordingMode,
  TagDefinition,
  TDObjectType,
} from '../../../lib/storagePhysicalApi';

export type WizardKind = TDObjectType;
export type AnyWizardData = DatabaseWizardData | StableWizardData | SubtableWizardData;

export interface ServerDraftRef {
  id: string;
  revision: number;
  name: string;
  updatedAt?: string | null;
}

const UI_KEY = '_ui_wizard';

// ------------------------------------------------------------------ wizard → create body

export function databaseIntent(d: DatabaseWizardData): CreateDatabaseIntent {
  return {
    physical_name: d.physical_name,
    display_name: d.display_name || undefined,
    description: d.description || undefined,
    precision: d.precision,
    retention_days: d.retention_days,
    vgroups: d.vgroups,
    cache_mb: d.cache_mb,
  };
}

export function stableIntent(d: StableWizardData): CreateStableIntent {
  return {
    database_name: d.database_name,
    physical_name: d.physical_name,
    display_name: d.display_name || undefined,
    description: d.description || undefined,
    columns: stableSpecFromWizard(d).columns as ColumnDefinition[],
    tags: d.tags,
    default_recording_mode: d.default_recording_mode,
    retention_days: d.retention_days,
    source_mapping_template: d.skip_source_mapping
      ? undefined
      : d.source_mapping_template.map((m) => ({
          id: `tmpl_${m.column_name}`,
          destination_column: m.column_name,
          source_id: m.source_id,
          source_kind: m.source_kind,
          source_path: m.source_path,
          source_type: m.source_type,
          source_unit: m.source_unit,
          status: 'ACTIVE',
          created_at: new Date().toISOString(),
        })) as CreateStableIntent['source_mapping_template'],
  };
}

export function subtableIntent(d: SubtableWizardData): Record<string, unknown> {
  return { ...buildSubtableSpec(d), stable_id: d.stable_id };
}

export function intentFor(kind: WizardKind, data: AnyWizardData): Record<string, unknown> {
  if (kind === 'database') return databaseIntent(data as DatabaseWizardData) as unknown as Record<string, unknown>;
  if (kind === 'stable') return stableIntent(data as StableWizardData) as unknown as Record<string, unknown>;
  return subtableIntent(data as SubtableWizardData);
}

export function draftNameFor(kind: WizardKind, data: AnyWizardData): string {
  const n = (data as { physical_name?: string }).physical_name;
  return n && n.trim() ? n.trim() : `draft_${kind}`;
}

/**
 * Spec sent to the server: the create body with every top-level key explicit (`null` for cleared values,
 * because PATCH merges the spec key by key) plus the wizard state for an exact reopen.
 */
export function draftSpecFor(kind: WizardKind, data: AnyWizardData): Record<string, unknown> {
  const intent = intentFor(kind, data);
  const spec: Record<string, unknown> = {};
  Object.entries(intent).forEach(([k, v]) => {
    spec[k] = v === undefined ? null : v;
  });
  spec[UI_KEY] = { v: 1, kind, data: { ...data, confirmed: false } };
  return spec;
}

// ------------------------------------------------------------------ server spec → wizard

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Prefill the wizard of `kind` from a server draft spec; `base` supplies defaults for anything missing. */
export function wizardDataFromSpec<T extends AnyWizardData>(kind: WizardKind, spec: Record<string, unknown>, base: T): T {
  const ui = spec?.[UI_KEY] as { v?: number; kind?: string; data?: Record<string, unknown> } | undefined;
  if (ui && ui.kind === kind && ui.data && typeof ui.data === 'object') {
    return { ...base, ...(ui.data as Partial<T>), confirmed: false } as T;
  }
  if (kind === 'database') {
    const b = base as DatabaseWizardData;
    const prec = str(spec.precision) as DatabaseWizardData['precision'];
    return {
      ...b,
      physical_name: str(spec.physical_name || spec.name),
      display_name: str(spec.display_name),
      description: str(spec.description),
      precision: prec === 'ms' || prec === 'us' || prec === 'ns' ? prec : b.precision,
      retention_days: num(spec.retention_days),
      vgroups: num(spec.vgroups),
      cache_mb: num(spec.cache_mb),
      confirmed: false,
    } as T;
  }
  if (kind === 'stable') {
    const b = base as StableWizardData;
    const cols = Array.isArray(spec.columns) ? (spec.columns as Record<string, unknown>[]) : [];
    const tags = Array.isArray(spec.tags) ? (spec.tags as Record<string, unknown>[]) : [];
    return {
      ...b,
      database_name: str(spec.database_name || spec.database),
      physical_name: str(spec.physical_name || spec.name),
      display_name: str(spec.display_name),
      description: str(spec.description),
      columns: cols.length
        ? cols.map((c, i) => ({
            name: str(c.name),
            td_type: str(c.td_type || c.type || 'DOUBLE').toUpperCase(),
            length: num(c.length),
            nullable: i === 0 ? false : c.nullable !== false,
            immutable: i === 0,
            primary_key: i === 1 && !!(c.primary_key || c.composite_key),
          }))
        : b.columns,
      tags: tags.length ? tags.map((t) => ({ name: str(t.name), td_type: str(t.td_type || t.type || 'VARCHAR(64)'), length: num(t.length) }) as TagDefinition) : b.tags,
      default_recording_mode: (str(spec.default_recording_mode) as RecordingMode) || b.default_recording_mode,
      retention_days: num(spec.retention_days),
      skip_source_mapping: !(Array.isArray(spec.source_mapping_template) && spec.source_mapping_template.length),
      confirmed: false,
    } as T;
  }
  const b = base as SubtableWizardData;
  const db = str(spec.database || spec.database_name);
  const st = str(spec.stable || spec.stable_name);
  const stableId = str(spec.stable_id) || (db && st ? `${db}.${st}` : '');
  const rec = (spec.recording && typeof spec.recording === 'object' ? spec.recording : {}) as Record<string, unknown>;
  const tv = Array.isArray(spec.tag_values) ? (spec.tag_values as Record<string, unknown>[]) : [];
  const binds = Array.isArray(spec.bindings) ? (spec.bindings as Record<string, unknown>[]) : [];
  const mode = (str(rec.mode || spec.recording_mode) as RecordingMode) || b.recording_mode;
  return {
    ...b,
    stable_id: stableId,
    stable_name: st || stableId.split('.')[1] || '',
    database_name: db || stableId.split('.')[0] || '',
    physical_name: str(spec.physical_name || spec.name),
    display_name: str(spec.display_name),
    description: str(spec.description),
    tag_values: tv.map((t) => ({ tag_name: str(t.name || t.tag_name), value: str(t.value) })),
    bindings: binds.map(
      (x) =>
        ({
          column_name: str(x.column_name),
          source_kind: (str(x.source_kind) || 'model_field') as FieldBindingIntent['source_kind'],
          source_id: str(x.source_id),
          source_path: str(x.source_path || x.field_path || x.source_id),
          model_id: x.model_id ? str(x.model_id) : null,
          field_path: x.field_path ? str(x.field_path) : null,
          signal_id: x.signal_id ? str(x.signal_id) : null,
        }) as FieldBindingIntent,
    ),
    no_binding: !!spec.no_binding,
    recording_mode: mode,
    row_assembly_policy: mode === 'ON_NEW_EVENT' ? 'ATOMIC_EVENT' : b.row_assembly_policy,
    start_recording: !!(rec.start_recording ?? spec.start_recording),
    identity_paths: Array.isArray(rec.identity_paths) ? (rec.identity_paths as string[]) : b.identity_paths,
    confirmed: false,
  } as T;
}
