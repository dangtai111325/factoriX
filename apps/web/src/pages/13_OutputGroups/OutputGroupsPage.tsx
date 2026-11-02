import React, { useEffect, useState } from 'react';
import {
  Plus,
  Play,
  Copy,
  Check,
  Save,
  Trash2,
  PackageOpen,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { useApp } from '../../store/AppContext';
import { OutputGroup } from '../../types';

function createDraftGroup(): OutputGroup {
  const stamp = Date.now().toString(36);
  return {
    id: `grp-draft-${stamp}`,
    name: 'New Output Group',
    topicTemplate: 'enterprise/site/plant/telemetry',
    enabled: true,
    publishIntervalMs: 1000,
    assignedSignals: [],
    lastPublished: '',
    samplePayload: '',
  };
}

export const OutputGroupsPage: React.FC = () => {
  const { outputGroups, signals, saveOutputGroup } = useApp();
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [dispatchToast, setDispatchToast] = useState<string | null>(null);
  const [topic, setTopic] = useState<string>('');

  const selectedGroup =
    outputGroups.find((g) => g.id === selectedGroupId) || outputGroups[0] || null;

  useEffect(() => {
    if (!selectedGroup) {
      setSelectedGroupId('');
      setTopic('');
      return;
    }
    if (!selectedGroupId || !outputGroups.some((g) => g.id === selectedGroupId)) {
      setSelectedGroupId(selectedGroup.id);
    }
    setTopic(selectedGroup.topicTemplate);
  }, [selectedGroup, selectedGroupId, outputGroups]);

  const handleCreateGroup = () => {
    const draft = createDraftGroup();
    setSelectedGroupId(draft.id);
    setTopic(draft.topicTemplate);
    saveOutputGroup(draft);
    setDispatchToast(`Creating "${draft.name}"…`);
    setTimeout(() => setDispatchToast(null), 3000);
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

        {dispatchToast && (
          <div className="p-3 bg-slate-900 text-white rounded-xl text-xs font-semibold shadow-lg">
            {dispatchToast}
          </div>
        )}

        <Card className="py-16">
          <div className="flex flex-col items-center justify-center text-center gap-3">
            <PackageOpen className="w-10 h-10 text-[#94A3B8]" />
            <h2 className="text-base font-bold text-[#111B37]">No output groups yet</h2>
            <p className="text-xs text-[#657794] max-w-md">
              Create an output group to define a UNS topic template and bundle signals for
              northbound publish.
            </p>
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={handleCreateGroup}>
              Create Output Group
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const projectedPayload = JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      topic,
      qos: 1,
      source: 'FactoriX-UNS-Publisher-v1',
      metrics: selectedGroup.assignedSignals.reduce((acc, sigId) => {
        const found = signals.find((s) => s.id === sigId);
        if (found) {
          acc[found.tag] = {
            value: found.currentValue,
            unit: found.unit,
            quality: found.quality,
            timestamp: found.lastUpdated,
          };
        } else {
          acc[sigId] = { value: 0, status: 'NOT_FOUND' };
        }
        return acc;
      }, {} as Record<string, unknown>),
    },
    null,
    2
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(projectedPayload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    saveOutputGroup({
      ...selectedGroup,
      topicTemplate: topic,
      samplePayload: projectedPayload,
    });
    setDispatchToast(`Saved output group "${selectedGroup.name}"`);
    setTimeout(() => setDispatchToast(null), 3000);
  };

  const handleTestDispatch = () => {
    setDispatchToast(
      `[Simulated Dispatch] Published message to "${topic}" (${selectedGroup.assignedSignals.length} metrics bundled)`
    );
    setTimeout(() => setDispatchToast(null), 4000);
  };

  const handleRemoveSignal = (sigId: string) => {
    const updated = selectedGroup.assignedSignals.filter((id) => id !== sigId);
    saveOutputGroup({
      ...selectedGroup,
      assignedSignals: updated,
    });
  };

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
          <Button
            variant="secondary"
            icon={<Play className="w-4 h-4 text-[#0DBA67]" />}
            onClick={handleTestDispatch}
          >
            Test Dispatch (Simulated)
          </Button>
          <Button variant="primary" icon={<Save className="w-4 h-4" />} onClick={handleSave}>
            Save Output Group
          </Button>
        </div>
      </div>

      {dispatchToast && (
        <div className="p-3 bg-slate-900 text-white rounded-xl text-xs font-semibold shadow-lg flex items-center justify-between animate-in fade-in">
          <span>{dispatchToast}</span>
        </div>
      )}

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-3">
          <Card className="h-[730px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase text-[#111B37]">
                Output Groups ({outputGroups.length})
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={handleCreateGroup}
              >
                New
              </Button>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {outputGroups.map((g) => {
                const isSelected = g.id === selectedGroup.id;
                return (
                  <div
                    key={g.id}
                    onClick={() => {
                      setSelectedGroupId(g.id);
                      setTopic(g.topicTemplate);
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[#EF1B24] bg-[#FFF0F1]/50 ring-2 ring-[#FFF0F1]'
                        : 'border-[#E3EAF3] bg-white hover:border-[#94A3B8]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-bold text-[#111B37] truncate">{g.name}</span>
                      <span
                        className={`w-2 h-2 rounded-full ${g.enabled ? 'bg-[#0DBA67]' : 'bg-[#94A3B8]'}`}
                      />
                    </div>
                    <div className="font-mono text-[10px] text-[#657794] truncate">{g.topicTemplate}</div>
                    <div className="text-[11px] text-[#94A3B8] mt-1.5 flex justify-between">
                      <span>{g.assignedSignals.length} tags bundled</span>
                      <span>{g.publishIntervalMs} ms</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          <Card title="UNS Topic Template" subtitle="Hierarchical MQTT/Kafka topic formatting pattern:">
            <div className="space-y-3">
              <div>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  className="fx-input font-mono text-[12px]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-[#657794] font-semibold">Tokens:</span>
                {['{enterprise}', '{site}', '{plant}', '{line}', '{machine}', 'telemetry', 'state'].map(
                  (t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTopic((prev) => `${prev}/${t}`)}
                      className="px-2 py-0.5 rounded bg-[#F1F5FA] hover:bg-[#E3EAF3] font-mono text-[#2A82E7] font-semibold border border-[#D4DFEC]"
                    >
                      +{t}
                    </button>
                  )
                )}
              </div>
            </div>
          </Card>

          <Card
            title="Bundled Payload Signals"
            action={
              <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} disabled>
                Add Signal
              </Button>
            }
          >
            <div className="space-y-2 text-[12px]">
              {selectedGroup.assignedSignals.length === 0 ? (
                <p className="py-6 text-center text-[#94A3B8]">No signals bundled in this group yet.</p>
              ) : (
                selectedGroup.assignedSignals.map((sigId, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0DBA67]" />
                      <span className="font-mono text-[#111B37] font-semibold">{sigId}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveSignal(sigId)}
                      className="text-[#94A3B8] hover:text-[#F2343B] p-1 rounded"
                      title="Remove signal from output group"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card title="Publication Dispatch Settings">
            <div className="grid grid-cols-2 gap-3 text-[12px]">
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Publish Interval</label>
                <div className="font-mono font-bold text-[#111B37]">
                  {selectedGroup.publishIntervalMs} ms
                </div>
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">QoS Level</label>
                <div className="font-mono font-bold text-[#111B37]">QoS 1 (At least once)</div>
              </div>
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-4 space-y-3.5">
          <Card
            title="Northbound JSON Payload"
            subtitle="Projected message from current signal state:"
            action={
              <Button
                size="sm"
                variant="secondary"
                icon={
                  copied ? (
                    <Check className="w-3.5 h-3.5 text-[#0DBA67]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )
                }
                onClick={handleCopy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            }
          >
            <div className="rounded-xl bg-[#111B2E] overflow-hidden">
              <div className="px-3 py-1.5 bg-[#1A253C] flex justify-between text-[11px] text-[#94A3B8] font-mono">
                <span>payload.json</span>
                <span className="text-[#94A3B8]">Projection</span>
              </div>
              <pre className="p-4 text-[#0DBA67] font-mono text-[11px] leading-relaxed overflow-x-auto max-h-[580px]">
                {projectedPayload}
              </pre>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
