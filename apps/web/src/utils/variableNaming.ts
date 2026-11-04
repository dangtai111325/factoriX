/**
 * Variable naming and validation utilities for FactoriX.
 * Conforms to variable identifier rules: alphanumeric and underscores only,
 * cannot start with a digit, no spaces or special characters.
 */

export function sanitizeVariableName(raw: string): string {
  if (!raw) return '';
  // Replace spaces, hyphens, and dots with underscores
  let cleaned = raw.trim().replace(/[\s\-\.]+/g, '_');
  // Strip all invalid characters (keep only alphanumeric and underscore)
  cleaned = cleaned.replace(/[^a-zA-Z0-9_]/g, '');
  // If starts with a digit, prefix with underscore
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned.toLowerCase();
}

export function validateVariableName(name: string): string | null {
  if (!name || !name.trim()) {
    return 'Variable name is required.';
  }
  const trimmed = name.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return 'Must be a valid identifier (only letters, numbers, and underscores; cannot start with a number or contain spaces).';
  }
  return null;
}

export interface FlattenedField {
  jsonPath: string;
  variableName: string;
  value: unknown;
  dataType: 'Number' | 'Integer' | 'Boolean' | 'Text';
}

export function flattenJsonPayload(obj: unknown, currentPath = '$', currentVar = ''): FlattenedField[] {
  const result: FlattenedField[] = [];
  if (obj === null || obj === undefined) return result;

  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        const nextPath = `${currentPath}[${index}]`;
        const nextVar = currentVar ? `${currentVar}_${index}` : `item_${index}`;
        if (typeof item === 'object' && item !== null) {
          result.push(...flattenJsonPayload(item, nextPath, nextVar));
        } else {
          result.push({
            jsonPath: nextPath,
            variableName: sanitizeVariableName(nextVar),
            value: item,
            dataType:
              typeof item === 'number'
                ? Number.isInteger(item)
                  ? 'Integer'
                  : 'Number'
                : typeof item === 'boolean'
                ? 'Boolean'
                : 'Text',
          });
        }
      });
    } else {
      for (const [key, val] of Object.entries(obj)) {
        const cleanKey = sanitizeVariableName(key);
        const hasSpecialChar = /[\s\.\-]/.test(key);
        const nextPath =
          currentPath === '$'
            ? hasSpecialChar
              ? `$['${key}']`
              : `$.${key}`
            : hasSpecialChar
            ? `${currentPath}['${key}']`
            : `${currentPath}.${key}`;
        const nextVar = currentVar ? `${currentVar}_${cleanKey}` : cleanKey;

        if (typeof val === 'object' && val !== null) {
          result.push(...flattenJsonPayload(val, nextPath, nextVar));
        } else {
          result.push({
            jsonPath: nextPath,
            variableName: sanitizeVariableName(nextVar),
            value: val,
            dataType:
              typeof val === 'number'
                ? Number.isInteger(val)
                  ? 'Integer'
                  : 'Number'
                : typeof val === 'boolean'
                ? 'Boolean'
                : 'Text',
          });
        }
      }
    }
  } else {
    result.push({
      jsonPath: currentPath,
      variableName: sanitizeVariableName(currentVar || 'value'),
      value: obj,
      dataType:
        typeof obj === 'number'
          ? Number.isInteger(obj)
            ? 'Integer'
            : 'Number'
          : typeof obj === 'boolean'
          ? 'Boolean'
          : 'Text',
    });
  }

  return result;
}
