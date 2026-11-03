import React, { useState } from 'react';
import {
  Cloud,
  Send,
  Play,
  CheckCircle2,
  Clock,
  Plus,
  Trash2,
  Copy,
  Braces,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';

export const ProtocolStudioHTTPPage: React.FC = () => {
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [url, setUrl] = useState<string>('https://mes-api.factorix.local/v1/telemetry');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [responseStatus, setResponseStatus] = useState<number | null>(200);

  const [responseJson, setResponseJson] = useState<string>(
    JSON.stringify(
      {
        status: 'success',
        timestamp: '2026-10-29T12:00:15.120Z',
        plant_id: 'PLANT-01',
        metrics: [
          { meter_id: 'MTR-PWR-01', active_power_kw: 18.75, voltage_v: 398.2, power_factor: 0.94 },
          { meter_id: 'MTR-PWR-02', active_power_kw: 24.12, voltage_v: 397.8, power_factor: 0.92 },
        ],
      },
      null,
      2
    )
  );

  const [mappings, setMappings] = useState([
    { jsonPath: '$.metrics[0].active_power_kw', tag: 'CONV_LINE1.KW', type: 'Float', unit: 'kW', val: '18.75' },
    { jsonPath: '$.metrics[0].voltage_v', tag: 'LINE01.BUS.VOLTAGE_V', type: 'Float', unit: 'V', val: '398.2' },
  ]);

  const handleSend = async () => {
    setIsLoading(true);
    await new Promise((r) => setTimeout(r, 600));
    setIsLoading(false);
    setResponseStatus(200);
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1 & 2: Heading & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">HTTP / REST Protocol Studio</h1>
          <p className="fx-page-subtitle">
            Web API polling, header authentication, pagination, and JSON response extraction.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            icon={<Send className="w-4 h-4" />}
            onClick={handleSend}
            loading={isLoading}
          >
            Send Request
          </Button>
          <Button variant="secondary">Save Integration</Button>
        </div>
      </div>

      {/* Region 3: Endpoint Request Form Bar */}
      <Card className="p-4 bg-white">
        <div className="flex items-center gap-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as any)}
            className="h-10 px-3 rounded-lg border border-[#D4DFEC] bg-[#F9FAFD] font-bold text-[13px] text-[#111B37] outline-none"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="fx-input h-10 font-mono text-[13px] flex-1"
          />
          <div className="flex items-center gap-2 pl-2">
            <span className="text-[12px] font-semibold text-[#657794]">Interval:</span>
            <span className="font-mono font-bold text-[#111B37] text-[12px]">2,000 ms</span>
          </div>
        </div>
      </Card>

      {/* Main Studio Grid: Headers (Reg 4) vs Response (Reg 6, 7) & Mappings (Reg 8) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Left Column: Headers and Auth Config (Region 4) */}
        <div className="col-span-12 lg:col-span-4 space-y-3.5">
          <Card title="Headers & Authentication">
            <div className="space-y-3 text-[12px]">
              <div>
                <span className="text-[#657794] block font-semibold mb-1">Auth Type</span>
                <div className="flex items-center gap-2 font-bold text-[#111B37]">
                  <ShieldCheck className="w-4 h-4 text-[#0DBA67]" />
                  <span>API Key Header</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[#E3EAF3] space-y-2">
                <div>
                  <label className="text-[#657794] block text-[11px] mb-1">Header Key</label>
                  <input type="text" defaultValue="X-API-Key" className="fx-input h-8 font-mono text-[11px]" />
                </div>
                <div>
                  <label className="text-[#657794] block text-[11px] mb-1">Header Value</label>
                  <input type="password" defaultValue="fx_sec_8941098234" className="fx-input h-8 font-mono text-[11px]" />
                </div>
              </div>

              <div className="pt-2 border-t border-[#E3EAF3]">
                <label className="text-[#657794] block text-[11px] mb-1">Accept Header</label>
                <input type="text" defaultValue="application/json" className="fx-input h-8 font-mono text-[11px]" />
              </div>
            </div>
          </Card>

          {/* Region 10: Error Policy */}
          <Card title="Resilience & Polling SLA">
            <div className="space-y-2 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[#657794]">Timeout Limit:</span>
                <span className="font-bold text-[#111B37]">5,000 ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#657794]">Retry Strategy:</span>
                <span className="font-semibold text-[#111B37]">Exponential (Max 3)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#657794]">Degraded State:</span>
                <span className="text-[#FFAA23] font-bold">Alert after 2 consecutive drops</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column: Response Viewer (Region 6, 7) & Field Extraction (Region 8) */}
        <div className="col-span-12 lg:col-span-8 space-y-3.5">
          {/* Region 6 & 7: Response Viewer */}
          <Card
            title="Response Payload"
            subtitle="Real-time response returned from endpoint:"
            action={
              <Badge variant={responseStatus === 200 ? 'good' : 'error'}>
                {responseStatus ? `HTTP ${responseStatus} OK (42ms)` : 'NOT SENT'}
              </Badge>
            }
          >
            <div className="rounded-xl bg-[#111B2E] overflow-hidden">
              <div className="px-3 py-1.5 bg-[#1A253C] flex justify-between text-[11px] text-[#94A3B8] font-mono">
                <span>application/json</span>
                <span className="text-[#0DBA67]">4.8 KB</span>
              </div>
              <pre className="p-4 text-[#0DBA67] font-mono text-[11px] leading-relaxed overflow-x-auto max-h-[280px]">
                {responseJson}
              </pre>
            </div>
          </Card>

          {/* Region 8: Field to Signal Mapping Table */}
          <Card
            title="Mapped Signal Fields"
            action={
              <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />}>
                Add Mapping
              </Button>
            }
          >
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>JSONPath Selector</th>
                    <th>Target Signal Tag</th>
                    <th>Data Type</th>
                    <th>Unit</th>
                    <th>Extracted Value</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, idx) => (
                    <tr key={idx}>
                      <td className="font-mono font-bold text-[#2A82E7] text-[12px]">{m.jsonPath}</td>
                      <td className="font-mono text-[12px] text-[#111B37] font-semibold">{m.tag}</td>
                      <td className="text-[11px] uppercase font-bold text-[#657794]">{m.type}</td>
                      <td className="font-bold text-[#111B37]">{m.unit}</td>
                      <td className="font-extrabold text-[#EF1B24] tabular-nums text-[13px]">{m.val}</td>
                      <td>
                        <button type="button" className="text-[#94A3B8] hover:text-[#F2343B]">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
