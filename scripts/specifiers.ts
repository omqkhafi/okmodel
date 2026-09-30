import { parseSync, Visitor, type Expression } from "oxc-parser";

/**
 * Module specifiers from the Oxc AST, including type-only imports and dynamic `import()`.
 *
 * String literals and comments that look like imports are not specifiers.
 * A non-literal dynamic import has no static specifier, so it is skipped.
 */
export function moduleSpecifiers(source: string, filename = "module.ts"): readonly string[] {
  const text = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  const parsed = parseSync(filename, text, { lang: "ts", sourceType: "module" });
  const failure = parsed.errors[0];
  if (failure !== undefined) {
    throw new Error(`${filename}: ${failure.message}`);
  }

  const found = new Set<string>();
  const visitor = new Visitor({
    ImportDeclaration(node) {
      found.add(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        found.add(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      found.add(node.source.value);
    },
    ImportExpression(node) {
      const specifier = stringLiteral(node.source);
      if (specifier !== undefined) {
        found.add(specifier);
      }
    },
  });
  visitor.visit(parsed.program);
  return [...found];
}

function stringLiteral(expression: Expression): string | undefined {
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  return undefined;
}
