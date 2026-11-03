export interface CsvResources {
  headers: string[]
  rows: Array<Record<string, string>>
  rowNumbers: number[]
}

export interface TopicImportProfile {
  skipSegments: number
  levelTypes: string[]
  dataSuffixes: string[]
}

export interface TopicResourceProposal {
  key: string
  parentKey?: string
  path: string
  parent_path: string
  code: string
  name: string
  type_key: string
  topicPrefix: string
  depth: number
}

export interface TopicImportIssue { code: string; topic: string; message: string }
export interface TopicImportProposal { rows: TopicResourceProposal[]; errors: TopicImportIssue[] }

export function parseResourceCsv(text: string): CsvResources {
  if (new TextEncoder().encode(text).length > 2_000_000) throw new Error('CSV files are limited to 2 MB.')
  if (!text.trim()) throw new Error('The CSV file is empty.')
  text = text.replace(/^\uFEFF/, '')
  const counts = new Map([ [',', 0], [';', 0], ['\t', 0] ])
  let inHeaderQuote = false
  for (let at = text.search(/\S/); at < text.length; at++) {
    const char = text[at]
    if (char === '"') {
      if (inHeaderQuote && text[at + 1] === '"') { at++; continue }
      inHeaderQuote = !inHeaderQuote
    } else if (!inHeaderQuote) {
      if (char === '\r' || char === '\n') break
      if (counts.has(char)) counts.set(char, counts.get(char)! + 1)
    }
  }
  const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0]
  const records: Array<{ values: string[]; line: number }> = []
  let values: string[] = [], value = '', quoted = false, afterQuote = false, line = 1, startLine = 1
  const finishField = () => { values.push(value); value = ''; afterQuote = false }
  const finishRecord = () => {
    finishField()
    if (values.some(item => item.trim() !== '')) records.push({ values, line: startLine })
    if (records.length > 2001) throw new Error('Import is limited to 2000 resource rows.')
    values = []
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') { value += '"'; at++ }
        else { quoted = false; afterQuote = true }
      } else {
        value += char
        if (char === '\n' || char === '\r' && text[at + 1] !== '\n') line++
      }
    } else if (char === delimiter) finishField()
    else if (char === '\n' || char === '\r') {
      finishRecord()
      if (char === '\r' && text[at + 1] === '\n') at++
      line++; startLine = line
    } else if (afterQuote) {
      if (char !== ' ' && char !== '\t') throw new Error(`Unexpected text after a closing quote at line ${line}.`)
    } else if (char === '"') {
      if (value.length) throw new Error(`Unexpected quote in an unquoted field at line ${line}.`)
      quoted = true
    } else value += char
  }
  if (quoted) throw new Error(`Unclosed quoted field starting at line ${startLine}.`)
  if (value.length || values.length || afterQuote) finishRecord()
  const header = records.shift()
  if (!header) throw new Error('The CSV file is empty.')
  const aliases: Record<string, string> = { display_name: 'name', resource_type: 'type_key', resource_code: 'code' }
  const allowed = new Set(['path', 'type_key', 'code', 'name', 'parent_path', 'parent_id', 'parent_code', 'description', 'properties', 'tags', 'timezone', 'site_id'])
  const headers = header.values.map(raw => {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
    return aliases[key] || key
  })
  if (new Set(headers).size !== headers.length) throw new Error('The CSV file has duplicate columns.')
  for (const key of headers) if (!allowed.has(key)) throw new Error(`Unknown CSV column: ${key || '(empty)'}. Use the import template.`)
  if (!headers.includes('type_key') || !headers.includes('name') || !headers.includes('code') && !headers.includes('path')) {
    throw new Error('CSV columns must include type_key, name, and either path or code.')
  }
  if (!records.length) throw new Error('The CSV file contains no resource rows.')
  return {
    headers,
    rowNumbers: records.map(record => record.line),
    rows: records.map(record => {
      if (record.values.length !== headers.length) throw new Error(`Line ${record.line} has ${record.values.length} fields; expected ${headers.length}.`)
      return Object.fromEntries(headers.map((key, index) => [key, record.values[index]]))
    }),
  }
}

export function proposeTopicResources(topics: string[], profile: TopicImportProfile): TopicImportProposal {
  if (topics.length > 10000) throw new Error('A topic preview is limited to 10,000 topics.')
  if (!Number.isInteger(profile.skipSegments) || profile.skipSegments < 0 || !profile.levelTypes.length || profile.levelTypes.some(type => !type.trim())) {
    throw new Error('Choose a nonnegative prefix length and a resource type for every hierarchy level.')
  }
  const suffixes = profile.dataSuffixes.map(suffix => suffix.split('/'))
  if (suffixes.some(parts => parts.some(part => !part || /[+#\u0000-\u001f]/.test(part)))) throw new Error('Data suffixes must be concrete nonempty topic segments.')
  suffixes.sort((a, b) => b.length - a.length)
  const rows = new Map<string, TopicResourceProposal>()
  const siblingCodes = new Map<string, string>()
  const errors: TopicImportIssue[] = []
  const issues = new Set<string>()
  let inputBytes = 0
  const addIssue = (code: string, topic: string, message: string) => {
    const key = `${code}\u0000${topic}`
    if (!issues.has(key)) { errors.push({ code, topic, message }); issues.add(key) }
  }
  for (const topic of new Set(topics)) {
    inputBytes += new TextEncoder().encode(topic).length
    if (inputBytes > 2_000_000) throw new Error('The topic preview exceeds 2 MB. Narrow the topic filter.')
    if (!topic.trim() || /[+#\u0000-\u001f\u007f]/.test(topic)) {
      addIssue('INVALID_TOPIC', topic, 'Use captured concrete topics without wildcards or control characters.'); continue
    }
    const parts = topic.split('/')
    const suffix = suffixes.find(candidate => candidate.length < parts.length && candidate.every((part, index) => part === parts[parts.length - candidate.length + index]))
    if (suffixes.length && !suffix) {
      addIssue('UNKNOWN_SUFFIX', topic, 'No configured data suffix matched this topic. Adjust the profile or exclude the topic.'); continue
    }
    const end = parts.length - (suffix?.length || 0)
    const hierarchy = parts.slice(profile.skipSegments, end)
    if (!hierarchy.length || hierarchy.some(part => !part.trim())) {
      addIssue('EMPTY_LEVEL', topic, 'The topic has an empty hierarchy level or the prefix removes every level.'); continue
    }
    if (hierarchy.length > profile.levelTypes.length) {
      addIssue('LEVELS', topic, 'The topic is deeper than the configured hierarchy. Assign more types or adjust the data suffix.'); continue
    }
    const codes: string[] = []
    let parentKey: string | undefined
    for (let depth = 0; depth < hierarchy.length; depth++) {
      const raw = hierarchy[depth]
      const key = parts.slice(0, profile.skipSegments + depth + 1).join('/')
      const code = codePreviewFromName(raw)
      const parentPath = codes.join('/')
      codes.push(code)
      if (!rows.has(key)) {
        if (rows.size >= 2000) throw new Error('The proposed model exceeds 2000 resources. Narrow the topic filter or import in smaller batches.')
        if (!code) addIssue('CODE_REQUIRED', key, 'Enter a resource code for this topic prefix; a readable code could not be inferred.')
        const identity = `${parentKey || ''}\u0000${code}`
        const other = siblingCodes.get(identity)
        if (other && other !== key) addIssue('CODE_COLLISION', key, `Different topic prefixes produce the same sibling code "${code}". Edit the proposed codes before import.`)
        siblingCodes.set(identity, key)
        rows.set(key, { key, parentKey, path: codes.join('/'), parent_path: parentPath, code,
          name: raw.trim(), type_key: profile.levelTypes[depth], topicPrefix: key, depth })
      }
      parentKey = key
    }
  }
  return { rows: [...rows.values()], errors }
}
import { codePreviewFromName } from '../../utils/resourceHierarchy'

