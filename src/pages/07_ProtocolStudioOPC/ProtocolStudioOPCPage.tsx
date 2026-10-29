import React, { useState } from 'react';
import {
  Cable,
  FolderTree,
  Folder,
  FileCode,
  Play,
  Pause,
  Plus,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  Search,
  ExternalLink,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';

interface OpcNode {
  id: string;
  name: string;
  nodeId: string;
  nodeClass: 'Object' | 'Variable' | 'Method';
  dataType?: string;
  value?: string | number;
  children?: OpcNode[];
}

const mockAddressSpace: OpcNode[] = [
  {
    id: 'root-objects',
    name: 'Objects',
    nodeId: 'ns=0;i=85',
    nodeClass: 'Object',
    children: [
      {
        id: 'plant-01',
        name: 'FactoriX_Plant01',
        nodeId: 'ns=2;s=Plant01',
        nodeClass: 'Object',
        children: [
          {
            id: 'cnc-01',
            name: 'CNC_Milling_01',
            nodeId: 'ns=2;s=Plant01.CNC01',
            nodeClass: 'Object',
            children: [
              {
                id: 'cnc-spindle-temp',
                name: 'SpindleTemperature',
                nodeId: 'ns=2;s=Plant01.CNC01.Spindle.Temperature',
                nodeClass: 'Variable',
                dataType: 'Double',
                value: '42.8 °C',
              },
              {
                id: 'cnc-spindle-rpm',
                name: 'SpindleSpeedRPM',
                nodeId: 'ns=2;s=Plant01.CNC01.Spindle.ActualRPM',
                nodeClass: 'Variable',
                dataType: 'Int32',
                value: '12500 RPM',
              },
              {
                id: 'cnc-vibe-rms',
                name: 'SpindleVibrationRMS',
                nodeId: 'ns=2;s=Plant01.CNC01.Spindle.VibeRMS',
                nodeClass: 'Variable',
                dataType: 'Float',
                value: '1.45 mm/s',
              },
            ],
          },
        ],
      },
    ],
  },
];

export const ProtocolStudioOPCPage: React.FC = () => {
  const [selectedNode, setSelectedNode] = useState<OpcNode>({
    id: 'cnc-spindle-temp',
    name: 'SpindleTemperature',
    nodeId: 'ns=2;s=Plant01.CNC01.Spindle.Temperature',
    nodeClass: 'Variable',
    dataType: 'Double',
    value: '42.8 °C',
  });

  const [monitoredItems, setMonitoredItems] = useState([
    {
      handle: 101,
      name: 'SpindleTemperature',
      nodeId: 'ns=2;s=Plant01.CNC01.Spindle.Temperature',
      interval: '100 ms',
      queue: 10,
      value: '42.8 °C',
      quality: 'Good (0x00000000)',
    },
    {
      handle: 102,
      name: 'SpindleSpeedRPM',
      nodeId: 'ns=2;s=Plant01.CNC01.Spindle.ActualRPM',
      interval: '50 ms',
      queue: 10,
      value: '12500 RPM',
      quality: 'Good (0x00000000)',
    },
  ]);

  const handleAddMonitored = () => {
    if (selectedNode.nodeClass === 'Variable') {
      setMonitoredItems((prev) => [
        ...prev,
        {
          handle: Math.floor(Math.random() * 900 + 100),
          name: selectedNode.name,
          nodeId: selectedNode.nodeId,
          interval: '100 ms',
          queue: 10,
          value: String(selectedNode.value ?? '0'),
          quality: 'Good (0x00000000)',
        },
      ]);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1 & 2: Heading & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">OPC UA Protocol Studio</h1>
          <p className="fx-page-subtitle">
            Address space browsing, NodeId discovery, certificate management, and subscription tuning.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="primary" icon={<Cable className="w-4 h-4" />}>
            Connected (Session #84)
          </Button>
          <Button variant="secondary" icon={<RefreshCw className="w-4 h-4" />}>
            Browse Root
          </Button>
        </div>
      </div>

      {/* Region 3: Endpoint & Security Summary Bar */}
      <Card className="p-4 bg-white">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-[12px]">
          <div>
            <span className="text-[#657794] block uppercase font-bold text-[11px]">Server Endpoint</span>
            <span className="font-mono font-bold text-[#111B37] text-[13px]">
              opc.tcp://192.168.10.10:4840/FactoriX
            </span>
          </div>
          <div>
            <span className="text-[#657794] block uppercase font-bold text-[11px]">Security Mode & Policy</span>
            <div className="flex items-center gap-1.5 mt-0.5 font-semibold text-[#111B37]">
              <ShieldCheck className="w-4 h-4 text-[#0DBA67]" />
              <span>SignAndEncrypt · Basic256Sha256</span>
            </div>
          </div>
          <div>
            <span className="text-[#657794] block uppercase font-bold text-[11px]">Publishing Interval</span>
            <span className="font-bold text-[#111B37]">100 ms (10 Hz)</span>
          </div>
          <div>
            <span className="text-[#657794] block uppercase font-bold text-[11px]">Channel Security</span>
            <span className="text-[#0DBA67] font-bold">Trusted Certificate Verified</span>
          </div>
        </div>
      </Card>

      {/* Main Studio Workspace: Address Space (Reg 4) vs Attributes (Reg 5) & Monitored (Reg 6, 7) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Region 4: Address Space Tree Browser */}
        <div className="col-span-12 lg:col-span-4">
          <Card className="h-[680px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase text-[#111B37]">
                Address Space Tree
              </span>
              <FolderTree className="w-4 h-4 text-[#657794]" />
            </div>

            <div className="p-3 overflow-y-auto flex-1 space-y-1 text-[13px]">
              <div className="flex items-center gap-2 py-1 px-2 font-bold text-[#111B37]">
                <Folder className="w-4 h-4 text-[#2A82E7]" />
                <span>Objects (i=85)</span>
              </div>
              <div className="pl-4 space-y-1">
                <div className="flex items-center gap-2 py-1 px-2 font-semibold text-[#111B37]">
                  <Folder className="w-4 h-4 text-[#2A82E7]" />
                  <span>FactoriX_Plant01</span>
                </div>
                <div className="pl-4 space-y-1">
                  <div className="flex items-center gap-2 py-1 px-2 font-semibold text-[#111B37]">
                    <Folder className="w-4 h-4 text-[#2A82E7]" />
                    <span>CNC_Milling_01</span>
                  </div>
                  <div className="pl-4 space-y-1">
                    {[
                      {
                        name: 'SpindleTemperature',
                        nodeId: 'ns=2;s=Plant01.CNC01.Spindle.Temperature',
                        type: 'Double',
                        val: '42.8 °C',
                      },
                      {
                        name: 'SpindleSpeedRPM',
                        nodeId: 'ns=2;s=Plant01.CNC01.Spindle.ActualRPM',
                        type: 'Int32',
                        val: '12500 RPM',
                      },
                      {
                        name: 'SpindleVibrationRMS',
                        nodeId: 'ns=2;s=Plant01.CNC01.Spindle.VibeRMS',
                        type: 'Float',
                        val: '1.45 mm/s',
                      },
                    ].map((item) => (
                      <div
                        key={item.nodeId}
                        onClick={() =>
                          setSelectedNode({
                            id: item.name,
                            name: item.name,
                            nodeId: item.nodeId,
                            nodeClass: 'Variable',
                            dataType: item.type,
                            value: item.val,
                          })
                        }
                        className={`flex items-center justify-between py-1.5 px-2 rounded-lg cursor-pointer text-[12px] transition-colors ${
                          selectedNode.nodeId === item.nodeId
                            ? 'bg-[#FFF0F1] text-[#EF1B24] font-bold border-l-2 border-[#EF1B24]'
                            : 'text-[#334568] hover:bg-[#F9FAFD]'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <FileCode className="w-3.5 h-3.5 text-[#657794]" />
                          <span className="truncate">{item.name}</span>
                        </div>
                        <span className="font-mono text-[11px] text-[#94A3B8]">{item.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Pane: Region 5 (Attributes) & Region 6 (Monitored Items) */}
        <div className="col-span-12 lg:col-span-8 space-y-3.5">
          {/* Region 5: Selected Node Attributes */}
          <Card
            title={`Selected Node: ${selectedNode.name}`}
            action={
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={handleAddMonitored}
              >
                Add to Monitored Items
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3 text-[12px]">
              <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                <span className="text-[#657794] block text-[11px]">NodeId</span>
                <span className="font-mono font-bold text-[#111B37] text-[12px]">{selectedNode.nodeId}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                <span className="text-[#657794] block text-[11px]">Node Class & DataType</span>
                <span className="font-bold text-[#111B37]">
                  {selectedNode.nodeClass} ({selectedNode.dataType || 'None'})
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                <span className="text-[#657794] block text-[11px]">Access Level</span>
                <span className="font-bold text-[#0DBA67]">CurrentRead / Subscribe</span>
              </div>
              <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                <span className="text-[#657794] block text-[11px]">Current Live Value</span>
                <span className="font-extrabold text-[#EF1B24] text-[13px]">{selectedNode.value || 'N/A'}</span>
              </div>
            </div>
          </Card>

          {/* Region 6: Monitored Items Table */}
          <Card title="Active Monitored Items & Subscriptions">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Handle</th>
                    <th>Node / Signal Name</th>
                    <th>NodeId</th>
                    <th>Sampling</th>
                    <th>Live Value</th>
                    <th>Status Code</th>
                  </tr>
                </thead>
                <tbody>
                  {monitoredItems.map((item) => (
                    <tr key={item.handle}>
                      <td className="font-mono text-[#94A3B8] text-[11px]">#{item.handle}</td>
                      <td className="font-bold text-[#111B37] text-[12px]">{item.name}</td>
                      <td className="font-mono text-[11px] text-[#657794]">{item.nodeId}</td>
                      <td className="font-mono text-[12px] text-[#111B37]">{item.interval}</td>
                      <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">{item.value}</td>
                      <td>
                        <Badge variant="good">{item.quality}</Badge>
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
