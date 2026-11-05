import React, { useEffect, useState, useMemo } from 'react';
import {
  Boxes,
  Plus,
  ArrowLeft,
  Trash2,
  Save,
  RefreshCw,
  Eye,
  Settings2,
  Calculator,
  CheckCircle2,
  AlertTriangle,
  Radio,
  ExternalLink,
} from 'lucide-react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { api } from '../../api/client';

interface OutputGroupMember {
  signal_id: string;
  output_alias: string;
  ordinal: number;
}

interface OutputGroupModel {
  id: string;
  key: string;
  display_name: string;
  topic_template: string;
  resource_id: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  version: number;
  members?: OutputGroupMember[];
  updated_at?: string;
}

interface PreviewResult {
  topic?: string;
  payload?: Record<string, unknown>;
  fields?: Record<string, { value: unknown; quality: string; source_time?: string }>;
}

function timeAgo(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 0 || isNaN(diffSec)) return 'just now';
  if (diffSec < 60) return `${diffSec} s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  return `${Math.floor(diffHour / 24)} d ago`;
}

export const OutputGroupsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { resources, signals, refresh } = useApp();

  const [models, setModels] = useState<OutputGroupModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  // Active Workspace Tab (Design / Preview / Calculations)
  const initialTab = searchParams.get('tab') === 'calculations' ? 'calculations' : 'design';
  const [workspaceTab, setWorkspaceTab] = useState<'design' | 'preview' | 'calculations'>(initialTab);

  // Workspace Form State
  const [name, setName] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [topicTemplate, setTopicTemplate] = useState('');
  const [members, setMembers] = useState<Array<{ id: string; alias: string; signalId: string }>>([]);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [archiveTarget, setArchiveTarget] = useState<OutputGroupModel | null>(null);

  // Live Preview State
  const [previewData, setPreviewData] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Fetch Output Groups
  const fetchModels = async () => {
    setLoading(true);
    try {
      const res = await api<{ items: OutputGroupModel[] }>('/api/v1/output-groups');
      const active = (res.items || []).filter((m) => m.status !== 'ARCHIVED');
      setModels(active);
    } catch {
      // fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchModels();
  }, []);

  // When model is selected, load its detail
  const selectModel = async (model: OutputGroupModel) => {
    setSelectedModelId(model.id);
    setIsNew(false);
    setFieldErrors({});
    setSaveSuccess(false);

    try {
      const detail = await api<OutputGroupModel>(`/api/v1/output-groups/${model.id}`);
      setName(detail.display_name || detail.key);
      setScopeId(detail.resource_id);
      setTopicTemplate(detail.topic_template || '');
      const mems = (detail.members || []).map((m, idx) => ({
        id: `m-${idx}`,
        alias: m.output_alias,
        signalId: m.signal_id,
      }));
      setMembers(mems);
    } catch {
      setName(model.display_name || model.key);
      setScopeId(model.resource_id);
      setTopicTemplate(model.topic_template || '');
      setMembers([]);
    }
  };

  const handleCreateModel = () => {
    const defaultScope = resources.find((r) => r.type === 'machine')?.id || resources[0]?.id || '';
    setSelectedModelId('new');
    setIsNew(true);
    setName('');
    setScopeId(defaultScope);
    setTopicTemplate('{enterprise}/{site}/{area}/{zone}/{line}/{machine}/state');
    setMembers([
      { id: 'm-0', alias: 'status', signalId: '' },
    ]);
    setFieldErrors({});
    setWorkspaceTab('design');
  };

  // Scoped resource path resolution for topic preview
  const selectedResource = useMemo(() => {
    return resources.find((r) => r.id === scopeId);
  }, [resources, scopeId]);

  // Available tokens based on ISA-95 levels
  const availableTokens = ['enterprise', 'site', 'area', 'zone', 'line', 'machine'];

  // Resolve topic preview using resource hierarchy
  const resolvedTopicPreview = useMemo(() => {
    if (!topicTemplate) return '—';
    if (!selectedResource) return topicTemplate;

    // Build map of level types to codes from ancestors
    const levelMap: Record<string, string> = {};
    let curr: typeof selectedResource | undefined = selectedResource;
    while (curr) {
      if (curr.type) levelMap[curr.type.toLowerCase()] = curr.code;
      curr = resources.find((r) => r.id === curr?.parentId);
    }

    let resolved = topicTemplate;
    for (const [lvl, code] of Object.entries(levelMap)) {
      resolved = resolved.replace(new RegExp(`\\{${lvl}\\}`, 'g'), code);
    }
    // Clean up any remaining braces if not in ancestry
    return resolved;
  }, [topicTemplate, selectedResource, resources]);

  // Available signals for selected resource
  const resourceSignals = useMemo(() => {
    if (!scopeId) return signals;
    return signals.filter((s) => s.resourceId === scopeId);
  }, [signals, scopeId]);

  // Validations
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'Enter a model name.';

    if (topicTemplate.startsWith('/')) {
      errors.topicTemplate = 'Topic templates should not start with "/".';
    }

    // Alias validation
    const seenAliases = new Set<string>();
    members.forEach((m, idx) => {
      const alias = m.alias.trim();
      if (!alias) {
        errors[`alias-${idx}`] = 'Alias is required.';
      } else if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)) {
        errors[`alias-${idx}`] = 'Aliases start with a letter or _ (e.g. status, speed_1).';
      } else if (seenAliases.has(alias.toLowerCase())) {
        errors[`alias-${idx}`] = 'Each alias must be unique in this model.';
      } else {
        seenAliases.add(alias.toLowerCase());
      }
    });

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Save handler (POST if new, PATCH if update)
  const handleSave = async () => {
    if (!validateForm()) return;
    setSaving(true);
    setSaveSuccess(false);

    try {
      const payloadMembers = members
        .filter((m) => m.alias && m.signalId)
        .map((m, idx) => ({
          signal_id: m.signalId,
          output_alias: m.alias.trim(),
          ordinal: idx,
        }));

      let cleanTopic = topicTemplate.trim();
      if (cleanTopic.startsWith('/')) cleanTopic = cleanTopic.replace(/^\/+/, '');

      if (isNew) {
        const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 50);
        const created = await api<OutputGroupModel>('/api/v1/output-groups', {
          method: 'POST',
          body: JSON.stringify({
            key: slug,
            display_name: name.trim(),
            topic_template: cleanTopic,
            resource_id: scopeId,
            members: payloadMembers,
          }),
        });
        setIsNew(false);
        setSelectedModelId(created.id);
      } else if (selectedModelId) {
        const currentModel = models.find((m) => m.id === selectedModelId);
        await api(`/api/v1/output-groups/${selectedModelId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version: currentModel?.version ?? 1,
            display_name: name.trim(),
            topic_template: cleanTopic,
            members: payloadMembers,
          }),
        });
      }

      await fetchModels();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setFieldErrors({ general: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  // Archive model
  const handleArchive = async () => {
    if (!archiveTarget) return;
    const target = archiveTarget;
    setArchiveTarget(null);
    try {
      await api(`/api/v1/output-groups/${target.id}`, { method: 'DELETE' });
      await fetchModels();
      setSelectedModelId(null);
    } catch {
      // ignore
    }
  };

  // Live preview poller (every 2s in preview tab)
  useEffect(() => {
    if (workspaceTab !== 'preview' || !selectedModelId || selectedModelId === 'new') {
      setPreviewData(null);
      return;
    }

    let isMounted = true;
    const pollPreview = async () => {
      try {
        const res = await api<PreviewResult>(`/api/v1/output-groups/${selectedModelId}/preview`);
        if (isMounted) setPreviewData(res);
      } catch {
        if (isMounted) setPreviewData(null);
      }
    };

    void pollPreview();
    const interval = setInterval(pollPreview, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [workspaceTab, selectedModelId]);

  return (
    <div className="space-y-6">
      {/* VIEW 1: CATALOG (List of Models) */}
      {!selectedModelId && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-[20px] font-bold text-[#111B37]">Model Catalog</h1>
              <p className="text-[13px] text-[#657794]">
                Define unified namespace (UNS) topics and output models published across your factory
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={handleCreateModel}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Create model
            </Button>
          </div>

          <Card className="border border-[#CBD5E1] bg-white overflow-hidden">
            {models.length === 0 ? (
              <div className="p-12 text-center text-[#657794]">
                <Boxes className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <h3 className="text-[14px] font-bold text-[#111B37]">No data models yet</h3>
                <p className="text-[12px] text-[#657794] mt-1 mb-4">
                  Group your signals into clean semantic topics with standard aliases.
                </p>
                <Button variant="primary" size="sm" onClick={handleCreateModel}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Create model
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-[#657794] font-semibold">
                      <th className="py-3 px-4">Name</th>
                      <th className="py-3 px-4">Scope</th>
                      <th className="py-3 px-4">Fields</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {models.map((model) => {
                      const res = resources.find((r) => r.id === model.resource_id);
                      return (
                        <tr
                          key={model.id}
                          onClick={() => void selectModel(model)}
                          className="hover:bg-slate-50 cursor-pointer transition"
                        >
                          <td className="py-3.5 px-4 font-bold text-[#111B37]">
                            {model.display_name || model.key}
                          </td>
                          <td className="py-3.5 px-4 text-[#657794] font-mono text-[11px]">
                            {res?.name || '—'}
                          </td>
                          <td className="py-3.5 px-4 text-[#111B37] font-semibold">
                            {model.members ? model.members.length : 0} fields
                          </td>
                          <td className="py-3.5 px-4">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${
                                model.status === 'PUBLISHED'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {model.status === 'PUBLISHED' ? 'Published' : 'Draft'}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right text-[#657794]">
                            {timeAgo(model.updated_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* VIEW 2: MODEL WORKSPACE (Design / Live Preview / Calculations) */}
      {selectedModelId && (
        <div className="space-y-4">
          {/* Header & Navigation */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedModelId(null);
                  setWorkspaceTab('design');
                }}
              >
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                All models
              </Button>
              <h2 className="text-[18px] font-bold text-[#111B37]">
                {name || 'New Model'}
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 uppercase">
                {isNew ? 'New Draft' : 'Draft'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {saveSuccess && (
                <span className="text-[12px] font-semibold text-emerald-600 flex items-center mr-2">
                  <CheckCircle2 className="w-4 h-4 mr-1" /> Saved
                </span>
              )}

              {!isNew && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const currentModel = models.find((m) => m.id === selectedModelId);
                    if (currentModel) setArchiveTarget(currentModel);
                  }}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  Archive
                </Button>
              )}

              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving}
              >
                <Save className="w-3.5 h-3.5 mr-1.5" />
                {saving ? 'Saving…' : 'Save model'}
              </Button>
            </div>
          </div>

          {/* Workspace Tabs (Design / Live preview / Calculations) */}
          <div className="flex items-center gap-2 border-b border-slate-200">
            <button
              onClick={() => setWorkspaceTab('design')}
              className={`flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold border-b-2 transition ${
                workspaceTab === 'design'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-[#657794] hover:text-[#111B37]'
              }`}
            >
              <Settings2 className="w-3.5 h-3.5" />
              Design
            </button>
            <button
              onClick={() => setWorkspaceTab('preview')}
              disabled={isNew}
              className={`flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold border-b-2 transition ${
                workspaceTab === 'preview'
                  ? 'border-blue-600 text-blue-600'
                  : isNew
                  ? 'border-transparent text-slate-300 cursor-not-allowed'
                  : 'border-transparent text-[#657794] hover:text-[#111B37]'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              Live preview
            </button>
            <button
              onClick={() => setWorkspaceTab('calculations')}
              className={`flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold border-b-2 transition ${
                workspaceTab === 'calculations'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-[#657794] hover:text-[#111B37]'
              }`}
            >
              <Calculator className="w-3.5 h-3.5" />
              Calculations
              <span className="text-[10px] font-normal px-1.5 py-0.2 bg-slate-100 rounded text-slate-600">Soon</span>
            </button>
          </div>

          {/* TAB 1: DESIGN */}
          {workspaceTab === 'design' && (
            <div className="space-y-6">
              {fieldErrors.general && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded-lg">
                  {fieldErrors.general}
                </div>
              )}

              {/* Basic Settings */}
              <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">
                      Model Name*
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. AA10-02 State"
                      className={`w-full px-3 py-2 border rounded text-[13px] focus:outline-none focus:border-blue-500 ${
                        fieldErrors.name ? 'border-red-400 bg-red-50/20' : 'border-slate-300'
                      }`}
                    />
                    {fieldErrors.name && (
                      <p className="text-[11px] text-red-600 mt-1">{fieldErrors.name}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">
                      Resource Scope*
                    </label>
                    <select
                      value={scopeId}
                      onChange={(e) => setScopeId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] bg-white text-slate-700 focus:outline-none focus:border-blue-500"
                    >
                      {resources.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.type})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Topic Template */}
                <div className="pt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-semibold uppercase text-[#657794]">
                      Topic Template*
                    </label>
                    <span className="text-[11px] text-[#657794]">
                      Click token chips to insert into template
                    </span>
                  </div>

                  {/* Token Chips */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-2">
                    {availableTokens.map((tok) => (
                      <button
                        key={tok}
                        type="button"
                        onClick={() => {
                          const addition = topicTemplate.endsWith('/') || !topicTemplate ? `{${tok}}` : `/{${tok}}`;
                          setTopicTemplate((prev) => prev + addition);
                        }}
                        className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 hover:bg-blue-100 transition border border-blue-200"
                      >
                        +{`{${tok}}`}
                      </button>
                    ))}
                  </div>

                  <input
                    type="text"
                    value={topicTemplate}
                    onChange={(e) => setTopicTemplate(e.target.value)}
                    placeholder="e.g. {enterprise}/{site}/{area}/{zone}/{line}/{machine}/state"
                    className={`w-full px-3 py-2 border rounded font-mono text-[12px] focus:outline-none focus:border-blue-500 ${
                      fieldErrors.topicTemplate ? 'border-red-400 bg-red-50/20' : 'border-slate-300'
                    }`}
                  />
                  {fieldErrors.topicTemplate && (
                    <p className="text-[11px] text-red-600 mt-1">{fieldErrors.topicTemplate}</p>
                  )}

                  {/* Resolved Topic Preview */}
                  <div className="mt-2 p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px] flex items-center justify-between">
                    <span className="text-[#657794]">Resolved topic for selected resource:</span>
                    <span className="font-mono text-[#111B37] font-semibold">
                      {resolvedTopicPreview}
                    </span>
                  </div>
                </div>
              </Card>

              {/* Field Mappings */}
              <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#111B37]">Field mappings</h3>
                    <p className="text-[12px] text-[#657794]">Map signals to normalized JSON payload aliases</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setMembers((prev) => [
                        ...prev,
                        { id: `m-${Date.now()}`, alias: '', signalId: '' },
                      ])
                    }
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    Add field
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[#657794] font-semibold">
                        <th className="py-2.5 px-3">Alias in JSON</th>
                        <th className="py-2.5 px-3">Source Signal</th>
                        <th className="py-2.5 px-3 text-right w-16">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {members.map((m, idx) => (
                        <tr key={m.id}>
                          <td className="py-2.5 px-3 align-top">
                            <input
                              type="text"
                              value={m.alias}
                              onChange={(e) => {
                                const val = e.target.value;
                                setMembers((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, alias: val } : item))
                                );
                              }}
                              placeholder="e.g. status, operator"
                              className={`w-full px-3 py-1.5 border rounded font-mono text-[12px] focus:outline-none focus:border-blue-500 ${
                                fieldErrors[`alias-${idx}`]
                                  ? 'border-red-400 bg-red-50/20'
                                  : 'border-slate-300'
                              }`}
                            />
                            {fieldErrors[`alias-${idx}`] && (
                              <p className="text-[11px] text-red-600 mt-1">
                                {fieldErrors[`alias-${idx}`]}
                              </p>
                            )}
                          </td>
                          <td className="py-2.5 px-3 align-top">
                            <select
                              value={m.signalId}
                              onChange={(e) => {
                                const val = e.target.value;
                                setMembers((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, signalId: val } : item))
                                );
                              }}
                              className="w-full px-3 py-1.5 border border-slate-300 rounded text-[12px] bg-white text-slate-700 focus:outline-none focus:border-blue-500"
                            >
                              <option value="">Select a signal…</option>
                              {resourceSignals.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.displayName || s.name || s.key} ({s.dataType || 'Float32'})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 text-right align-top">
                            <button
                              onClick={() =>
                                setMembers((prev) => prev.filter((_, i) => i !== idx))
                              }
                              className="p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                              aria-label="Remove field"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}

          {/* TAB 2: LIVE PREVIEW */}
          {workspaceTab === 'preview' && (
            <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div>
                  <h3 className="text-[14px] font-bold text-[#111B37]">Live JSON preview</h3>
                  <p className="text-[12px] text-[#657794]">
                    Refreshes automatically every 2 seconds from active observations
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#0DBA67] animate-pulse" />
                  <span className="text-[12px] font-medium text-[#111B37]">Live streaming</span>
                </div>
              </div>

              {previewData?.topic && (
                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <span className="text-[11px] uppercase font-bold text-[#657794] block mb-1">
                    Topic Destination
                  </span>
                  <span className="font-mono text-[12px] text-[#111B37] font-semibold">
                    {previewData.topic}
                  </span>
                </div>
              )}

              {/* JSON Code Box */}
              <div className="bg-slate-900 text-slate-100 p-4 rounded-xl font-mono text-[12px] overflow-x-auto shadow-inner">
                <pre>
                  {previewData?.payload
                    ? JSON.stringify(previewData.payload, null, 2)
                    : '// Awaiting preview observations…'}
                </pre>
              </div>

              {/* Field status breakdown */}
              {previewData?.fields && (
                <div className="pt-3 border-t border-slate-100">
                  <h4 className="text-[12px] font-bold text-[#111B37] mb-2">Fields status breakdown</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {Object.entries(previewData.fields).map(([alias, f]) => {
                      const isNoData = f.value === null || f.quality === 'NO_DATA';
                      return (
                        <div key={alias} className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px]">
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-[#111B37]">{alias}</span>
                            <StatusBadge status={f.quality} />
                          </div>
                          <div className="text-[14px] font-bold text-[#111B37] mt-1">
                            {isNoData ? (
                              <span className="text-slate-400 font-normal">null (No data)</span>
                            ) : (
                              String(f.value)
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* TAB 3: CALCULATIONS (COMING SOON) */}
          {workspaceTab === 'calculations' && (
            <Card className="p-12 border border-[#CBD5E1] bg-white text-center">
              <Calculator className="w-12 h-12 text-blue-500 mx-auto mb-3" />
              <h3 className="text-[16px] font-bold text-[#111B37]">Calculations</h3>
              <p className="text-[13px] text-[#657794] mt-1 max-w-md mx-auto">
                Calculations are coming to Data Models. You will be able to write formulas and compute derived metrics directly in your output models.
              </p>
              <div className="mt-4">
                <span className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-50 text-blue-700">
                  Formula engine backend integration in progress
                </span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Archive Confirm Modal (TC-UI-DM-10) */}
      <ConfirmDialog
        isOpen={Boolean(archiveTarget)}
        title={`Archive model "${archiveTarget?.display_name || archiveTarget?.key}"?`}
        message="This data model will be archived and will stop publishing to this topic template."
        confirmLabel="Archive"
        variant="danger"
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
};
