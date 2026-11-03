import type { AcquisitionField } from '../../store/AppContext'
import { codePreviewFromName } from '../../utils/resourceHierarchy'

export interface DiscoveredField extends AcquisitionField {
  type: 'JSONPath'
  value: unknown
}

export function discoverPayloadFields(payload: unknown): { fields: DiscoveredField[]; truncated: boolean } {
  const fields: DiscoveredField[] = []
  let truncated = false
  let visited = 0
  const visit = (value: unknown, address: string, name: string, depth: number) => {
    if (fields.length >= 256 || depth > 16 || ++visited > 4096) {
      truncated = true
      return
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      if (entries.length) {
        for (const [key, child] of entries) {
          visit(child, `${address}[${Array.isArray(value) ? key : JSON.stringify(key)}]`, key, depth + 1)
          if (fields.length >= 256 || visited > 4096) {
            if (key !== entries[entries.length - 1][0]) truncated = true
            break
          }
        }
        return
      }
    }
    const dataType = typeof value === 'string' ? 'String'
      : typeof value === 'boolean' ? 'Bool'
        : typeof value === 'number' ? (Number.isSafeInteger(value) ? 'Int64' : 'Float64') : 'JSON'
    fields.push({ address, name: codePreviewFromName(name) ? name : 'value', dataType, unit: '', type: 'JSONPath', value })
  }
  visit(payload, '$', 'value', 0)
  return { fields, truncated }
}

export function appendDiscoveredFields<T extends AcquisitionField & { type: string }>(
  current: T[], topic: string, selected: DiscoveredField[],
): Array<T | (AcquisitionField & { type: string })> {
  const result: Array<T | (AcquisitionField & { type: string })> = current.filter(row => row.name.trim() || (row.address !== '$.' && row.address.trim()))
  const identities = new Set(result.map(row => JSON.stringify([row.topic, row.address])))
  const keys = new Set(result.map(row => codePreviewFromName(row.name)))
  for (const field of selected) {
    const identity = JSON.stringify([topic, field.address])
    if (identities.has(identity)) continue
    let name = field.name
    let suffix = 2
    while (keys.has(codePreviewFromName(name))) name = `${field.name}_${suffix++}`
    result.push({ topic, address: field.address, name, dataType: field.dataType, unit: field.unit, type: 'JSONPath' })
    identities.add(identity)
    keys.add(codePreviewFromName(name))
  }
  return result
}
