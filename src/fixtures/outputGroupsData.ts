import { OutputGroup } from '../types';

export const initialOutputGroups: OutputGroup[] = [
  {
    id: 'grp-uns-cnc01',
    name: 'CNC Milling Center 01 Telemetry Stream',
    topicTemplate: 'factorix/uns/v1/{enterprise}/{site}/{plant}/{line}/{machine}/telemetry',
    enabled: true,
    publishIntervalMs: 500,
    assignedSignals: [
      'sig-cnc-temp-01',
      'sig-cnc-vibe-01',
      'sig-cnc-rpm-01',
      'sig-cnc-running-01',
      'sig-calc-heat-load',
    ],
    lastPublished: '2026-10-29 11:57:12',
    samplePayload: JSON.stringify(
      {
        timestamp: '2026-10-29T11:57:12.450Z',
        asset: {
          id: 'res-cnc-01',
          code: 'MC-CNC-001',
          path: 'FactoriX/BinhDuong/Plant01/Line01/CNC01',
        },
        metrics: {
          spindle_temperature: 42.8,
          spindle_vibration: 1.45,
          spindle_speed_rpm: 12500,
          is_running: true,
          calculated_thermal_load: 0.78,
        },
        quality: 'GOOD',
      },
      null,
      2
    ),
  },
  {
    id: 'grp-uns-stamping',
    name: 'Stamping Press 02 Pressure Cycle Stream',
    topicTemplate: 'factorix/uns/v1/{enterprise}/{site}/{plant}/{line}/{machine}/state',
    enabled: true,
    publishIntervalMs: 250,
    assignedSignals: ['sig-prs-bar-01'],
    lastPublished: '2026-10-29 11:57:12',
    samplePayload: JSON.stringify(
      {
        timestamp: '2026-10-29T11:57:12.200Z',
        asset: {
          id: 'res-press-02',
          code: 'MC-PRS-002',
          path: 'FactoriX/BinhDuong/Plant01/Line01/Press02',
        },
        metrics: {
          hydraulic_pressure_bar: 168.4,
        },
        quality: 'GOOD',
      },
      null,
      2
    ),
  },
];
