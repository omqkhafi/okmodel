/**
 * Module specifiers from import and export declarations, including type-only forms.
 *
 * Bun's transpiler scan drops imports that erase under `erasableSyntaxOnly`
 * (`import type`, `export type`, and imports whose names are all `type`).
 * Those still couple layers, so this parser records them and then unions the
 * transpiler scan so a runtime import is not missed.
 */
export function moduleSpecifiers(source: string): readonly string[] {
  const newline = source.indexOf("\n");
  const text = source.startsWith("#!") && newline !== -1 ? source.slice(newline + 1) : source;
  const found = new Set<string>(specifiersFromSource(text));
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const item of transpiler.scanImports(text)) {
    found.add(item.path);
  }
  return [...found];
}

function specifiersFromSource(source: string): readonly string[] {
  const specs: string[] = [];
  let index = 0;

  while (index < source.length) {
    const current = charAt(source, index);
    if (current === '"' || current === "'" || current === "`") {
      index = skipLiteral(source, index);
      continue;
    }
    if (
      current === "/" &&
      (charAt(source, index + 1) === "/" || charAt(source, index + 1) === "*")
    ) {
      index = skipComment(source, index);
      continue;
    }
    if (!isIdentStart(current)) {
      index += 1;
      continue;
    }

    const start = index;
    const ident = readIdent(source, index);
    index = ident.end;
    const previous = charAt(source, start - 1);
    if (isIdentPart(previous)) {
      continue;
    }
    if (ident.text !== "import" && ident.text !== "export") {
      continue;
    }

    if (ident.text === "import") {
      const afterKeyword = skipSpaceAndComments(source, index);
      if (charAt(source, afterKeyword) === "(") {
        const opened = skipSpaceAndComments(source, afterKeyword + 1);
        const literal = readQuoted(source, opened);
        if (literal !== undefined) {
          specs.push(literal.value);
          index = literal.end;
        } else {
          index = afterKeyword;
        }
        continue;
      }
    }

    const clause = readModuleClause(source, index);
    index = clause.end;
    if (clause.specifier !== undefined) {
      specs.push(clause.specifier);
    }
  }

  return specs;
}

type Clause = {
  readonly end: number;
  readonly specifier: string | undefined;
};

function readModuleClause(source: string, start: number): Clause {
  let index = skipSpaceAndComments(source, start);
  const current = charAt(source, index);
  if (current === '"' || current === "'") {
    const literal = readQuoted(source, index);
    if (literal === undefined) {
      return { end: index + 1, specifier: undefined };
    }
    return { end: literal.end, specifier: literal.value };
  }
  if (current === "{") {
    const closed = skipBalanced(source, index, "{", "}");
    index = skipSpaceAndComments(source, closed);
    return readFrom(source, index);
  }
  if (current === "*") {
    index = skipSpaceAndComments(source, index + 1);
    const asKeyword = readIdent(source, index);
    if (asKeyword.text === "as") {
      index = skipSpaceAndComments(source, asKeyword.end);
      index = skipSpaceAndComments(source, readIdent(source, index).end);
    }
    return readFrom(source, index);
  }

  while (index < source.length) {
    index = skipSpaceAndComments(source, index);
    const next = charAt(source, index);
    if (next === "{") {
      index = skipBalanced(source, index, "{", "}");
      continue;
    }
    if (next === "=" || next === "(" || next === ";" || next === ":") {
      return { end: index, specifier: undefined };
    }
    if (!isIdentStart(next)) {
      return { end: index === start ? index + 1 : index, specifier: undefined };
    }
    const word = readIdent(source, index);
    if (word.text === "from") {
      return readFrom(source, index);
    }
    if (DECLARATIONS.has(word.text)) {
      return { end: index, specifier: undefined };
    }
    index = word.end;
    if (charAt(source, skipSpaceAndComments(source, index)) === ",") {
      index = skipSpaceAndComments(source, index) + 1;
    }
  }
  return { end: index, specifier: undefined };
}

function readFrom(source: string, start: number): Clause {
  const index = skipSpaceAndComments(source, start);
  const word = readIdent(source, index);
  if (word.text !== "from") {
    return { end: index, specifier: undefined };
  }
  const literalAt = skipSpaceAndComments(source, word.end);
  const literal = readQuoted(source, literalAt);
  if (literal === undefined) {
    return { end: literalAt, specifier: undefined };
  }
  return { end: literal.end, specifier: literal.value };
}

function skipBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const current = charAt(source, index);
    if (current === '"' || current === "'" || current === "`") {
      index = skipLiteral(source, index);
      continue;
    }
    if (
      current === "/" &&
      (charAt(source, index + 1) === "/" || charAt(source, index + 1) === "*")
    ) {
      index = skipComment(source, index);
      continue;
    }
    if (current === open) {
      depth += 1;
    } else if (current === close) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return index;
}

function skipLiteral(source: string, start: number): number {
  const quote = charAt(source, start);
  let index = start + 1;
  while (index < source.length) {
    const current = charAt(source, index);
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === quote) {
      return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipComment(source: string, start: number): number {
  if (charAt(source, start + 1) === "/") {
    let index = start + 2;
    while (index < source.length && charAt(source, index) !== "\n") {
      index += 1;
    }
    return index;
  }
  let index = start + 2;
  while (
    index < source.length &&
    !(charAt(source, index) === "*" && charAt(source, index + 1) === "/")
  ) {
    index += 1;
  }
  return Math.min(source.length, index + 2);
}

function skipSpaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const current = charAt(source, index);
    if (current === " " || current === "\t" || current === "\n" || current === "\r") {
      index += 1;
      continue;
    }
    if (
      current === "/" &&
      (charAt(source, index + 1) === "/" || charAt(source, index + 1) === "*")
    ) {
      index = skipComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

type Quoted = {
  readonly end: number;
  readonly value: string;
};

function readQuoted(source: string, start: number): Quoted | undefined {
  const quote = charAt(source, start);
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const current = charAt(source, index);
    if (current === "\\") {
      value += charAt(source, index + 1);
      index += 2;
      continue;
    }
    if (current === quote) {
      return { end: index + 1, value };
    }
    if (current === "\n") {
      return undefined;
    }
    value += current;
    index += 1;
  }
  return undefined;
}

type Ident = {
  readonly end: number;
  readonly text: string;
};

function readIdent(source: string, start: number): Ident {
  let index = start;
  while (isIdentPart(charAt(source, index))) {
    index += 1;
  }
  return { end: index, text: source.slice(start, index) };
}

const DECLARATIONS: ReadonlySet<string> = new Set([
  "abstract",
  "async",
  "class",
  "const",
  "default",
  "enum",
  "function",
  "interface",
  "let",
  "namespace",
  "var",
]);

function charAt(source: string, index: number): string {
  return source[index] ?? "";
}

function isIdentStart(value: string): boolean {
  return /[A-Za-z_$]/.test(value);
}

function isIdentPart(value: string): boolean {
  return /[A-Za-z0-9_$]/.test(value);
}
