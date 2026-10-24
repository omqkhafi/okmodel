/**
 * Whether a new column's default or NULL fails a check expression.
 *
 * The linter does not connect. This covers the predicates OKModel emits and
 * the same shapes written by hand: comparisons, `IN`, `IS NULL`, `AND` /
 * `OR` / `NOT`, and `COALESCE`. Anything else is unknown, and unknown is not
 * reported as a violation.
 */

type Literal = {
  readonly kind: "null" | "text" | "number" | "bool";
  readonly text: string;
};

type Truth = boolean | undefined;

type Token = {
  readonly kind: "word" | "string" | "number" | "op";
  readonly text: string;
};

/**
 * Reports whether `defaultSql` makes `expression` false.
 *
 * A non-literal default is unknown. Unknown is not a violation.
 *
 * @param column - SQL name of the new column
 * @param defaultSql - Default expression from the column or the `ADD COLUMN`
 * @param expression - Check expression without the `CHECK` keyword
 * @returns `true` when every existing row that receives this default fails
 */
export function defaultViolatesCheck(
  column: string,
  defaultSql: string,
  expression: string,
): boolean {
  const literal = parseLiteral(defaultSql.trim());
  if (literal === undefined) return false;
  return evaluate(column, expression, literal) === false;
}

/**
 * Reports whether NULL makes `expression` false.
 *
 * `CHECK` allows unknown, so `NULL IN ('a')` does not reject NULL.
 *
 * @param column - SQL name of the new column
 * @param expression - Check expression without the `CHECK` keyword
 * @returns `true` when a nullable column with no default fails the check
 */
export function checkRejectsNull(column: string, expression: string): boolean {
  return evaluate(column, expression, { kind: "null", text: "null" }) === false;
}

function evaluate(column: string, expression: string, value: Literal): Truth {
  try {
    const parser = new Parser(tokenize(expression), column, value);
    const result = parser.parseOr();
    return parser.finished() ? result : undefined;
  } catch {
    return undefined;
  }
}

class Parser {
  private index = 0;
  private readonly tokens: readonly Token[];
  private readonly column: string;
  private readonly value: Literal;

  constructor(tokens: readonly Token[], column: string, value: Literal) {
    this.tokens = tokens;
    this.column = column;
    this.value = value;
  }

  finished(): boolean {
    return this.index >= this.tokens.length;
  }

  parseOr(): Truth {
    let left = this.parseAnd();
    while (this.eatWord("or")) {
      const right = this.parseAnd();
      left = orTruth(left, right);
    }
    return left;
  }

  private parseAnd(): Truth {
    let left = this.parseNot();
    while (this.eatWord("and")) {
      const right = this.parseNot();
      left = andTruth(left, right);
    }
    return left;
  }

  private parseNot(): Truth {
    if (this.eatWord("not")) return notTruth(this.parseNot());
    return this.parsePredicate();
  }

  private parsePredicate(): Truth {
    if (this.eatWord("coalesce")) return this.finishPredicate(this.parseCoalesce());
    const left = this.parsePrimary();
    return this.finishPredicate(left);
  }

  private finishPredicate(left: Literal | undefined): Truth {
    if (this.eatWord("is")) {
      const not = this.eatWord("not");
      if (this.eatWord("distinct")) {
        this.expectWord("from");
        const right = this.parsePrimary();
        const distinct = distinctFrom(left, right);
        if (distinct === undefined) return undefined;
        return not ? !distinct : distinct;
      }
      this.expectWord("null");
      const isNull = left !== undefined && left.kind === "null";
      if (left === undefined) return undefined;
      return not ? !isNull : isNull;
    }
    if (this.eatWord("in")) {
      this.expectOp("(");
      const list = this.parseList();
      this.expectOp(")");
      return inList(left, list);
    }
    if (this.peekWord("not") && this.tokens[this.index + 1]?.text === "in") {
      this.eatWord("not");
      this.eatWord("in");
      this.expectOp("(");
      const list = this.parseList();
      this.expectOp(")");
      return notTruth(inList(left, list));
    }
    const op = this.peek()?.kind === "op" ? this.peek()?.text : undefined;
    if (op === "=" && this.tokens[this.index + 1]?.text === "any") {
      this.index += 1;
      this.eatWord("any");
      this.expectOp("(");
      this.expectWord("array");
      this.expectOp("[");
      const list = this.parseList();
      this.expectOp("]");
      this.expectOp(")");
      return inList(left, list);
    }
    if (
      op === "=" ||
      op === "<>" ||
      op === "!=" ||
      op === ">" ||
      op === ">=" ||
      op === "<" ||
      op === "<="
    ) {
      this.index += 1;
      const right = this.parsePrimary();
      return compare(left, op, right);
    }
    return truthOf(left);
  }

  private parseCoalesce(): Literal | undefined {
    this.expectOp("(");
    const first = this.parsePrimary();
    const rest: (Literal | undefined)[] = [];
    while (this.eatOp(",")) rest.push(this.parsePrimary());
    this.expectOp(")");
    if (first !== undefined && first.kind !== "null") return first;
    for (const item of rest) {
      if (item === undefined) return undefined;
      if (item.kind !== "null") return item;
    }
    return first;
  }

  private parsePrimary(): Literal | undefined {
    if (this.eatOp("(")) {
      const parsed = this.parseOr();
      this.expectOp(")");
      if (parsed === undefined) return undefined;
      return parsed ? { kind: "bool", text: "true" } : { kind: "bool", text: "false" };
    }
    if (this.eatWord("coalesce")) return this.parseCoalesce();
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error("end");
    this.index += 1;
    if (token.kind === "string") return this.withCast({ kind: "text", text: token.text });
    if (token.kind === "number") return this.withCast({ kind: "number", text: token.text });
    if (token.kind === "word" && token.text === "null")
      return this.withCast({ kind: "null", text: "null" });
    if (token.kind === "word" && (token.text === "true" || token.text === "false")) {
      return this.withCast({ kind: "bool", text: token.text });
    }
    if (token.kind === "word" && sameColumn(token.text, this.column))
      return this.withCast(this.value);
    return undefined;
  }

  private withCast(literal: Literal | undefined): Literal | undefined {
    if (this.peek()?.text !== "::") return literal;
    this.index += 1;
    if (this.peek()?.kind === "word") this.index += 1;
    while (
      this.peek()?.kind === "word" &&
      this.peek()?.text !== "and" &&
      this.peek()?.text !== "or"
    ) {
      const text = this.peek()?.text ?? "";
      if (text === "null" || text === "is" || text === "in" || text === "not") break;
      this.index += 1;
    }
    if (this.peek()?.text === "(") {
      this.index += 1;
      while (!this.finished() && this.peek()?.text !== ")") this.index += 1;
      this.eatOp(")");
    }
    return literal;
  }

  private parseList(): readonly (Literal | undefined)[] {
    const list: (Literal | undefined)[] = [];
    if (this.peek()?.text === ")" || this.peek()?.text === "]") return list;
    list.push(this.parsePrimary());
    while (this.eatOp(",")) list.push(this.parsePrimary());
    return list;
  }

  private eatWord(word: string): boolean {
    if (this.peek()?.kind !== "word" || this.peek()?.text !== word) return false;
    this.index += 1;
    return true;
  }

  private expectWord(word: string): void {
    if (!this.eatWord(word)) throw new Error(word);
  }

  private expectOp(op: string): void {
    if (!this.eatOp(op)) throw new Error(op);
  }

  private eatOp(op: string): boolean {
    if (this.peek()?.text !== op) return false;
    this.index += 1;
    return true;
  }

  private peekWord(word: string): boolean {
    return this.peek()?.kind === "word" && this.peek()?.text === word;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function tokenize(expression: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] ?? "";
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "'") {
      let value = "";
      index += 1;
      while (index < expression.length) {
        const next = expression[index] ?? "";
        if (next === "'" && expression[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        if (next === "'") {
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      tokens.push({ kind: "string", text: value });
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < expression.length) {
        const next = expression[index] ?? "";
        if (next === '"' && expression[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        if (next === '"') {
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      tokens.push({ kind: "word", text: value });
      continue;
    }
    if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(expression[index + 1] ?? ""))) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(expression.slice(index));
      if (match === null) throw new Error("number");
      tokens.push({ kind: "number", text: match[0] });
      index += match[0].length;
      continue;
    }
    const op = twoCharOp(expression, index) ?? oneCharOp(char);
    if (op !== undefined) {
      tokens.push({ kind: "op", text: op });
      index += op.length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][\w$]*/.exec(expression.slice(index));
      if (match === null) throw new Error("word");
      tokens.push({ kind: "word", text: match[0].toLowerCase() });
      index += match[0].length;
      continue;
    }
    throw new Error(char);
  }
  return tokens;
}

function twoCharOp(expression: string, index: number): string | undefined {
  const pair = expression.slice(index, index + 2);
  if (pair === "<>" || pair === "!=" || pair === ">=" || pair === "<=" || pair === "::")
    return pair;
  return undefined;
}

function oneCharOp(char: string): string | undefined {
  if ("=<>()[],".includes(char)) return char;
  return undefined;
}

function parseLiteral(sql: string): Literal | undefined {
  let body = sql.trim();
  body = stripCast(body);
  if (/^null$/i.test(body)) return { kind: "null", text: "null" };
  if (/^true$/i.test(body)) return { kind: "bool", text: "true" };
  if (/^false$/i.test(body)) return { kind: "bool", text: "false" };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(body)) return { kind: "number", text: body };
  if (!body.startsWith("'")) return undefined;
  let value = "";
  let index = 1;
  while (index < body.length) {
    const next = body[index] ?? "";
    if (next === "'" && body[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }
    if (next === "'") {
      index += 1;
      break;
    }
    value += next;
    index += 1;
  }
  if (stripCast(body.slice(index).trim()) !== "") return undefined;
  return { kind: "text", text: value };
}

function stripCast(sql: string): string {
  let body = sql.trim();
  for (;;) {
    const match =
      /::(?:character varying|double precision|timestamp (?:with|without) time zone|[A-Za-z_][\w$]*)(?:\(\d+(?:\s*,\s*\d+)?\))?$/i.exec(
        body,
      );
    if (match === null || match.index === 0) return body;
    body = body.slice(0, match.index).trim();
  }
}

function sameColumn(token: string, column: string): boolean {
  return token === column || token.toLowerCase() === column.toLowerCase();
}

function inList(left: Literal | undefined, list: readonly (Literal | undefined)[]): Truth {
  if (left === undefined) return undefined;
  if (left.kind === "null") return undefined;
  let sawUnknown = false;
  for (const item of list) {
    if (item === undefined) {
      sawUnknown = true;
      continue;
    }
    if (item.kind === "null") return undefined;
    if (sameLiteral(left, item)) return true;
  }
  return sawUnknown ? undefined : false;
}

function compare(left: Literal | undefined, op: string, right: Literal | undefined): Truth {
  if (left === undefined || right === undefined) return undefined;
  if (left.kind === "null" || right.kind === "null") return undefined;
  if (op === "=") return sameLiteral(left, right);
  if (op === "<>" || op === "!=") return !sameLiteral(left, right);
  const order = orderOf(left, right);
  if (order === undefined) return undefined;
  if (op === ">") return order > 0;
  if (op === ">=") return order >= 0;
  if (op === "<") return order < 0;
  return order <= 0;
}

function orderOf(left: Literal, right: Literal): number | undefined {
  if (left.kind === "number" && right.kind === "number")
    return Number(left.text) - Number(right.text);
  if (left.kind === "text" && right.kind === "text") {
    if (left.text === right.text) return 0;
    return left.text < right.text ? -1 : 1;
  }
  return undefined;
}

function sameLiteral(left: Literal, right: Literal): boolean {
  return left.kind === right.kind && left.text === right.text;
}

function distinctFrom(left: Literal | undefined, right: Literal | undefined): boolean | undefined {
  if (left === undefined || right === undefined) return undefined;
  if (left.kind === "null" && right.kind === "null") return false;
  if (left.kind === "null" || right.kind === "null") return true;
  return !sameLiteral(left, right);
}

function truthOf(literal: Literal | undefined): Truth {
  if (literal === undefined) return undefined;
  if (literal.kind === "bool") return literal.text === "true";
  if (literal.kind === "null") return undefined;
  return undefined;
}

function andTruth(left: Truth, right: Truth): Truth {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return undefined;
}

function orTruth(left: Truth, right: Truth): Truth {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return undefined;
}

function notTruth(value: Truth): Truth {
  if (value === undefined) return undefined;
  return !value;
}
