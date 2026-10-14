/**
 * Opening figure on a Define page. The call is labeled. Each note sits under
 * the sample and lights the same place.
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

/** `args` is `call(…)`. `object` is `call({ … })`. */
export type AnatomyShape = "args" | "object";

/** A line of the sample, with the mark that names its place. */
interface Line {
  readonly code: string;
  readonly mark?: string;
  /** Extra spaces after the two-space call indent. */
  readonly indent?: number;
}

/** GitHub theme colors, the same pair the code blocks use. */
const TONE = {
  plain: "text-[#24292E] dark:text-[#E1E4E8]",
  fn: "text-[#6F42C1] dark:text-[#B392F0]",
  kw: "text-[#D73A49] dark:text-[#F97583]",
  str: "text-[#032F62] dark:text-[#9ECBFF]",
  bool: "text-[#005CC5] dark:text-[#79B8FF]",
} as const;

type Tone = keyof typeof TONE;

const TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:false|true)\b|\b(?:export|default|import|from|const)\b|\.[A-Za-z_][A-Za-z0-9_]*(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/g;

const NOTE =
  "mt-1 max-w-[68ch] text-[13px] leading-relaxed text-fd-muted-foreground [&_a]:font-medium [&_a]:text-fd-foreground [&_a]:underline [&_code]:rounded-sm [&_code]:bg-fd-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-fd-foreground [&_p]:my-0";

/**
 * One line inside an {@link AnatomyPart}. The parent draws it. Rendering the
 * line itself draws nothing.
 */
export interface AnatomyLineProps {
  /** Source text, without the call indent. */
  readonly code: string;
  /** Short mark at the end of the line. */
  readonly mark?: string;
  /** Extra spaces after the call indent. */
  readonly indent?: number;
}

/**
 * Slot marker for a line of an {@link AnatomyPart}.
 *
 * @param _props - The line. The parent reads it.
 */
export function AnatomyLine(_props: AnatomyLineProps): ReactNode {
  return null;
}

/**
 * One labeled place in the call. `code` is a single line. Several
 * {@link AnatomyLine} children are a block. The other children are the note.
 */
export interface AnatomyPartProps {
  /** Hover key shared by this place in the sample and its note. */
  readonly slot: string;
  /** Note heading. */
  readonly label: string;
  /** Source text when this place is one line. */
  readonly code?: string;
  /** Short mark at the end of that line. */
  readonly mark?: string;
  /** Extra spaces after the call indent. */
  readonly indent?: number;
  /** Lines, then the note. Links stay markdown. */
  readonly children?: ReactNode;
}

/**
 * Slot marker for {@link Anatomy}. Direct child only.
 *
 * @param _props - Slot, label, and the note. The parent reads them.
 */
export function AnatomyPart(_props: AnatomyPartProps): ReactNode {
  return null;
}

/** One place, after its lines and its note are split. */
interface DrawnPart {
  readonly slot: string;
  readonly label: string;
  readonly lines: readonly Line[];
  readonly note: ReactNode;
}

/**
 * The call, with each place labeled. The notes sit under the sample.
 *
 * @param props - `call` is the function name. `shape` chooses parentheses or an object. `exported` prints `export default`, or `export const <name> =` when it is a binding name.
 */
export function Anatomy({
  call,
  shape,
  exported = false,
  children,
}: {
  readonly call: string;
  readonly shape: AnatomyShape;
  /** `true` prints `export default`. A string prints `export const <name> =`. */
  readonly exported?: boolean | string;
  readonly children?: ReactNode;
}): ReactNode {
  const parts = readParts(children);
  if (parts.length === 0) return children;
  const close = `${shape === "object" ? "})" : ")"}${exported === false ? "" : ";"}`;
  return (
    <figure
      className="anatomy not-prose my-4 overflow-hidden rounded-xl border bg-fd-card text-sm shadow-sm"
      aria-label={`Anatomy of ${call}()`}
    >
      <figcaption className="flex h-9.5 items-center gap-2 border-b px-4 text-fd-muted-foreground">
        <span className="font-mono text-[13px] text-fd-foreground">{call}()</span>
        <span className="ml-auto font-mono text-[10px] tracking-[0.16em] uppercase">Anatomy</span>
      </figcaption>
      <div className="px-4 py-4 font-mono text-[13px] leading-6">
        <div>
          {exported === true ? <Tok tone="kw">export default </Tok> : null}
          {typeof exported === "string" ? (
            <>
              <Tok tone="kw">export const </Tok>
              <Tok tone="bool">{exported}</Tok>
              <Tok tone="plain"> = </Tok>
            </>
          ) : null}
          <Tok tone="fn">{call}</Tok>
          <Tok tone="plain">{shape === "object" ? "({" : "("}</Tok>
        </div>
        {parts.map((part) => (
          <div key={part.slot} data-slot={part.slot} className="rounded-sm">
            {part.lines.map((line, index) => (
              <CodeLine key={`${part.slot}-${index}`} line={line} />
            ))}
          </div>
        ))}
        <div>
          <Tok tone="plain">{close}</Tok>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t px-2 py-2">
        {parts.map((part) => (
          <div key={part.slot} data-slot={part.slot} className="rounded-sm px-2 py-2">
            <p className="font-mono text-[10px] font-medium tracking-[0.16em] text-fd-muted-foreground uppercase">
              {part.label}
            </p>
            <div className={NOTE}>{part.note}</div>
          </div>
        ))}
      </div>
    </figure>
  );
}

/**
 * Direct {@link AnatomyPart} children, in source order.
 *
 * @param children - Figure children
 */
function readParts(children: ReactNode): readonly DrawnPart[] {
  const parts: DrawnPart[] = [];
  for (const child of Children.toArray(children)) {
    if (!isPart(child)) continue;
    parts.push(drawn(child.props));
  }
  return parts;
}

/**
 * Split a part into sample lines and the note.
 *
 * @param props - The part
 */
function drawn(props: AnatomyPartProps): DrawnPart {
  const lines: Line[] = [];
  const notes: ReactNode[] = [];
  if (props.code !== undefined) {
    lines.push({ code: props.code, mark: props.mark, indent: props.indent });
  }
  for (const child of Children.toArray(props.children)) {
    if (isLine(child)) {
      lines.push({ code: child.props.code, mark: child.props.mark, indent: child.props.indent });
      continue;
    }
    if (typeof child === "string" && child.trim() === "") continue;
    notes.push(child);
  }
  return { slot: props.slot, label: props.label, lines, note: notes };
}

/**
 * True when the node is an {@link AnatomyPart}.
 *
 * @param node - One child
 */
function isPart(node: ReactNode): node is ReactElement<AnatomyPartProps> {
  return isValidElement<AnatomyPartProps>(node) && node.type === AnatomyPart;
}

/**
 * True when the node is an {@link AnatomyLine}.
 *
 * @param node - One child
 */
function isLine(node: ReactNode): node is ReactElement<AnatomyLineProps> {
  return isValidElement<AnatomyLineProps>(node) && node.type === AnatomyLine;
}

/**
 * One source line, indented, and the mark that names its place.
 *
 * @param props - The line
 */
function CodeLine({ line }: { readonly line: Line }): ReactNode {
  const pad = " ".repeat(2 + (line.indent ?? 0));
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <code className="max-w-full overflow-x-auto whitespace-pre">{colorize(pad + line.code)}</code>
      {line.mark !== undefined ? (
        <span className="font-mono text-[11px] tracking-wide text-fd-muted-foreground">{line.mark}</span>
      ) : null}
    </div>
  );
}

/**
 * GitHub-colored spans for one line.
 *
 * @param code - Source text
 */
function colorize(code: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(TOKEN)) {
    const text = match[0];
    const index = match.index;
    if (index > cursor) {
      nodes.push(
        <Tok key={cursor} tone="plain">
          {code.slice(cursor, index)}
        </Tok>,
      );
    }
    nodes.push(
      <Tok key={index} tone={toneFor(text)}>
        {text}
      </Tok>,
    );
    cursor = index + text.length;
  }
  if (cursor < code.length) {
    nodes.push(
      <Tok key={cursor} tone="plain">
        {code.slice(cursor)}
      </Tok>,
    );
  }
  return nodes;
}

/**
 * Tone for one token.
 *
 * @param text - The matched token
 */
function toneFor(text: string): Tone {
  if (text.startsWith('"') || text.startsWith("'")) return "str";
  if (text === "false" || text === "true") return "bool";
  if (
    text === "export" ||
    text === "default" ||
    text === "import" ||
    text === "from" ||
    text === "const"
  ) {
    return "kw";
  }
  return "fn";
}

/**
 * One colored token.
 *
 * @param props - Tone and text
 */
function Tok({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }): ReactNode {
  return <span className={TONE[tone]}>{children}</span>;
}
