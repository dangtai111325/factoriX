import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { StorageNameCheck, TDObjectType, validateStorageName } from '../../../lib/storagePhysicalApi';

/** TDengine identifier limit and the description limit the backend enforces (storage_objects.MAX_DESCRIPTION_LEN). */
export const NAME_MAX_LENGTH = 63;
export const DESCRIPTION_MAX_LENGTH = 1000;

export interface NameCheckInput {
  kind: TDObjectType;
  name: string;
  database?: string;
  stable?: string;
  description?: string;
}

/** Wizard field errors (keys = the wizard data keys) + the conflicting object, if the name is taken. */
export interface NameCheckResult {
  errors: Record<string, string>;
  conflict: { kind: TDObjectType; name: string; database?: string } | null;
}

const EMPTY: NameCheckResult = { errors: {}, conflict: null };

/** Local length check, run before the pattern so an 83-character name says "max 63", not "invalid" (R1-29). */
export function nameLengthError(name: string): string | null {
  return name.length > NAME_MAX_LENGTH ? `Max ${NAME_MAX_LENGTH} characters (this name has ${name.length}).` : null;
}

export function descriptionLengthError(description: string | undefined): string | null {
  const n = (description || '').length;
  return n > DESCRIPTION_MAX_LENGTH ? `Description is limited to ${DESCRIPTION_MAX_LENGTH} characters (this one has ${n}).` : null;
}

const FIELD_KEY: Record<string, string> = { name: 'physical_name', description: 'description', display_name: 'display_name' };

/** Server answer → wizard field errors, one clear English message per code. */
export function mapNameCheck(input: NameCheckInput, res: StorageNameCheck): NameCheckResult {
  const errors: Record<string, string> = {};
  let conflict: NameCheckResult['conflict'] = null;
  for (const e of res.errors || []) {
    const key = FIELD_KEY[String(e.field || 'name')] || 'physical_name';
    if (errors[key]) continue; // the first error of a field is the one to fix first (length before pattern)
    switch (e.code) {
      case 'RESERVED_NAME':
        errors[key] = `'${input.name}' is a reserved name in TDengine. Choose another name.`;
        break;
      case 'IDENTIFIER_TOO_LONG':
        errors[key] = nameLengthError(input.name) || e.message;
        break;
      case 'NAME_CONFLICT':
        errors[key] = `'${input.name}' already exists${input.kind === 'database' ? '' : ` in ${input.database}`}. Open it instead, or choose another name.`;
        conflict = { kind: input.kind, name: input.name, database: input.database };
        break;
      default:
        // INVALID_IDENTIFIER, RESERVED_PREFIX, SYSTEM_OBJECT, DESCRIPTION_TOO_LONG: the server text names the rule.
        errors[key] = e.message || 'This value is not allowed.';
    }
  }
  return { errors, conflict };
}

/**
 * Name check of wizard step 1 against `POST /storage/td/validate-name` (R1-17a / R1-29 / OP-04).
 * - While typing: debounced (300 ms) check → `result` shows reserved names, conflicts … before "Next".
 * - On "Next": `check()` runs it now; the caller blocks the step when it returns errors.
 * An older Center without the route (404 / 405) or an unreachable server never blocks: the local
 * checks stay in force and the create call validates again.
 */
export function useServerNameCheck(input: NameCheckInput, enabled: boolean) {
  const [result, setResult] = useState<NameCheckResult>(EMPTY);
  const [checking, setChecking] = useState(false);
  const unsupported = useRef(false);
  const seq = useRef(0);
  const key = JSON.stringify(input);

  const run = useCallback(async (value: NameCheckInput, signal?: AbortSignal): Promise<NameCheckResult> => {
    if (unsupported.current || !value.name) return EMPTY;
    try {
      return mapNameCheck(value, await validateStorageName(value, signal));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) unsupported.current = true;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return EMPTY;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !input.name) {
      setResult(EMPTY);
      return;
    }
    const controller = new AbortController();
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      setChecking(true);
      run(input, controller.signal)
        .then((r) => {
          if (seq.current === mine) setResult(r);
        })
        .catch(() => undefined)
        .finally(() => {
          if (seq.current === mine) setChecking(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled, run]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Check now (the "Next" click); also refreshes `result`. */
  const check = useCallback(async (): Promise<NameCheckResult> => {
    const mine = ++seq.current;
    setChecking(true);
    try {
      const r = await run(input);
      if (seq.current === mine) setResult(r);
      return r;
    } catch {
      return EMPTY;
    } finally {
      if (seq.current === mine) setChecking(false);
    }
  }, [key, run]); // eslint-disable-line react-hooks/exhaustive-deps

  return { result, checking, check, invalid: Object.keys(result.errors).length > 0 };
}
