import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Copy, Check, Save, Trash2, PackageOpen } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { useApp } from '../../store/AppContext';
import { OutputGroup } from '../../types';
import { translateApiError } from '../../utils/apiErrors';

const DEFAULT_TEMPLATE = '{enterprise}/{site}/{area}/{line}/{machine}/{group}';
const TOKENS = [
  '{enterprise}',
  '{site}',
  '{area}',
  '{zone}',
  '{cell}',
  '{line}',
  '{machine}',
  '{group}',
];

function createDraftGroup(resourceId?: string): OutputGroup {
  const stamp = Date.now().toString(36);
  return {
    id: `grp-draft-${stamp}`,
    name: 'New Output Group',
    key: `group-${stamp}`,
    topicTemplate: DEFAULT_TEMPLATE,
    enabled: true,
    publishIntervalMs: 1000,
    assignedSignals: [],
    resourceId,
    version: 1,
    lastPublished: '',
    samplePayload: '',
  };
}

function joinToken(prev: string, token: string): string {
  const base = prev.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  const piece = token.replace(/^\/+/, '');
  return base ? `${base}/${piece}` : piece;
}

function resolvePreviewTopic(
  template: string,
  resources: Array<{ id: string; code: string; type: string; parentId?: string; name: string }>,
  resourceId?: string,
  groupKey?: string,
): string {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const chain: typeof resources = [];
  let cursor = resourceId ? byId.get(resourceId) : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  const ctx: Record<string, string> = {
    enterprise: '',
    site: '',
    area: '',
    zone: '',
    cell: '',
    line: '',
    machine: '',
    group: groupKey || 'group',
  };
  for (const item of chain) {
    if (item.type in ctx) ctx[item.type] = item.code || item.name;
    if (item.type === 'plant' && !ctx.area) ctx.area = item.code || item.name;
    if (item.type === 'machine') ctx.machine = item.code || item.name;
  }
  if (!ctx.machine && chain.length) ctx.machine = chain[chain.length - 1].code || chain[chain.length - 1].name;
  return template
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => ctx[key] || '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

export const OutputGroupsPage: React.FC = () => {
  const { outputGroups, signals, resources, saveOutputGroup } = useApp();
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [copied, setCopied] = useState(false);
  const [dispatchToast, setDispatchToast] = useState<string | null>(null);
  const [topic, setTopic] = useState(DEFAULT_TEMPLATE);
  const [name, setName] = useState('');
  const [scopeResourceId, setScopeResourceId] = useState('');
  const [format, setFormat] = useState<'flat' | 'uns'>('uns');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OutputGroup | null>(null);

  const selectedGroup =
    draft && draft.id === selectedGroupId
      ? draft
      : outputGroups.find((g) => g.id === selectedGroupId) || outputGroups[0] || draft;

  const syncKey = selectedGroup ? `${selectedGroup.id}:${selectedGroup.version ?? 0}` : '';

  useEffect(() => {
    if (!selectedGroup) {
      setTopic(DEFAULT_TEMPLATE);
      setName('');
      setScopeResourceId('');
      setFormat('uns');
      return;
    }
    if (!selectedGroupId) setSelectedGroupId(selectedGroup.id);
    setTopic((selectedGroup.topicTemplate || DEFAULT_TEMPLATE).replace(/^\/+/, ''));
    setName(selectedGroup.name);
    setScopeResourceId(selectedGroup.resourceId || '');
    setFormat(selectedGroup.payloadFormat === 'flat' ? 'flat' : 'uns');
    // Reload the form when the saved group identity or version changes, not on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  const previewTopic = useMemo(
    () => resolvePreviewTopic(topic, resources, scopeResourceId, selectedGroup?.key || 'group'),
    [topic, resources, scopeResourceId, selectedGroup?.key],
  );

  const projectedPayload = JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      topic: previewTopic,
      metrics: (selectedGroup?.assignedSignals || []).reduce((acc, sigId) => {
        const found = signals.find((s) => s.id === sigId);
        if (!found) return acc;
        acc[found.tag] =
          format === 'flat'
            ? found.currentValue
            : {
                value: found.currentValue,
                unit: found.unit,
                quality: found.quality,
                timestamp: found.lastUpdated,
              };
        return acc;
      }, {} as Record<string, unknown>),
    },
    null,
    2,
  );

  const handleCreateGroup = () => {
    if (!resources.length) {
      setPageError('Create a resource in the factory model before an output group.');
      return;
    }
    const next = createDraftGroup(resources[0]?.id);
    setDraft(next);
    setSelectedGroupId(next.id);
    setTopic(next.topicTemplate);
    setName(next.name);
    setScopeResourceId(next.resourceId || '');
    setFormat('uns');
    setPageError(null);
  };

  const handleSave = async () => {
    if (!selectedGroup) return;
    setPageError(null);
    try {
      const savedId = await saveOutputGroup({
        ...selectedGroup,
        name: name.trim() || selectedGroup.name,
        topicTemplate: topic.trim().replace(/^\/+/, ''),
        resourceId: scopeResourceId || selectedGroup.resourceId,
        payloadFormat: format,
        samplePayload: projectedPayload,
      });
      setDraft(null);
      if (savedId) setSelectedGroupId(savedId);
      setDispatchToast(`Saved output group “${name.trim() || selectedGroup.name}”`);
      setTimeout(() => setDispatchToast(null), 3000);
    } catch (error) {
      setPageError(translateApiError(error));
    }
  };

  const updateMembers = (ids: string[]) => {
    if (!selectedGroup) return;
    const next = {
      ...selectedGroup,
      assignedSignals: ids,
      name,
      topicTemplate: topic.replace(/^\/+/, ''),
      resourceId: scopeResourceId,
      payloadFormat: format,
    };
    if (selectedGroup.id.startsWith('grp-draft-')) setDraft(next);
    else {
      void saveOutputGroup(next).catch((error) => setPageError(translateApiError(error)));
    }
  };

  if (!selectedGroup) {
    return (
      <div className="space-y-4 animate-in fade-in duration-200">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="fx-page-title">Output Groups & UNS Projections</h1>
            <p className="fx-page-subtitle">
              Unified Namespace topic formatting, payload templates, and northbound dispatch.
            </p>
          </div>
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={handleCreateGroup}>
            Create Output Group
          </Button>
        </div>
        {pageError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</div>
        )}
        <Card className="py-16">
          <div className="flex flex-col items-center justify-center text-center gap-3">
            <PackageOpen className="w-10 h-10 text-[#94A3B8]" />
            <h2 className="text-base font-bold text-[#111B37]">No output groups yet</h2>
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={handleCreateGroup}>
              Create Output Group
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Output Groups & UNS Projections</h1>
          <p className="fx-page-subtitle">
            Unified Namespace topic formatting, payload templates, and northbound dispatch.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="primary" icon={<Save className="w-4 h-4" />} onClick={() => void handleSave()}>
            Save Output Group
          </Button>
        </div>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</div>
      )}
      {dispatchToast && (
        <div className="p-3 bg-slate-900 text-white rounded-xl text-xs font-semibold shadow-lg">{dispatchToast}</div>
      )}

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-3">
          <Card className="h-[730px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase text-[#111B37]">
                Output Groups ({outputGroups.length})
              </span>
              <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleCreateGroup}>
                New
              </Button>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {[...outputGroups, ...(draft ? [draft] : [])].map((g) => {
                const isSelected = g.id === selectedGroup.id;
                return (
                  <div
                    key={g.id}
                    onClick={() => {
                      setSelectedGroupId(g.id);
                      setTopic((g.topicTemplate || DEFAULT_TEMPLATE).replace(/^\/+/, ''));
                      setName(g.name);
                      setScopeResourceId(g.resourceId || '');
                      setFormat(g.payloadFormat === 'flat' ? 'flat' : 'uns');
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[#EF1B24] bg-[#FFF0F1]/50'
                        : 'border-[#E3EAF3] bg-white hover:border-[#94A3B8]'
                    }`}
                  >
                    <div className="text-[13px] font-bold text-[#111B37] truncate">{g.name}</div>
                    <div className="font-mono text-[10px] text-[#657794] truncate">{g.topicTemplate}</div>
                    <div className="text-[11px] text-[#94A3B8] mt-1.5">
                      {g.assignedSignals.length === 1 ? '1 signal' : `${g.assignedSignals.length} signals`}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          <Card title="Group details">
            <div className="space-y-3 text-[12px]">
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="fx-input text-[13px]"
                />
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Scope resource</label>
                <select
                  value={scopeResourceId}
                  onChange={(e) => setScopeResourceId(e.target.value)}
                  className="fx-input text-[13px]"
                >
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Payload format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value === 'flat' ? 'flat' : 'uns')}
                  className="fx-input text-[13px]"
                >
                  <option value="uns">UNS JSON</option>
                  <option value="flat">Flat JSON</option>
                </select>
                <p className="mt-1 text-[11px] text-[#94A3B8]">Sparkplug B is not available on this appliance.</p>
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Target broker</label>
                <div className="font-semibold text-[#111B37]">
                  No northbound broker is configured. Send test stays hidden.
                </div>
              </div>
            </div>
          </Card>

          <Card title="UNS Topic Template" subtitle="Tokens without a leading slash">
            <div className="space-y-3">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value.replace(/^\/+/, ''))}
                className="fx-input font-mono text-[12px]"
              />
              <div className="text-[11px] text-[#657794]">
                Preview: <span className="font-mono text-[#111B37] font-semibold">{previewTopic || '—'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-[#657794] font-semibold">Tokens:</span>
                {TOKENS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTopic((prev) => joinToken(prev, t))}
                    className="px-2 py-0.5 rounded bg-[#F1F5FA] hover:bg-[#E3EAF3] font-mono text-[#2A82E7] font-semibold border border-[#D4DFEC]"
                  >
                    +{t}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card
            title="Bundled signals"
            action={
              <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setPickerOpen(true)}>
                Add signal
              </Button>
            }
          >
            <div className="space-y-2 text-[12px]">
              {(selectedGroup.assignedSignals || []).length === 0 ? (
                <p className="py-6 text-center text-[#94A3B8]">No signals bundled yet.</p>
              ) : (
                selectedGroup.assignedSignals.map((sigId) => {
                  const sig = signals.find((s) => s.id === sigId);
                  return (
                    <div
                      key={sigId}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]"
                    >
                      <span className="font-mono text-[#111B37] font-semibold">
                        {sig ? `${sig.name} · ${sig.tag}` : sigId}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updateMembers(selectedGroup.assignedSignals.filter((id) => id !== sigId))
                        }
                        className="text-[#94A3B8] hover:text-[#F2343B] p-1 rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-4 space-y-3.5">
          <Card
            title="Northbound JSON payload"
            subtitle="Projected from current signal state"
            action={
              <Button
                size="sm"
                variant="secondary"
                icon={copied ? <Check className="w-3.5 h-3.5 text-[#0DBA67]" /> : <Copy className="w-3.5 h-3.5" />}
                onClick={() => {
                  void navigator.clipboard.writeText(projectedPayload);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            }
          >
            <div className="rounded-xl bg-[#111B2E] overflow-hidden">
              <div className="px-3 py-1.5 bg-[#1A253C] flex justify-between text-[11px] text-[#94A3B8] font-mono">
                <span>payload.json</span>
                <span>{previewTopic || 'topic'}</span>
              </div>
              <pre className="p-4 text-[#0DBA67] font-mono text-[11px] leading-relaxed overflow-x-auto max-h-[580px]">
                {projectedPayload}
              </pre>
            </div>
          </Card>
        </div>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-5 space-y-3 max-h-[80vh] overflow-y-auto">
            <h3 className="text-base font-bold">Pick signals</h3>
            {signals.map((sig) => {
              const checked = selectedGroup.assignedSignals.includes(sig.id);
              return (
                <label key={sig.id} className="flex items-center gap-2 text-xs py-1">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? selectedGroup.assignedSignals.filter((id) => id !== sig.id)
                        : [...selectedGroup.assignedSignals, sig.id];
                      updateMembers(next);
                    }}
                  />
                  <span className="font-semibold">{sig.name}</span>
                  <span className="font-mono text-slate-500">{sig.tag}</span>
                </label>
              );
            })}
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setPickerOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
