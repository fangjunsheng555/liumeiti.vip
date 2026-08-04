import path from "node:path";
import {
  auditRoot, finding, finish, nodeText, objectProperty, parseModule, propertyName,
  relative, sourceFile, visit, walkFiles,
} from "./_shared.mjs";

const root = auditRoot();
const findings = [];

function routePath(file) {
  return relative(root, file)
    .replace(/^app\/api/, "/api")
    .replace(/\/route\.(?:js|mjs|cjs)$/, "")
    .replace(/\/\[([^/]+)\]/g, "/:$1");
}

function routeHandlerDefinitions(ast) {
  const definitions = new Map();
  for (const statement of ast.program?.body || []) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      definitions.set(declaration.id.name, declaration);
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations || []) {
        if (item.id?.type === "Identifier" && item.init) definitions.set(item.id.name, item.init);
      }
    }
  }
  return definitions;
}

function resolveRouteHandler(node, definitions, seen = new Set()) {
  const value = unwrap(node);
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(value?.type)) return value;
  if (value?.type === "Identifier") {
    if (seen.has(value.name) || !definitions.has(value.name)) return null;
    return resolveRouteHandler(definitions.get(value.name), definitions, new Set([...seen, value.name]));
  }
  if (value?.type !== "CallExpression") return null;
  const wrapperName = value.callee?.type === "Identifier"
    ? value.callee.name
    : value.callee?.type === "MemberExpression" ? String(value.callee.property?.name || value.callee.property?.value || "") : "";
  if (wrapperName !== "withApiTelemetry") return null;
  for (const argument of [...(value.arguments || [])].reverse()) {
    const handler = resolveRouteHandler(argument, definitions, seen);
    if (handler) return handler;
  }
  return null;
}

function exportedHandlers(ast) {
  const handlers = [];
  const definitions = routeHandlerDefinitions(ast);
  for (const statement of ast.program?.body || []) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(declaration.id?.name || "")) {
      handlers.push({ method: declaration.id.name, node: declaration });
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations || []) {
        if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(item.id?.name || "")) continue;
        const node = resolveRouteHandler(item.init, definitions);
        if (node) handlers.push({ method: item.id.name, node });
      }
    }
  }
  return handlers;
}

function unwrap(node) {
  let current = node;
  while (["AwaitExpression", "TSAsExpression", "ParenthesizedExpression", "ChainExpression"].includes(current?.type)) current = current.argument || current.expression;
  return current;
}

function memberField(node, bodyNames) {
  const value = unwrap(node);
  if (!value || !["MemberExpression", "OptionalMemberExpression"].includes(value.type)) return "";
  const object = unwrap(value.object);
  if (object?.type !== "Identifier" || !bodyNames.has(object.name)) return "";
  if (!value.computed && value.property?.type === "Identifier") return value.property.name;
  if (value.computed && value.property?.type === "StringLiteral") return value.property.value;
  return "";
}

function bodyContracts(handler, source) {
  const bodyNames = new Set();
  const variableFields = new Map();
  const fieldsInExpression = (expression) => {
    const fields = new Set();
    visit(expression, (node) => {
      const field = memberField(node, bodyNames);
      if (field) fields.add(field);
    });
    return [...fields];
  };
  visit(handler, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const initText = node.init ? nodeText(source, node.init) : "";
    if (node.id?.type === "Identifier" && /\brequest\.json\s*\(/.test(initText)) bodyNames.add(node.id.name);
  });
  visit(handler, (node) => {
    if (node.type !== "VariableDeclarator" || !node.init) return;
    if (node.id?.type === "ObjectPattern" && unwrap(node.init)?.type === "Identifier" && bodyNames.has(unwrap(node.init).name)) {
      for (const property of node.id.properties || []) {
        if (property.type !== "ObjectProperty") continue;
        const local = property.value?.name || property.value?.left?.name;
        if (local) variableFields.set(local, String(propertyName(property)));
      }
    }
    if (node.id?.type !== "Identifier") return;
    let field = memberField(node.init, bodyNames);
    if (!field) {
      const candidates = fieldsInExpression(node.init);
      if (candidates.length === 1) field = candidates[0];
    }
    if (field) variableFields.set(node.id.name, field);
  });

  const expressionField = (node) => {
    const value = unwrap(node);
    if (value?.type === "Identifier") return variableFields.get(value.name) || "";
    const direct = memberField(value, bodyNames);
    if (direct) return direct;
    if (["CallExpression", "OptionalCallExpression"].includes(value?.type)) {
      const fields = value.arguments.map(expressionField).filter(Boolean);
      if (fields.length === 1) return fields[0];
      const nested = fieldsInExpression(value.callee);
      if (nested.length === 1) return nested[0];
    }
    return "";
  };
  const requiredFromTest = (test) => {
    const value = unwrap(test);
    if (!value) return [];
    if (value.type === "LogicalExpression") {
      if (value.operator !== "||") return [];
      return [...requiredFromTest(value.left), ...requiredFromTest(value.right)];
    }
    if (value.type === "UnaryExpression" && value.operator === "!") {
      const field = expressionField(value.argument);
      return field ? [field] : [];
    }
    if (value.type === "BinaryExpression") {
      const left = expressionField(value.left);
      const right = expressionField(value.right);
      if (["==", "===", "!=", "!=="].includes(value.operator)) return [left, right].filter(Boolean);
    }
    return [];
  };

  const required = new Set();
  let unverifiable = false;
  visit(handler, (node) => {
    if (node.type !== "IfStatement") return;
    const consequence = nodeText(source, node.consequent);
    if (!/\breturn\b/.test(consequence) || !/(?:status\s*:\s*4\d\d|NextResponse|Response\.json)/.test(consequence)) return;
    for (const field of requiredFromTest(node.test)) required.add(field);
  });
  visit(handler, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee?.type === "Identifier"
      ? node.callee.name
      : node.callee?.type === "MemberExpression" ? String(node.callee.property?.name || node.callee.property?.value || "") : "";
    if (!/(?:require|validate|assert|parse|schema)/i.test(callee)) return;
    const receivesBody = node.arguments.some((argument) => unwrap(argument)?.type === "Identifier" && bodyNames.has(unwrap(argument).name));
    if (!receivesBody) return;
    const fields = node.arguments.flatMap((argument) => (
      argument.type === "ArrayExpression"
        ? argument.elements.filter((item) => item?.type === "StringLiteral").map((item) => item.value)
        : []
    ));
    if (fields.length) for (const field of fields) required.add(field);
    else unverifiable = true;
  });
  return { required, unverifiable };
}

const routeContracts = [];
for (const file of await walkFiles(path.join(root, "app", "api"), (target) => /route\.(?:js|mjs|cjs)$/.test(target))) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push(finding(root, file, { loc: error.loc ? { start: error.loc } : undefined }, "contract-route-parse", `无法解析 API 路由：${error.message}`));
    continue;
  }
  for (const handler of exportedHandlers(ast)) {
    let requiresIdempotency = false;
    visit(handler.node, (node) => {
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "requiredIdempotencyKey") requiresIdempotency = true;
    });
    if (!requiresIdempotency) continue;
    const body = bodyContracts(handler.node, source);
    routeContracts.push({
      file,
      method: handler.method,
      path: routePath(file),
      requiredFields: body.required,
      unverifiableBodyContract: body.unverifiable,
    });
    if (body.unverifiable) findings.push(finding(root, file, handler.node, "unverifiable-route-contract", `${handler.method} ${routePath(file)} 通过动态校验 helper 检查请求体，审计器无法证明完整必填字段契约`));
  }
}

function routeRegex(route) {
  return new RegExp(`^${route.split("/").map((part) => (
    part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  )).join("/")}/?$`);
}

function routeCouldMatch(route, shapedUrl) {
  const expected = route.split("/");
  const actual = shapedUrl.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => part.startsWith(":") || actual[index] === ":param" || part === actual[index]);
}

function urlShape(node, source) {
  const value = unwrap(node);
  if (value?.type === "StringLiteral") return value.value;
  if (value?.type === "TemplateLiteral") {
    let result = "";
    for (let index = 0; index < value.quasis.length; index += 1) {
      result += value.quasis[index].value?.cooked || "";
      if (index < value.expressions.length) result += ":param";
    }
    return result;
  }
  if (value?.type === "BinaryExpression" && value.operator === "+") {
    const left = urlShape(value.left, source);
    const right = urlShape(value.right, source);
    if (!left && value.left?.type !== "StringLiteral") return "";
    return `${left}${right || ":param"}`;
  }
  if (value?.type === "CallExpression" && value.callee?.name === "encodeURIComponent") return ":param";
  return "";
}

function declarations(ast) {
  const values = new Map();
  const duplicates = new Set();
  visit(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || !node.init) return;
    if (values.has(node.id.name)) duplicates.add(node.id.name);
    else values.set(node.id.name, node.init);
  });
  for (const name of duplicates) values.delete(name);
  return values;
}

function functionDefinitions(ast) {
  const functions = new Map();
  visit(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)) functions.set(node.id.name, node.init);
  });
  return functions;
}

function identifierDomains(ast) {
  const domains = new Map();
  const add = (name, value) => {
    if (!name || typeof value !== "string") return;
    if (!domains.has(name)) domains.set(name, new Set());
    domains.get(name).add(value);
  };
  visit(ast, (node) => {
    if (node.type === "BinaryExpression" && ["==", "===", "!=", "!=="].includes(node.operator)) {
      if (node.left?.type === "Identifier" && node.right?.type === "StringLiteral") add(node.left.name, node.right.value);
      if (node.right?.type === "Identifier" && node.left?.type === "StringLiteral") add(node.right.name, node.left.value);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "StringLiteral") add(node.id.name, node.init.value);
    if (node.type === "VariableDeclarator" && node.id?.type === "ArrayPattern" && node.init?.type === "CallExpression"
      && node.init.callee?.name === "useState" && node.init.arguments?.[0]?.type === "StringLiteral") add(node.id.elements?.[0]?.name, node.init.arguments[0].value);
  });
  return domains;
}

function resolve(node, values, seen = new Set()) {
  const value = unwrap(node);
  if (value?.type !== "Identifier" || !values.has(value.name) || seen.has(value.name)) return value;
  const next = new Set(seen);
  next.add(value.name);
  return resolve(values.get(value.name), values, next);
}

function concreteTemplateUrls(node, values, domains) {
  const value = resolve(node, values);
  if (value?.type !== "TemplateLiteral") return [];
  let results = [""];
  for (let index = 0; index < value.quasis.length; index += 1) {
    results = results.map((prefix) => prefix + (value.quasis[index].value?.cooked || ""));
    if (index >= value.expressions.length) continue;
    const expression = resolve(value.expressions[index], values);
    const choices = expression?.type === "StringLiteral"
      ? [expression.value]
      : expression?.type === "Identifier" ? [...(domains.get(expression.name) || [])] : [];
    if (!choices.length) return [];
    results = results.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  return results;
}

function staticApiLiterals(node) {
  const values = [];
  visit(node, (candidate) => {
    if (candidate.type === "StringLiteral" && /\/api\//i.test(candidate.value)) values.push(candidate.value);
    if (candidate.type === "TemplateLiteral" && candidate.expressions.length === 0) {
      const value = candidate.quasis.map((part) => part.value?.cooked || "").join("");
      if (/\/api\//i.test(value)) values.push(value);
    }
  });
  return values;
}

function localApiPath(value) {
  return String(value || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
}

function staticPropertyName(property, values) {
  if (!property?.computed) return String(propertyName(property));
  const key = resolve(property.key, values);
  return key?.type === "StringLiteral" || key?.type === "NumericLiteral" ? String(key.value) : "";
}

function memberMutation(node, values) {
  const collectionCall = node?.type === "CallExpression"
    && ["MemberExpression", "OptionalMemberExpression"].includes(node.callee?.type)
    && ["set", "append", "delete"].includes(String(node.callee.property?.name || node.callee.property?.value || ""));
  if (collectionCall && node.callee.object?.type === "Identifier") {
    const property = resolve(node.arguments?.[0], values);
    const key = ["StringLiteral", "NumericLiteral"].includes(property?.type) ? String(property.value) : "";
    if (key) {
      return {
        object: node.callee.object.name,
        key,
        deleted: String(node.callee.property?.name || node.callee.property?.value || "") === "delete",
      };
    }
  }
  const member = node?.type === "AssignmentExpression" ? node.left
    : node?.type === "UnaryExpression" && node.operator === "delete" ? node.argument : null;
  if (!member || !["MemberExpression", "OptionalMemberExpression"].includes(member.type) || member.object?.type !== "Identifier") return null;
  const property = member.computed ? resolve(member.property, values) : member.property;
  const key = property?.type === "Identifier" ? property.name
    : ["StringLiteral", "NumericLiteral"].includes(property?.type) ? String(property.value) : "";
  return key ? { object: member.object.name, key, deleted: node.type === "UnaryExpression" } : null;
}

function objectKeys(node, values, ast = null, before = Infinity, seen = new Set()) {
  if (node?.type === "Identifier" && seen.has(node.name)) return new Set();
  const nextSeen = node?.type === "Identifier" ? new Set([...seen, node.name]) : seen;
  const value = resolve(node, values, seen);
  let keys;
  if (value?.type === "NewExpression" && value.callee?.type === "Identifier" && value.callee.name === "Headers") {
    keys = objectKeys(value.arguments?.[0], values, ast, Number(value.start || before), nextSeen) || new Set();
  } else if (value?.type === "ObjectExpression") {
    keys = new Set();
    for (const property of value.properties || []) {
      if (property.type === "ObjectProperty") {
        const key = staticPropertyName(property, values);
        if (key) keys.add(key);
      }
      if (property.type === "SpreadElement") {
        const nested = objectKeys(property.argument, values, ast, before, nextSeen);
        if (nested) for (const key of nested) keys.add(key);
      }
    }
  } else return null;
  const original = node?.type === "Identifier" ? node.name : null;
  if (ast && original) {
    const mutations = [];
    visit(ast, (candidate) => {
      if (Number(candidate.start) >= Number(before)) return;
      const mutation = memberMutation(candidate, values);
      if (mutation?.object === original) mutations.push({ ...mutation, start: Number(candidate.start) });
    });
    for (const mutation of mutations.sort((a, b) => a.start - b.start)) {
      if (mutation.deleted) keys.delete(mutation.key); else keys.add(mutation.key);
    }
  }
  return keys;
}

function optionValue(options, name, values, seen = new Set()) {
  if (options?.type === "Identifier" && seen.has(options.name)) return null;
  const nextSeen = options?.type === "Identifier" ? new Set([...seen, options.name]) : seen;
  const value = resolve(options, values);
  if (value?.type !== "ObjectExpression") return null;
  let result = null;
  for (const property of value.properties || []) {
    if (property.type === "SpreadElement") {
      const nested = optionValue(property.argument, name, values, nextSeen);
      if (nested) result = nested;
    } else if (property.type === "ObjectProperty" && staticPropertyName(property, values) === name) result = property.value;
  }
  return result;
}

function requestBodyKeys(options, values, ast, before) {
  const body = resolve(optionValue(options, "body", values), values);
  if (!body) return null;
  if (body.type === "CallExpression" && body.callee?.type === "MemberExpression"
    && body.callee.object?.name === "JSON" && body.callee.property?.name === "stringify") {
    return objectKeys(body.arguments?.[0], values, ast, before);
  }
  return null;
}

const clientRoots = new Set(["app", "scripts", "worker", "workers", "cloudflare", "functions", "lib"]);
const clientFiles = await walkFiles(root, (target) => {
  if (!/\.(?:js|jsx|mjs|cjs)$/.test(target)) return false;
  return clientRoots.has(relative(root, target).split("/")[0]);
});
for (const file of clientFiles) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push(finding(root, file, { loc: error.loc ? { start: error.loc } : undefined }, "contract-client-parse", `无法解析调用方：${error.message}`));
    continue;
  }
  const values = declarations(ast);
  const functions = functionDefinitions(ast);
  const domains = identifierDomains(ast);
  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const resolvedCallee = resolve(node.callee, values);
    const callee = resolvedCallee?.type === "Identifier"
      ? resolvedCallee.name
      : node.callee?.type === "Identifier"
      ? node.callee.name
      : node.callee?.type === "MemberExpression" ? String(node.callee.property?.name || node.callee.property?.value || "") : "";
    if (!/fetch/i.test(callee)) return;
    const options = node.arguments?.[1];
    const methodNode = resolve(optionValue(options, "method", values), values);
    const method = String(methodNode?.value || "GET").toUpperCase();
    const resolvedUrl = resolve(node.arguments?.[0], values);
    const concreteUrls = concreteTemplateUrls(resolvedUrl, values, domains);
    const concreteContracts = [...new Set(concreteUrls.flatMap((candidate) => (
      routeContracts.filter((item) => item.method === method && routeRegex(item.path).test(localApiPath(candidate)))
    )))];
    if (concreteUrls.length && concreteContracts.length === 0) return;
    if (concreteContracts.length > 1) {
      findings.push(finding(root, file, node, "unverifiable-fetch-contract", `${method} 动态 URL 可解析为多个受保护路由，无法确定单一请求契约`));
      return;
    }
    const shapedUrl = urlShape(resolvedUrl, source);
    if (!shapedUrl) {
      const helper = resolvedUrl?.type === "CallExpression" && resolvedUrl.callee?.type === "Identifier"
        ? functions.get(resolvedUrl.callee.name) : null;
      const literals = [...staticApiLiterals(resolvedUrl), ...(helper ? staticApiLiterals(helper) : [])];
      const mayCallProtected = literals.some((candidate) => routeContracts.some((item) => (
        item.method === method && routeRegex(item.path).test(localApiPath(candidate))
      )));
      if (mayCallProtected || !literals.length && /\/[Aa][Pp][Ii]\//.test(nodeText(source, resolvedUrl))) {
        findings.push(finding(root, file, node, "unverifiable-fetch-url", `${callee} 的 URL 含本地 API 证据但不是可静态解析的字符串，无法确认是否调用受幂等键保护的 API`));
      }
      return;
    }
    const url = shapedUrl.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (!url.startsWith("/api/")) return;
    let contract = concreteContracts[0] || routeContracts.find((item) => item.method === method && routeRegex(item.path).test(url));
    if (!contract) {
      const candidates = url.includes(":param")
        ? routeContracts.filter((item) => item.method === method && routeCouldMatch(item.path, url))
        : [];
      if (candidates.length === 1) [contract] = candidates;
      else {
        if (candidates.length > 1) findings.push(finding(root, file, node, "unverifiable-fetch-contract", `${method} ${url} 可匹配多个受保护路由，无法静态确定具体请求契约`));
        return;
      }
    }

    const headers = optionValue(options, "headers", values);
    const headerKeys = objectKeys(headers, values, ast, node.start);
    const hasIdempotencyKey = [...(headerKeys || [])].some((key) => key.toLowerCase() === "idempotency-key");
    if (headerKeys === null) {
      findings.push(finding(root, file, node, "unverifiable-request-headers", `${method} ${url} 的 headers 不是可静态解析的对象，无法证明已发送 Idempotency-Key`));
    } else if (!hasIdempotencyKey) {
      findings.push(finding(root, file, node, "missing-idempotency-key", `${method} ${url} 调用 ${contract.path}，但没有发送 Idempotency-Key`));
    }

    const bodyKeys = requestBodyKeys(options, values, ast, node.start);
    if (!bodyKeys) {
      if (contract.requiredFields.size) findings.push(finding(root, file, node, "unverifiable-request-body", `${method} ${url} 的请求体不是可静态解析的 JSON 对象，无法核对必填字段 ${[...contract.requiredFields].sort().join(", ")}`));
      return;
    }
    const missing = [...contract.requiredFields].filter((field) => !bodyKeys.has(field));
    if (missing.length) findings.push(finding(root, file, node, "missing-required-field", `${method} ${url} 缺少路由必填字段：${missing.sort().join(", ")}`));
  });
}

const inventory = path.join(root, "docs", "idempotency-integrations.md");
let inventorySource = "";
try { inventorySource = await sourceFile(inventory); } catch {}
for (const contract of routeContracts) {
  const documented = new RegExp(`\\b${contract.method}\\b[^\\n|]*${contract.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|\\s|\`|\\|)`).test(inventorySource);
  if (!documented) {
    findings.push({
      file: relative(root, contract.file),
      line: 1,
      column: 1,
      code: "undocumented-idempotent-route",
      message: `${contract.method} ${contract.path} 未记录在 docs/idempotency-integrations.md`,
    });
  }
}

finish(findings);
