/**
 * New dashboard: name + description, start from Blank or a template (`GET /dashboards/templates`,
 * built-in and tenant). A template with data roles goes through a mapping step where each role gets a
 * source from the Factory Model picker; required roles are marked, unmapped roles are allowed (their
 * widgets stay unbound) and nothing is mapped automatically by name.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, FileStack, LayoutTemplate, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { Dialog } from '../13_DataModels/ui';
import { createDashboard, deleteTemplate, errorLine, listTemplates } from '../../features/dashboard/api';
import { SourcePicker, CapabilityChip } from '../../features/dashboard/components/SourcePicker';
import { sourceFromToken } from '../../features/dashboard/document';
import { useSourceCatalog } from '../../features/dashboard/sources';
import type { DashboardDetail, DashboardTemplate, SourceItem, SourceRef } from '../../features/dashboard/types';

type Step = 'start' | 'map';

export const NewDashboardDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (d: DashboardDetail, warnings: string[]) => void;
}> = ({ open, onClose, onCreated }) => {
  const [step, setStep] = useState<Step>('start');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templates, setTemplates] = useState<DashboardTemplate[] | null>(null);
  const [tplError, setTplError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [roleMap, setRoleMap] = useState<Record<string, SourceItem>>({});
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [pickerSel, setPickerSel] = useState<SourceItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DashboardTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const template = templates?.find((t) => t.id === templateId) || null;
  const roles = template?.roles || [];

  useEffect(() => {
    if (!open) return;
    setStep('start');
    setName('');
    setDescription('');
    setTemplateId(null);
    setRoleMap({});
    setActiveRole(null);
    setPickerSel(null);
    setError(null);
    let alive = true;
    setTplError(null);
    listTemplates()
      .then((r) => alive && setTemplates(r.items || []))
      .catch((e) => {
        if (!alive) return;
        setTemplates([]);
        setTplError(errorLine(e, 'Could not load the templates.'));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const builtin = (templates || []).filter((t) => t.builtin);
  const tenant = (templates || []).filter((t) => !t.builtin);

  const unmappedRequired = roles.filter((r) => r.required && !roleMap[r.id]);
  const canNext = name.trim().length > 0;

  const submit = async () => {
    if (!canNext || busy) return;
    setBusy(true);
    setError(null);
    try {
      const role_map: Record<string, SourceRef> = {};
      for (const [rid, item] of Object.entries(roleMap)) {
        const src = item.source ?? sourceFromToken(item.token, item.kind);
        if (src) role_map[rid] = src;
      }
      const res = await createDashboard({
        name: name.trim(),
        description: description.trim() || undefined,
        ...(template ? { template_id: template.id, role_map } : {}),
      });
      const warnings = (res.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)).filter(Boolean);
      onCreated(res, warnings);
    } catch (e) {
      setError(errorLine(e, 'Could not create the dashboard.'));
    } finally {
      setBusy(false);
    }
  };

  const goNext = () => {
    if (!canNext) return;
    if (template && roles.length) {
      setStep('map');
      setActiveRole(roles[0]?.id ?? null);
    } else void submit();
  };

  const footer =
    step === 'start' ? (
      <>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={goNext} loading={busy} disabled={!canNext}>
          {template && roles.length ? 'Next: map data' : 'Create and open Studio'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={() => setStep('start')} disabled={busy}>
          Back
        </Button>
        <span className="mr-auto text-[12px] text-[#657794]">
          {Object.keys(roleMap).length} of {roles.length} role{roles.length === 1 ? '' : 's'} mapped
          {unmappedRequired.length > 0 && <span className="text-amber-800"> · {unmappedRequired.length} required not mapped</span>}
        </span>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} loading={busy}>
          Create and open Studio
        </Button>
      </>
    );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        busy={busy}
        width="xl"
        title={step === 'start' ? 'New dashboard' : `Map data for “${template?.label}”`}
        subtitle={
          step === 'start'
            ? 'Name it, then start from a blank canvas or a template.'
            : 'Choose the signal or Data Model field for each data role. Nothing is matched by name: roles you skip stay unbound and can be bound later in the Studio.'
        }
        footer={footer}
      >
        {step === 'start' ? (
          <div className="space-y-5">
            <form
              className="grid grid-cols-1 md:grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                goNext();
              }}
            >
              <div>
                <label htmlFor="dash-new-name" className="block text-[12px] font-semibold text-[#334568] mb-1">
                  Name <span className="text-red-600">*</span>
                </label>
                <input id="dash-new-name" className="fx-input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="e.g. Line 2 overview" required />
              </div>
              <div>
                <label htmlFor="dash-new-desc" className="block text-[12px] font-semibold text-[#334568] mb-1">
                  Description
                </label>
                <input id="dash-new-desc" className="fx-input" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What operators use it for" />
              </div>
              <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
            </form>

            <div>
              <h4 className="text-[12px] font-bold text-[#111B37] mb-2">Start from</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" role="radiogroup" aria-label="Start from">
                <TemplateCard
                  selected={templateId === null}
                  onSelect={() => setTemplateId(null)}
                  icon={<Plus className="w-4 h-4" />}
                  title="Blank dashboard"
                  description="An empty canvas. Add widgets and choose their data in the Studio."
                />
                {templates === null && <div className="text-[12px] text-[#657794] p-3">Loading templates…</div>}
                {builtin.map((t) => (
                  <TemplateCard key={t.id} t={t} selected={templateId === t.id} onSelect={() => setTemplateId(t.id)} />
                ))}
              </div>
              {tplError && <p className="mt-2 text-[12px] text-red-700">{tplError}</p>}
              {tenant.length > 0 && (
                <>
                  <h4 className="text-[12px] font-bold text-[#111B37] mt-4 mb-2">Your templates</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" role="radiogroup" aria-label="Your templates">
                    {tenant.map((t) => (
                      <TemplateCard
                        key={t.id}
                        t={t}
                        selected={templateId === t.id}
                        onSelect={() => setTemplateId(t.id)}
                        onDelete={() => {
                          setDeleteError(null);
                          setToDelete(t);
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
              {templates && !templates.length && !tplError && (
                <p className="mt-2 text-[12px] text-[#657794]">No template yet. Use “Save as template” in the Studio to reuse a dashboard layout.</p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
                {error}
              </p>
            )}
          </div>
        ) : (
          <RoleMapping
            roles={roles}
            roleMap={roleMap}
            activeRole={activeRole}
            setActiveRole={(id) => {
              setActiveRole(id);
              setPickerSel(id && roleMap[id] ? roleMap[id] : null);
            }}
            pickerSel={pickerSel}
            setPickerSel={setPickerSel}
            onMap={(rid, item) => {
              setRoleMap((prev) => ({ ...prev, [rid]: item }));
              const next = roles.find((r) => r.id !== rid && !roleMap[r.id]);
              if (next) {
                setActiveRole(next.id);
                setPickerSel(null);
              }
            }}
            onUnmap={(rid) =>
              setRoleMap((prev) => {
                const n = { ...prev };
                delete n[rid];
                return n;
              })
            }
            error={error}
          />
        )}
      </Dialog>
      <ConfirmDialog
        isOpen={!!toDelete}
        title={`Delete template “${toDelete?.label ?? ''}”?`}
        message="Dashboards already created from it are not changed. This cannot be undone."
        confirmLabel="Delete template"
        busyLabel="Deleting…"
        error={deleteError}
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await deleteTemplate(toDelete.id);
            setTemplates((prev) => (prev || []).filter((t) => t.id !== toDelete.id));
            if (templateId === toDelete.id) setTemplateId(null);
            setToDelete(null);
          } catch (e) {
            setDeleteError(errorLine(e, 'Could not delete the template.'));
          }
        }}
      />
    </>
  );
};

const TemplateCard: React.FC<{
  t?: DashboardTemplate;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  icon?: React.ReactNode;
  title?: string;
  description?: string;
}> = ({ t, selected, onSelect, onDelete, icon, title, description }) => (
  <div
    className={`relative rounded-xl border p-3 transition cursor-pointer ${selected ? 'border-[#2A82E7] ring-2 ring-[#2A82E7]/20 bg-[#F7FAFF]' : 'border-[#D4DFEC] hover:border-[#9FB4D1] bg-white'}`}
    onClick={onSelect}
  >
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label={t?.label || title} />
    <div className="flex items-start gap-2 pointer-events-none">
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${selected ? 'bg-[#2A82E7] text-white' : 'bg-[#EEF5FF] text-[#134074]'}`} aria-hidden="true">
        {selected ? <Check className="w-4 h-4" /> : icon || (t?.builtin ? <LayoutTemplate className="w-4 h-4" /> : <FileStack className="w-4 h-4" />)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-[#111B37] truncate">{t?.label || title}</div>
        <div className="text-[11px] text-[#657794] line-clamp-2">{t?.description || description}</div>
        {t && (
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[#657794]">
            {t.category && <span className="font-semibold uppercase tracking-wide">{t.category}</span>}
            <span>{t.widget_count} widget{t.widget_count === 1 ? '' : 's'}</span>
            <span>
              {t.roles.length} data role{t.roles.length === 1 ? '' : 's'}
            </span>
            {t.variables?.length ? <span>{t.variables.length} variable{t.variables.length === 1 ? '' : 's'}</span> : null}
          </div>
        )}
      </div>
    </div>
    {onDelete && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-2 right-2 p-1 rounded text-[#94A3B8] hover:text-red-600 hover:bg-red-50 z-10"
        aria-label={`Delete template ${t?.label}`}
        title="Delete template"
      >
        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    )}
  </div>
);

const RoleMapping: React.FC<{
  roles: DashboardTemplate['roles'];
  roleMap: Record<string, SourceItem>;
  activeRole: string | null;
  setActiveRole: (id: string | null) => void;
  pickerSel: SourceItem | null;
  setPickerSel: (i: SourceItem | null) => void;
  onMap: (roleId: string, item: SourceItem) => void;
  onUnmap: (roleId: string) => void;
  error: string | null;
}> = ({ roles, roleMap, activeRole, setActiveRole, pickerSel, setPickerSel, onMap, onUnmap, error }) => {
  const { resourcesById } = useSourceCatalog();
  const role = roles.find((r) => r.id === activeRole) || null;
  const used = useMemo(() => new Set(Object.values(roleMap).map((i) => i.token)), [roleMap]);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4 min-h-[420px]">
      <div>
        <ul className="space-y-1.5" aria-label="Data roles">
          {roles.map((r) => {
            const m = roleMap[r.id];
            const on = r.id === activeRole;
            const res = m?.resource_id ? resourcesById.get(m.resource_id) : undefined;
            return (
              <li key={r.id}>
                <div
                  className={`rounded-lg border p-2.5 cursor-pointer ${on ? 'border-[#2A82E7] bg-[#F7FAFF]' : 'border-[#E3EAF3] hover:border-[#CBD5E1] bg-white'}`}
                  onClick={() => setActiveRole(r.id)}
                >
                  <div className="flex items-center gap-2">
                    <button type="button" className="min-w-0 flex-1 text-left focus:outline-none" aria-pressed={on} onClick={() => setActiveRole(r.id)}>
                      <span className="text-[13px] font-semibold text-[#111B37]">{r.label}</span>
                      {r.required ? (
                        <span className="ml-1.5 text-[10px] font-bold uppercase text-red-700">Required</span>
                      ) : (
                        <span className="ml-1.5 text-[10px] font-semibold uppercase text-[#94A3B8]">Optional</span>
                      )}
                      {r.description && <span className="block text-[11px] text-[#657794]">{r.description}</span>}
                      <span className="block text-[10px] text-[#94A3B8]">Accepts {r.value_kinds.length && !r.value_kinds.includes('any') ? r.value_kinds.join(', ') : 'any value'}</span>
                    </button>
                    {m ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUnmap(r.id);
                        }}
                        className="p-1 rounded text-[#94A3B8] hover:text-[#111B37] hover:bg-slate-100"
                        aria-label={`Clear the source of ${r.label}`}
                        title="Clear"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    ) : r.required ? (
                      <CircleAlert className="w-4 h-4 text-amber-600 shrink-0" aria-label="Not mapped" />
                    ) : null}
                  </div>
                  {m ? (
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[#334568] min-w-0">
                      <Check className="w-3 h-3 text-emerald-600 shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {m.kind === 'model_field' ? `${m.model_name} · ${m.field_path}` : m.key || m.label}
                        {res ? ` · ${res.name}` : ''}
                      </span>
                      <CapabilityChip item={m} className="ml-auto" />
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-[#94A3B8]">Not mapped — its widgets will show “No data source”.</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
            {error}
          </p>
        )}
      </div>
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col min-h-[420px] max-h-[60vh]">
        {role ? (
          <>
            <div className="px-3 py-2 border-b border-[#E3EAF3] bg-[#F9FAFD] text-[12px] text-[#334568]">
              Source for <strong className="text-[#111B37]">{role.label}</strong>
            </div>
            <SourcePicker
              className="flex-1"
              acceptKinds={role.value_kinds}
              selectedToken={pickerSel?.token ?? null}
              onSelect={setPickerSel}
              onPick={(item) => onMap(role.id, item)}
              usedTokens={used}
              actions={(item) => (
                <Button size="sm" variant="primary" onClick={() => onMap(role.id, item)}>
                  Use for “{role.label}”
                </Button>
              )}
            />
          </>
        ) : (
          <p className="p-6 text-[12px] text-[#657794]">Select a data role on the left.</p>
        )}
      </div>
    </div>
  );
};
