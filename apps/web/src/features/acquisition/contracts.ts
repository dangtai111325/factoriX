/** Acquisition's public value types and commissioning gate. */

import type { AcquisitionDraft, AcquisitionField } from '../../store/AppContext'
import { codePreviewFromName } from '../../utils/resourceHierarchy'

export function validMqttFilter(value: string): boolean {
  const parts = value.split('/')
  return (
    Boolean(value) &&
    new TextEncoder().encode(value).length <= 65535 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    parts.every(
      (part, index) =>
        (!part.includes('#') || (part === '#' && index === parts.length - 1)) &&
        (!part.includes('+') || part === '+'),
    )
  )
}

export interface MappingRowIssue {
  row: number
  field: 'name' | 'address' | 'topic'
  message: string
}
export function mappingRowIssues(
  protocol: AcquisitionDraft['protocol'],
  fields: AcquisitionField[],
): MappingRowIssue[] {
  const issues: MappingRowIssue[] = []
  const keys = fields.map((field) => codePreviewFromName(field.name))
  const counts = new Map<string, number>()
  for (const key of keys) if (key) counts.set(key, (counts.get(key) || 0) + 1)
  fields.forEach((field, row) => {
    if (!field.name.trim()) issues.push({ row, field: 'name', message: 'Enter a signal name.' })
    else if (!keys[row])
      issues.push({ row, field: 'name', message: 'Enter a signal name that contains letters or numbers.' })
    else if ((counts.get(keys[row]) || 0) > 1)
      issues.push({ row, field: 'name', message: `Signal key "${keys[row]}" is used more than once.` })
    if (!field.address.trim()) issues.push({ row, field: 'address', message: 'Enter a source address.' })
    if (
      protocol === 'mqtt' &&
      (!field.topic || !validMqttFilter(field.topic) || new TextEncoder().encode(field.topic).length > 2048)
    )
      issues.push({
        row,
        field: 'topic',
        message: 'Choose a valid source topic for this field (up to 2048 UTF-8 bytes).',
      })
  })
  return issues
}

/** Address contract shared by draft commissioning and signal activation. */
export function mappingContract(
  draft: Pick<AcquisitionDraft, 'protocol' | 'extra' | 'mqttQos'>,
  field: AcquisitionField,
) {
  const type = sourceType(field.dataType)
  const address =
    draft.protocol === 'modbus'
      ? {
          offset: Number(field.address),
          register_area: 'holding',
          native_type: type.nativeType || (type.dataType === 'bool' ? 'bool' : 'float64'),
          word_order: 'big',
        }
      : draft.protocol === 'opcua'
        ? { node_id: field.address }
        : draft.protocol === 'mqtt'
          ? { topic: field.topic ?? draft.extra, jsonpath: field.address, qos: draft.mqttQos ?? 1 }
          : { jsonpath: field.address }
  return { name: field.name, data_type: type.dataType, address }
}

export function sourceType(value: string): { dataType: string; nativeType?: string } {
  const name = value.trim().toLowerCase()
  if (['string', 'text'].includes(name)) return { dataType: 'string' }
  if (['bool', 'boolean'].includes(name)) return { dataType: 'bool' }
  if (name === 'json') return { dataType: 'json' }
  if (name === 'enum') return { dataType: 'enum' }
  if (['int16', 'uint16', 'int32', 'uint32'].includes(name)) return { dataType: 'int64', nativeType: name }
  if (['integer', 'int64'].includes(name)) return { dataType: 'int64' }
  if (['float32', 'float64'].includes(name)) return { dataType: 'float64', nativeType: name }
  if (['number', 'analog'].includes(name)) return { dataType: 'float64' }
  throw new Error(`Unsupported signal type: ${value}`)
}

export function commissioningPassed(
  status: string,
  stages: Array<{ name: string; status: string }>,
): boolean {
  if (!['PASSED', 'COMPLETED'].includes(status)) return false
  const byName = new Map(stages.map((stage) => [stage.name, stage.status]))
  return (
    ['PASSED', 'NOT_APPLICABLE', 'COMPLETED'].includes(byName.get('AUTH') || '') &&
    ['NETWORK', 'PROTOCOL', 'READ_OR_SUBSCRIBE', 'DECODE', 'MAPPING', 'VALIDATION'].every((name) =>
      ['PASSED', 'COMPLETED'].includes(byName.get(name) || ''),
    )
  )
}
