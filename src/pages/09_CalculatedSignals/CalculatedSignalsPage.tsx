import React, { useState } from 'react';
import {
  Sigma,
  Plus,
  Play,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Code,
  BookOpen,
  ArrowRight,
  Save,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';

export const CalculatedSignalsPage: React.FC = () => {
  const [formula, setFormula] = useState<string>(
    'clamp((sig("CNC_01.SPINDLE.TEMP") - 20) / 40.0 * (sig("CNC_01.SPINDLE.ACTUAL_RPM") / 15000.0), 0.0, 1.0)'
  );
  const [ruleName, setRuleName] = useState('Calculated Thermal Load Index');
  const [targetTag, setTargetTag] = useState('CALC.CNC01.THERMAL_LOAD');
  const [unit, setUnit] = useState('index');
  const [isValidating, setIsValidating] = useState(false);
  const [evalResult, setEvalResult] = useState<number | null>(0.78);

  const handleValidate = async () => {
    setIsValidating(true);
    await new Promise((r) => setTimeout(r, 400));
    setIsValidating(false);
    setEvalResult(0.78);
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1 & 2: Heading & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Calculated Signals & Formula Engine</h1>
          <p className="fx-page-subtitle">
            Deterministic AST expression editor, derived signals, and math calculations.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            icon={<Play className="w-4 h-4 text-[#0DBA67]" />}
            onClick={handleValidate}
            loading={isValidating}
          >
            Validate & Test
          </Button>
          <Button variant="primary" icon={<Save className="w-4 h-4" />}>
            Save Rule Draft
          </Button>
        </div>
      </div>

      {/* Main Grid: Left Rules List (Reg 3) - Center Editor (Reg 4, 8, 9) - Right Helpers (Reg 5, 6, 7) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Region 3: Calculated Rules List */}
        <div className="col-span-12 lg:col-span-3">
          <Card className="h-[730px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase text-[#111B37]">
                Calculated Tags (3)
              </span>
              <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />}>
                New
              </Button>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {[
                {
                  id: 'c1',
                  name: 'Thermal Load Index',
                  tag: 'CALC.CNC01.THERMAL_LOAD',
                  status: 'active',
                  cost: '4.2 µs',
                },
                {
                  id: 'c2',
                  name: 'OEE Line01 Performance',
                  tag: 'CALC.LINE01.OEE_PERF',
                  status: 'active',
                  cost: '12.0 µs',
                },
                {
                  id: 'c3',
                  name: 'Hydraulic Delta Pressure',
                  tag: 'CALC.PRS02.DELTA_P',
                  status: 'draft',
                  cost: '2.1 µs',
                },
              ].map((r, i) => (
                <div
                  key={r.id}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    i === 0
                      ? 'border-[#EF1B24] bg-[#FFF0F1]/40 ring-2 ring-[#FFF0F1]'
                      : 'border-[#E3EAF3] bg-white hover:border-[#94A3B8]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] font-bold text-[#111B37]">{r.name}</span>
                    <Badge variant={r.status === 'active' ? 'good' : 'neutral'}>
                      {r.status.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="font-mono text-[11px] text-[#657794]">{r.tag}</div>
                  <div className="text-[10px] text-[#94A3B8] mt-1">Eval Cost: {r.cost}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Center: Region 4 (Formula Code Editor) & Region 8 (Evaluation Preview) */}
        <div className="col-span-12 lg:col-span-6 space-y-3.5">
          {/* Target Metadata Config (Region 7) */}
          <Card title="Rule Definition & Output Target" className="p-4">
            <div className="grid grid-cols-3 gap-3 text-[12px]">
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Rule Name</label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="fx-input h-8 text-[12px]"
                />
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Output Tag</label>
                <input
                  type="text"
                  value={targetTag}
                  onChange={(e) => setTargetTag(e.target.value)}
                  className="fx-input h-8 font-mono text-[12px]"
                />
              </div>
              <div>
                <label className="block text-[#657794] font-semibold mb-1">Unit</label>
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="fx-input h-8 text-[12px]"
                />
              </div>
            </div>
          </Card>

          {/* Region 4: Formula Code Editor */}
          <Card
            title="Formula AST Expression"
            subtitle="Restricted deterministic Python-like DSL expression:"
            headerClassName="bg-[#F9FAFD]"
          >
            <div className="rounded-xl border border-[#D4DFEC] bg-[#111B2E] overflow-hidden">
              <div className="px-4 py-2 bg-[#1A253C] border-b border-[#2A3854] flex items-center justify-between text-[11px] text-[#94A3B8]">
                <span>python_ast_sandbox.dsl</span>
                <span className="font-mono text-[#0DBA67]">AST Parser Ready</span>
              </div>
              <textarea
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                rows={7}
                className="w-full p-4 bg-transparent text-[#E2E8F0] font-mono text-[13px] leading-relaxed resize-none outline-none selection:bg-[#EF1B24]"
                spellCheck={false}
              />
            </div>
          </Card>

          {/* Region 8 & 9: Live Evaluation & AST Verification */}
          <Card title="Evaluation Verification & Sandbox Status">
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-[#E9FBF1] border border-[#B6F0D1]">
                <CheckCircle2 className="w-5 h-5 text-[#0DBA67]" />
                <div className="text-[12px]">
                  <span className="font-bold text-[#111B37]">AST Syntax Valid:</span> No recursion,
                  no arbitrary imports, safe mathematical subset.
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3] space-y-2 text-[12px]">
                <div className="flex justify-between items-center">
                  <span className="text-[#657794]">Sample Inputs:</span>
                  <span className="font-mono text-[#111B37]">TEMP = 42.8 °C, RPM = 12,500</span>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-[#E3EAF3]">
                  <span className="text-[#657794] font-bold">Evaluated Output Value:</span>
                  <span className="font-extrabold text-[#EF1B24] text-[18px] tabular-nums font-mono">
                    {evalResult !== null ? `${evalResult} ${unit}` : '--'}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Pane: Region 5 & 6 (Function Reference & Signals Picker) */}
        <div className="col-span-12 lg:col-span-3 space-y-3.5">
          {/* Region 5: Function Reference */}
          <Card title="Standard Functions" className="h-[360px] flex flex-col p-0">
            <div className="p-3 overflow-y-auto flex-1 space-y-2 text-[12px]">
              {[
                { name: 'clamp(val, min, max)', desc: 'Constrains value within bounds' },
                { name: 'window_avg(tag, "5m")', desc: 'Rolling 5-minute time window average' },
                { name: 'rate(tag, "1s")', desc: 'Per-second rate of change derivative' },
                { name: 'abs(val)', desc: 'Absolute value calculation' },
                { name: 'round(val, decimals)', desc: 'Rounds to specified decimal places' },
              ].map((fn, idx) => (
                <div
                  key={idx}
                  onClick={() => setFormula((f) => `${f} + ${fn.name.split('(')[0]}()`)}
                  className="p-2 rounded-lg border border-[#E3EAF3] bg-white hover:border-[#EF1B24] cursor-pointer transition-colors"
                >
                  <code className="text-[#2A82E7] font-bold text-[11px] block">{fn.name}</code>
                  <span className="text-[11px] text-[#657794]">{fn.desc}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Region 6: Available Signals Picker */}
          <Card title="Insert Signal Reference" className="h-[355px] flex flex-col p-0">
            <div className="p-3 overflow-y-auto flex-1 space-y-1.5 text-[12px]">
              {[
                { tag: 'CNC_01.SPINDLE.TEMP', name: 'Spindle Temperature' },
                { tag: 'CNC_01.SPINDLE.ACTUAL_RPM', name: 'Actual RPM' },
                { tag: 'PRESS_02.HYD.BAR', name: 'Hydraulic Pressure' },
                { tag: 'CNC_01.SPINDLE.VIBE_RMS', name: 'Vibration RMS' },
              ].map((s) => (
                <button
                  key={s.tag}
                  type="button"
                  onClick={() => setFormula((f) => `${f} sig("${s.tag}")`)}
                  className="w-full text-left p-2 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#FFF0F1] hover:border-[#FAC6C9] group transition-colors"
                >
                  <div className="font-mono text-[11px] text-[#EF1B24] font-bold">{s.tag}</div>
                  <div className="text-[11px] text-[#657794] truncate">{s.name}</div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
