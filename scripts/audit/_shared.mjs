import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("next/dist/compiled/babel/parser");

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function auditRoot(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--root");
  return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]) : defaultRoot;
}

export async function walkFiles(directory, predicate = () => true) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (["node_modules", ".git", ".next", "coverage"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(target, predicate));
    else if (predicate(target)) files.push(target);
  }
  return files;
}

export function sourceFile(file) {
  return readFile(file, "utf8");
}

export function parseModule(source, file = "unknown.js") {
  return parse(source, {
    sourceType: "unambiguous",
    sourceFilename: file,
    errorRecovery: false,
    plugins: [
      "jsx",
      "importAttributes",
      "topLevelAwait",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "optionalChaining",
      "nullishCoalescingOperator",
      "dynamicImport",
    ],
  });
}

export function visit(node, callback, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") callback(node, ancestors);
  const nextAncestors = typeof node.type === "string" ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback, nextAncestors);
    } else if (value && typeof value === "object") {
      visit(value, callback, nextAncestors);
    }
  }
}

export function nearestFunction(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(node.type)) return node;
  }
  return null;
}

export function nodeText(source, node) {
  return source.slice(Number(node?.start || 0), Number(node?.end || 0));
}

export function relative(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

export function finding(root, file, node, code, message) {
  return {
    file: relative(root, file),
    line: Number(node?.loc?.start?.line || 1),
    column: Number(node?.loc?.start?.column || 0) + 1,
    code,
    message,
  };
}

export function finish(findings) {
  const unique = Array.from(new Map(findings.map((item) => [
    `${item.file}:${item.line}:${item.column}:${item.code}:${item.message}`,
    item,
  ])).values()).sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.code.localeCompare(right.code)
  ));
  for (const item of unique) {
    process.stdout.write(`${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}\n`);
  }
  if (unique.length) process.exitCode = 1;
  return unique;
}

export function isLiteralValue(node, expected) {
  if (!node) return false;
  if (["BooleanLiteral", "StringLiteral", "NumericLiteral"].includes(node.type)) return node.value === expected;
  if (node.type === "NullLiteral") return expected === null;
  return false;
}

export function propertyName(property) {
  if (!property || property.computed) {
    return property?.key?.type === "StringLiteral" ? property.key.value : "";
  }
  return property.key?.name || property.key?.value || "";
}

export function objectProperty(node, name) {
  if (node?.type !== "ObjectExpression") return null;
  return node.properties.find((property) => property.type === "ObjectProperty" && propertyName(property) === name) || null;
}

export function containsNode(container, target) {
  return Boolean(container && target && Number(container.start) <= Number(target.start) && Number(container.end) >= Number(target.end));
}

export function functionName(node, source = "") {
  if (!node) return "<module>";
  if (node.id?.name) return node.id.name;
  return nodeText(source, node).slice(0, 80).replace(/\s+/g, " ");
}
