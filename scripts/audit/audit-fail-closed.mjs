import path from "node:path";
import {
  auditRoot, finding, finish, nodeText, objectProperty, parseModule,
  sourceFile, visit, walkFiles,
} from "./_shared.mjs";

const root = auditRoot();
const findings = [];
const formatError = /(?:^|[_-])(?:invalid|malformed|corrupt|bad[_-]?format|parse[_-]?failed|deserialize[_-]?failed|decode[_-]?failed|record[_-]?invalid|legacy[_-]?invalid)(?:$|[_-])|(?:profile|record|payload|document)[_-](?:deserialize|decode|parse)[_-]failed|unsupported[_-](?:record|profile|version)/i;
const formatCondition = /(?:Number\.is(?:Safe)?Integer|Number\.isFinite|typeof\s+[^=!<>]+[!=]==?\s*["']|instanceof|\.test\s*\(|JSON\.parse|parseInt|parseFloat|isNaN|invalid|malformed|corrupt|legacy|record[_-]?invalid)/i;
const strongFormatCondition = /(?:__format_null_risk__|JSON\.parse|malformed|corrupt|legacy|record[_-]?invalid|profile[_-]?invalid|deserialize|decode[_-]?failed)/i;
const formatRecovery = /(?:repairCorrupt|forceRepair|automatic[_-]?repair|history[_-]?repair)/i;
const trueOutage = /(?:unavailable|timeout|timed[_-]?out|transport|network|provider|configuration|not[_-]?configured|storage|redis|service[_-]?down|upstream|journal|save[_-]?failed)/i;

function literalText(node, source, constants = new Map(), environment = new Map(), seen = new Set()) {
  if (!node) return "";
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map((part) => part.value?.cooked || "").join("");
  if (node.type === "Identifier" && !seen.has(node.name)) {
    const target = environment.get(node.name) || constants.get(node.name);
    if (target) return literalText(target, source, constants, environment, new Set([...seen, node.name]));
  }
  return nodeText(source, node);
}

function responseErrorNode(statusProperty, ancestors) {
  const owner = [...ancestors].reverse().find((ancestor) => ancestor.type === "ObjectExpression" && objectProperty(ancestor, "status") === statusProperty);
  if (owner && objectProperty(owner, "error")) return objectProperty(owner, "error").value;
  const call = [...ancestors].reverse().find((ancestor) => ancestor.type === "CallExpression");
  for (const argument of call?.arguments || []) {
    if (argument.type !== "ObjectExpression") continue;
    const property = objectProperty(argument, "error");
    if (property) return property.value;
  }
  return null;
}

function collectConstants(ast) {
  const constants = new Map();
  const duplicates = new Set();
  visit(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || !node.init) return;
    if (constants.has(node.id.name)) duplicates.add(node.id.name);
    else constants.set(node.id.name, node.init);
  });
  for (const name of duplicates) constants.delete(name);
  return constants;
}

function resolvedNumber(node, constants, seen = new Set(), environment = new Map()) {
  if (!node) return null;
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) {
    const value = resolvedNumber(node.argument, constants, seen, environment);
    return value === null ? null : node.operator === "-" ? -value : value;
  }
  if (node.type === "BinaryExpression" && ["+", "-", "*", "/"].includes(node.operator)) {
    const left = resolvedNumber(node.left, constants, seen, environment);
    const right = resolvedNumber(node.right, constants, seen, environment);
    if (left === null || right === null || (node.operator === "/" && right === 0)) return null;
    return node.operator === "+" ? left + right : node.operator === "-" ? left - right : node.operator === "*" ? left * right : left / right;
  }
  if (node.type !== "Identifier" || seen.has(node.name)) return null;
  const target = environment.get(node.name) || constants.get(node.name);
  if (!target) return null;
  const next = new Set(seen);
  next.add(node.name);
  return resolvedNumber(target, constants, next, environment);
}

function collectFunctions(ast) {
  const functions = new Map();
  visit(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) functions.set(node.id.name, node.init);
  });
  return functions;
}

function returnedExpression(fn) {
  if (fn?.body?.type !== "BlockStatement") return fn?.body || null;
  let result = null;
  visit(fn.body, (node, ancestors) => {
    if (result || node.type !== "ReturnStatement" || !node.argument) return;
    const nested = ancestors.some((ancestor) => ancestor !== fn && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(ancestor.type));
    if (!nested) result = node.argument;
  });
  return result;
}

function callOutcome(node, source, constants, functions, environment = new Map(), seen = new Set()) {
  if (node?.type !== "CallExpression") return null;
  const calleeName = node.callee?.type === "Identifier" ? node.callee.name : "";
  if (calleeName && functions.has(calleeName) && !seen.has(calleeName)) {
    const fn = functions.get(calleeName);
    const nextEnvironment = new Map(environment);
    for (let index = 0; index < (fn.params || []).length; index += 1) {
      if (fn.params[index]?.type === "Identifier" && node.arguments[index]) {
        const argument = node.arguments[index];
        nextEnvironment.set(fn.params[index].name, argument.type === "Identifier" && environment.has(argument.name)
          ? environment.get(argument.name) : argument);
      }
    }
    const returned = returnedExpression(fn);
    return callOutcome(returned, source, constants, functions, nextEnvironment, new Set([...seen, calleeName]));
  }
  const isJsonResponse = node.callee?.type === "MemberExpression"
    && ["json"].includes(String(node.callee.property?.name || node.callee.property?.value || "").toLowerCase());
  if (!isJsonResponse) return null;
  const payload = node.arguments.find((argument) => argument.type === "ObjectExpression" && objectProperty(argument, "error"));
  const options = node.arguments.find((argument) => argument.type === "ObjectExpression" && objectProperty(argument, "status"));
  const statusNode = options ? objectProperty(options, "status")?.value : null;
  return {
    status: resolvedNumber(statusNode, constants, new Set(), environment),
    errorText: literalText(payload ? objectProperty(payload, "error")?.value : null, source, constants, environment),
  };
}

function resolveCallable(moduleInfo, name) {
  if (moduleInfo.functions.has(name)) {
    return { moduleInfo, name, node: moduleInfo.functions.get(name) };
  }
  return moduleInfo.imports.get(name) || null;
}

function expandedHelperContext(node, moduleInfo, seen = new Set()) {
  if (!node) return "";
  const chunks = [nodeText(moduleInfo.source, node)];
  visit(node, (candidate) => {
    if (candidate.type !== "CallExpression" || candidate.callee?.type !== "Identifier") return;
    const target = resolveCallable(moduleInfo, candidate.callee.name);
    if (!target) return;
    const identity = `${target.moduleInfo.file}:${target.name}`;
    if (seen.has(identity)) return;
    chunks.push(expandedHelperContext(target.node, target.moduleInfo, new Set([...seen, identity])));
  });
  return chunks.join("\n");
}

function directHelperContext(node, moduleInfo) {
  const directText = nodeText(moduleInfo.source, node);
  const chunks = [directText];
  const parsesTransportReply = /(?:redisCmd|redisPipeline|\bfetch\s*\()/i.test(directText);
  function callableFormatRisk(target, depth = 0, seen = new Set()) {
    const identity = `${target.moduleInfo.file}:${target.name}`;
    if (seen.has(identity) || depth > 4) return { risk: false, recovery: false };
    const nextSeen = new Set([...seen, identity]);
    const targetText = nodeText(target.moduleInfo.source, target.node);
    if (formatRecovery.test(targetText)) return { risk: false, recovery: true };
    const returnsEmpty = /(?:return\s+(?:null|false)\b|catch\s*(?:\([^)]*\))?\s*\{[^}]*\bnull\b)/is.test(targetText);
    let risk = returnsEmpty && strongFormatCondition.test(targetText);
    let recovery = false;
    const returned = [];
    if (target.node.body?.type !== "BlockStatement") returned.push(target.node.body);
    else {
      visit(target.node.body, (candidate, parents) => {
        if (candidate.type !== "ReturnStatement" || !candidate.argument) return;
        const nestedFunction = parents.some((parent) => parent !== target.node.body
          && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type));
        if (!nestedFunction) returned.push(candidate.argument);
      });
    }
    const definitions = new Map();
    visit(target.node.body, (candidate, parents) => {
      if (candidate.type !== "VariableDeclarator" || candidate.id?.type !== "Identifier" || !candidate.init) return;
      const nestedFunction = parents.some((parent) => parent !== target.node.body
        && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type));
      if (!nestedFunction) definitions.set(candidate.id.name, candidate.init);
    });
    for (const expression of returned) {
      const values = expression.type === "Identifier" && definitions.has(expression.name)
        ? [expression, definitions.get(expression.name)]
        : [expression];
      for (const value of values) {
        visit(value, (candidate) => {
          if (recovery || candidate.type !== "CallExpression" || candidate.callee?.type !== "Identifier") return;
          const nested = resolveCallable(target.moduleInfo, candidate.callee.name);
          if (!nested) return;
          const outcome = callableFormatRisk(nested, depth + 1, nextSeen);
          risk ||= outcome.risk;
          recovery ||= outcome.recovery;
        });
      }
    }
    return { risk: risk && !recovery, recovery };
  }
  visit(node, (candidate) => {
    if (candidate.type !== "CallExpression" || candidate.callee?.type !== "Identifier") return;
    const target = resolveCallable(moduleInfo, candidate.callee.name);
    if (!target) return;
    const outcome = callableFormatRisk(target);
    if (outcome.recovery) chunks.push("automatic_repair");
    else if (outcome.risk && !parsesTransportReply) chunks.push("JSON.parse __format_null_risk__");
  });
  return chunks.join("\n");
}

function validationContext(ancestors, moduleInfo) {
  const conditional = [...ancestors].reverse().find((ancestor) => ancestor.type === "IfStatement" || ancestor.type === "ConditionalExpression");
  if (conditional) {
    const chunks = [expandedHelperContext(conditional.test, moduleInfo)];
    const identifiers = new Set();
    visit(conditional.test, (candidate, parents) => {
      if (candidate.type !== "Identifier") return;
      const parent = parents.at(-1);
      if (parent?.type === "MemberExpression" && parent.property === candidate && !parent.computed) return;
      if (parent?.type === "ObjectProperty" && parent.key === candidate && !parent.computed) return;
      identifiers.add(candidate.name);
    });
    const owner = [...ancestors].reverse().find((ancestor) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(ancestor.type));
    const latest = new Map();
    if (owner?.body && identifiers.size) {
      visit(owner.body, (candidate) => {
        if (Number(candidate.start) >= Number(conditional.start)) return;
        if (candidate.type === "VariableDeclarator" && candidate.id?.type === "Identifier"
            && identifiers.has(candidate.id.name) && candidate.init) {
          const previous = latest.get(candidate.id.name);
          if (!previous || Number(candidate.start) > Number(previous.start)) latest.set(candidate.id.name, candidate.init);
        }
        if (candidate.type === "AssignmentExpression" && candidate.left?.type === "Identifier"
            && identifiers.has(candidate.left.name) && candidate.right) {
          const previous = latest.get(candidate.left.name);
          if (!previous || Number(candidate.start) > Number(previous.start)) latest.set(candidate.left.name, candidate.right);
        }
      });
    }
    for (const definition of latest.values()) chunks.push(directHelperContext(definition, moduleInfo));
    return chunks.join("\n");
  }
  const guardedTry = [...ancestors].reverse().find((ancestor) => ancestor.type === "TryStatement"
    && ancestor.handler && ancestors.includes(ancestor.handler));
  return guardedTry ? expandedHelperContext(guardedTry.block, moduleInfo) : "";
}

function addFinding(file, node, status, errorText, conditionText) {
  const explicitFormatFailure = formatError.test(errorText);
  const nullRisk = conditionText.includes("__format_null_risk__");
  const validationBranch = formatCondition.test(conditionText)
    && (!trueOutage.test(conditionText) || nullRisk)
    && !formatRecovery.test(conditionText);
  const genericStorageError = /^(?:storage|store)_unavailable$/i.test(String(errorText || "").trim());
  if (!explicitFormatFailure && trueOutage.test(errorText) && (!genericStorageError || !nullRisk)) return;
  if (!explicitFormatFailure && !validationBranch) return;
  findings.push(finding(
    root,
    file,
    node,
    "data-validation-5xx",
    `HTTP ${status} 由数据格式/类型校验触发（${errorText || conditionText || "未知错误"}）；应自动修复、兼容、降级或返回 4xx，而不是拒绝服务`,
  ));
}

const apiFiles = await walkFiles(path.join(root, "app", "api"), (target) => /\.(?:js|mjs)$/.test(target));
const fileKey = (file) => path.normalize(path.resolve(file)).toLowerCase();
const apiFileLookup = new Map(apiFiles.map((file) => [fileKey(file), file]));

function resolveImportedFile(importer, specifier) {
  if (!String(specifier || "").startsWith(".")) return "";
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js"), path.join(base, "index.mjs")]) {
    const match = apiFileLookup.get(fileKey(candidate));
    if (match) return match;
  }
  return "";
}

for (const file of apiFiles) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push(finding(root, file, { loc: error.loc ? { start: error.loc } : undefined }, "fail-closed-parse", `无法解析 API 路由：${error.message}`));
    continue;
  }
  const constants = collectConstants(ast);
  const functions = collectFunctions(ast);
  const moduleInfo = { file, source, ast, constants, functions, imports: new Map() };
  for (const statement of ast.program?.body || []) {
    if (statement.type !== "ImportDeclaration") continue;
    const importedFile = resolveImportedFile(file, statement.source?.value);
    if (!importedFile) continue;
    try {
      const importedSource = await sourceFile(importedFile);
      const importedAst = parseModule(importedSource, importedFile);
      const importedInfo = {
        file: importedFile,
        source: importedSource,
        ast: importedAst,
        constants: collectConstants(importedAst),
        functions: collectFunctions(importedAst),
        imports: new Map(),
      };
      for (const specifier of statement.specifiers || []) {
        if (specifier.type !== "ImportSpecifier" || !specifier.local?.name) continue;
        const importedName = specifier.imported?.name || specifier.imported?.value || "";
        const importedNode = importedInfo.functions.get(importedName);
        if (importedNode) moduleInfo.imports.set(specifier.local.name, {
          moduleInfo: importedInfo,
          name: importedName,
          node: importedNode,
        });
      }
    } catch {
      // The main parse pass reports syntax errors. An unresolved helper cannot
      // safely contribute context, so leave it absent rather than guessing.
    }
  }
  visit(ast, (node, ancestors) => {
    if (node.type === "ObjectProperty" && String(node.key?.name || node.key?.value) === "status") {
      const status = resolvedNumber(node.value, constants);
      if (status === null || status < 500 || status > 599) return;
      addFinding(
        file,
        node,
        status,
        literalText(responseErrorNode(node, ancestors), source, constants),
        validationContext(ancestors, moduleInfo),
      );
      return;
    }
    if (node.type !== "CallExpression" || !ancestors.some((ancestor) => ancestor.type === "ReturnStatement")) return;
    const outcome = callOutcome(node, source, constants, functions);
    if (!outcome || outcome.status < 500 || outcome.status > 599) return;
    addFinding(file, node, outcome.status, outcome.errorText, validationContext(ancestors, moduleInfo));
  });
}

finish(findings);
