import path from "node:path";
import {
  auditRoot, finding, finish, nearestFunction, parseModule, propertyName, sourceFile, visit, walkFiles,
} from "./_shared.mjs";

const root = auditRoot();
const findings = [];
const riskyName = /(?:requestFingerprint|deliveryFingerprint|fingerprint|evidence|shared|overlap|originalMessageId|parentMessageId|messageId|accountLifecycleId|lifecycle|identityKey|revision|idempotencyKey|authVersion|authenticated|accepted|valid|success|parsed)/i;

function collectConstants(ast) {
  const constants = new Map();
  const duplicates = new Set();
  visit(ast, (node, ancestors) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || !node.init) return;
    const name = node.id.name;
    if (constants.has(name)) duplicates.add(name);
    else constants.set(name, node.init);
  });
  for (const name of duplicates) constants.delete(name);
  return constants;
}

function favorable(node, constants, seen = new Set()) {
  if (!node) return false;
  if (node.type === "StringLiteral") return node.value.length > 0;
  if (node.type === "NumericLiteral") return node.value !== 0;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return false;
  if (node.type === "TemplateLiteral") return node.expressions.length > 0 || node.quasis.some((part) => Boolean(part.value?.cooked));
  if (node.type === "ArrayExpression") return node.elements.length > 0;
  if (node.type === "ObjectExpression") return node.properties.length > 0;
  if (node.type === "NewExpression" || node.type === "CallExpression") return true;
  if (node.type === "UnaryExpression" && node.operator === "-") return false;
  if (node.type === "ConditionalExpression") {
    return favorable(node.consequent, constants, seen) || favorable(node.alternate, constants, seen);
  }
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
    const object = resolvedObject(node.object, constants, seen);
    const name = !node.computed && node.property?.type === "Identifier"
      ? node.property.name
      : node.computed && node.property?.type === "StringLiteral" ? node.property.value : "";
    const property = object?.properties?.find((candidate) => (
      candidate.type === "ObjectProperty" && String(propertyName(candidate)) === String(name)
    ));
    return property ? favorable(property.value, constants, seen) : false;
  }
  if (node.type === "Identifier" && constants.has(node.name) && !seen.has(node.name)) {
    const nextSeen = new Set(seen);
    nextSeen.add(node.name);
    return favorable(constants.get(node.name), constants, nextSeen);
  }
  return false;
}

function defaultParameters(node) {
  const found = [];
  const collectPattern = (pattern) => {
    if (pattern?.type !== "ObjectPattern") return;
    for (const property of pattern.properties || []) {
      if (property.type === "RestElement") continue;
      if (property.value?.type === "AssignmentPattern") {
        if (property.value.left?.type === "ObjectPattern") collectPattern(property.value.left);
        else found.push({ name: propertyName(property) || property.value.left?.name || "", parameter: property.value });
      } else if (property.value?.type === "ObjectPattern") {
        collectPattern(property.value);
      }
    }
  };
  for (const parameter of node.params || []) {
    if (parameter.type === "AssignmentPattern") {
      if (parameter.left?.type === "ObjectPattern") collectPattern(parameter.left);
      else if (parameter.right?.type === "ObjectExpression") {
        for (const property of parameter.right.properties || []) {
          const name = String(propertyName(property));
          if (property.type === "ObjectProperty" && riskyName.test(name)) {
            found.push({ name, parameter: { ...parameter, right: property.value, loc: property.loc } });
          }
        }
      } else found.push({ name: parameter.left?.name || "", parameter });
    } else collectPattern(parameter);
  }
  return found;
}

function resolvedObject(node, constants, seen = new Set()) {
  if (node?.type === "ObjectExpression") return node;
  if (node?.type !== "Identifier" || !constants.has(node.name) || seen.has(node.name)) return null;
  const next = new Set(seen);
  next.add(node.name);
  return resolvedObject(constants.get(node.name), constants, next);
}

function friendlyObjectProperties(node, constants, seen = new Set()) {
  if (node?.type === "Identifier" && seen.has(node.name)) return [];
  const nextSeen = node?.type === "Identifier" ? new Set([...seen, node.name]) : seen;
  const object = resolvedObject(node, constants, seen);
  if (!object) return [];
  const found = [];
  for (const property of object.properties || []) {
    if (property.type === "ObjectProperty"
      && riskyName.test(String(propertyName(property)))
      && favorable(property.value, constants)) found.push(property);
    if (property.type === "SpreadElement") found.push(...friendlyObjectProperties(property.argument, constants, nextSeen));
  }
  return found;
}

function memberRiskName(node) {
  if (!node || !["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return "";
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "StringLiteral") return node.property.value;
  return "";
}

function overrideParameterNames(fn) {
  const names = new Set();
  for (const parameter of fn?.params || []) {
    if (parameter.type === "AssignmentPattern" && parameter.left?.type === "Identifier"
      && parameter.right?.type === "ObjectExpression" && parameter.right.properties.length === 0) names.add(parameter.left.name);
  }
  return names;
}

for (const file of await walkFiles(path.join(root, "tests"), (target) => /\.(?:js|mjs|cjs)$/.test(target))) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push(finding(root, file, { loc: error.loc ? { start: error.loc } : undefined }, "test-default-parse", `无法解析测试：${error.message}`));
    continue;
  }
  const constants = collectConstants(ast);
  visit(ast, (node, ancestors) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(node.type)) return;
    for (const item of defaultParameters(node)) {
      if (!riskyName.test(item.name) || !favorable(item.parameter.right, constants)) continue;
      findings.push(finding(
        root,
        file,
        item.parameter,
        "friendly-test-default",
        `测试辅助参数 ${item.name} 使用会自动满足关联/身份/成功条件的默认值；应改成空/失败默认并在用例中显式传入`,
      ));
    }
  });
  visit(ast, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && node.init?.type === "LogicalExpression" && ["??", "||"].includes(node.init.operator)
      && (riskyName.test(node.id.name) || riskyName.test(memberRiskName(node.init.left)))
      && favorable(node.init.right, constants)) {
      findings.push(finding(
        root,
        file,
        node,
        "friendly-test-default",
        `测试辅助值 ${node.id.name} 在函数体内使用有利的空值回退；应默认为空/失败并由用例显式传入`,
      ));
    }
    if (node.type === "AssignmentExpression" && ["??=", "||="].includes(node.operator)
      && riskyName.test(memberRiskName(node.left)) && favorable(node.right, constants)) {
      findings.push(finding(
        root,
        file,
        node,
        "friendly-test-default",
        `测试辅助字段 ${memberRiskName(node.left)} 使用有利的赋值回退；应默认为空/失败并由用例显式传入`,
      ));
    }
    if (node.type !== "SpreadElement") return;
    const fn = nearestFunction(ancestors);
    const overrides = overrideParameterNames(fn);
    const object = [...ancestors].reverse().find((ancestor) => ancestor.type === "ObjectExpression");
    const hasOverrideSpread = object?.properties?.some((property) => property.type === "SpreadElement"
      && property.argument?.type === "Identifier" && overrides.has(property.argument.name));
    if (!hasOverrideSpread) return;
    for (const property of friendlyObjectProperties(node.argument, constants)) {
      findings.push(finding(
        root,
        file,
        node,
        "friendly-test-default",
        `测试辅助对象展开时默认提供有利字段 ${propertyName(property)}；应使用空/失败默认值`,
      ));
    }
  });
}

finish(findings);
