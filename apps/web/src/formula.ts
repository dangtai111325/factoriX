export type FormulaToken = { kind: "string" | "number" | "name" | "call" | "op" | "space"; text: string };

const CALLS = new Set([
  "abs", "min", "max", "round", "sqrt", "pow", "sin", "cos", "tan", "asin", "acos", "atan",
  "log", "log10", "exp", "floor", "ceil", "clamp", "avg", "sum", "min_over_time", "max_over_time",
  "count", "rate", "if", "else", "and", "or", "not", "None", "True", "False",
]);

export function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function tokenizeFormula(source: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === "\\" ? 2 : 1;
      }
      if (end < source.length) end += 1;
      tokens.push({ kind: "string", text: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] || ""))) {
      let end = index + 1;
      while (end < source.length && /[0-9.]/.test(source[end])) end += 1;
      tokens.push({ kind: "number", text: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      const text = source.slice(index, end);
      tokens.push({ kind: CALLS.has(text) ? "call" : "name", text });
      index = end;
      continue;
    }
    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      tokens.push({ kind: "space", text: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "op", text: char });
    index += 1;
  }
  return tokens;
}

export function renameIdentifier(source: string, from: string, to: string): string {
  if (!isIdentifier(from) || !isIdentifier(to) || from === to) return source;
  return tokenizeFormula(source)
    .map((token) => (token.kind === "name" && token.text === from ? to : token.text))
    .join("");
}
