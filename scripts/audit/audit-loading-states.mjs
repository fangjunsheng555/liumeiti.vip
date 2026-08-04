import path from "node:path";
import {
  auditRoot, containsNode, finding, finish, functionName, isLiteralValue,
  nearestFunction, nodeText, objectProperty, parseModule, propertyName,
  sourceFile, visit, walkFiles,
} from "./_shared.mjs";

const root = auditRoot();
const findings = [];
const activityPattern = /(?:loading|busy|saving|submitting|deleting|retrieving|authorizing|checking|processing|uploading|sending)/i;

function activityStateName(name) {
  const value = String(name || "");
  return activityPattern.test(value)
    || /^(?:is)?pending$/i.test(value)
    || /(?:request|action|mutation|submit)Pending$/i.test(value);
}

function updaterPropertyValue(source, argument, names) {
  if (argument?.type !== "ArrowFunctionExpression" && argument?.type !== "FunctionExpression") return null;
  const values = [];
  visit(argument.body, (node) => {
    if (node.type !== "ObjectProperty" || !names.includes(String(propertyName(node)))) return;
    if (isLiteralValue(node.value, true) || isLiteralValue(node.value, false)
      || isLiteralValue(node.value, "") || isLiteralValue(node.value, null)) values.push(node.value.value ?? null);
  });
  if (values.some((value) => value === true || (typeof value === "string" && value.length > 0))) return true;
  if (values.length) return false;
  const text = nodeText(source, argument);
  const textual = [];
  for (const name of names) {
    const match = text.match(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(true|false|null|["']{2})`));
    if (match) textual.push(match[1] === "true" ? true : false);
  }
  if (textual.some(Boolean)) return true;
  if (textual.length) return false;
  return undefined;
}

function stateValue(source, argument, names) {
  if (!argument) return undefined;
  if (isLiteralValue(argument, true)) return true;
  if (isLiteralValue(argument, false) || isLiteralValue(argument, "") || isLiteralValue(argument, null)) return false;
  if (argument.type === "StringLiteral") return Boolean(argument.value);
  if (argument.type === "ObjectExpression") {
    const values = [];
    for (const name of names) {
      const property = objectProperty(argument, name);
      if (!property) continue;
      if (isLiteralValue(property.value, true)) values.push(true);
      if (isLiteralValue(property.value, false) || isLiteralValue(property.value, "") || isLiteralValue(property.value, null)) values.push(false);
    }
    if (values.some(Boolean)) return true;
    if (values.length) return false;
  }
  const updater = updaterPropertyValue(source, argument, names);
  if (updater !== undefined) return updater === true || (typeof updater === "string" && updater.length > 0);
  return undefined;
}

function isInsideFinally(call) {
  return call.ancestors.some((ancestor) => ancestor.type === "TryStatement" && containsNode(ancestor.finalizer, call.node))
    || call.ancestors.some((ancestor) => (
      ancestor.type === "CallExpression"
      && ancestor.callee?.type === "MemberExpression"
      && !ancestor.callee.computed
      && ancestor.callee.property?.name === "finally"
      && ancestor.arguments?.some((argument) => containsNode(argument, call.node))
    ));
}

function nodesInFunction(ast, fn, type) {
  const nodes = [];
  visit(fn || ast, (node, ancestors) => {
    if (node.type !== type) return;
    const owner = nearestFunction(ancestors);
    if ((fn && owner === fn) || (!fn && !owner)) nodes.push({ node, ancestors });
  });
  return nodes;
}

function hookWorkflow(ancestors) {
  for (let index = ancestors.length - 1; index >= 1; index -= 1) {
    const node = ancestors[index];
    const parent = ancestors[index - 1];
    if (!["FunctionExpression", "ArrowFunctionExpression"].includes(node?.type) || parent?.type !== "CallExpression") continue;
    if (/^use(?:Effect|LayoutEffect)$/.test(parent.callee?.name || "") && parent.arguments?.includes(node)) return node;
  }
  return null;
}

function promiseBranch(call, branch) {
  return call.ancestors.some((ancestor) => ancestor.type === "CallExpression"
    && ancestor.callee?.type === "MemberExpression"
    && (ancestor.callee.property?.name || ancestor.callee.property?.value) === branch
    && ancestor.arguments?.some((argument) => containsNode(argument, call.node)));
}

function containingCallback(call, branch) {
  for (let index = call.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = call.ancestors[index];
    if (!["FunctionExpression", "ArrowFunctionExpression"].includes(ancestor.type)) continue;
    const parent = call.ancestors[index - 1];
    if (parent?.type === "CallExpression" && parent.callee?.type === "MemberExpression"
      && (parent.callee.property?.name || parent.callee.property?.value) === branch
      && parent.arguments?.includes(ancestor)) return ancestor;
  }
  return null;
}

function conditionIsStable(test, container, call) {
  const identifiers = new Set();
  visit(test, (node) => { if (node.type === "Identifier") identifiers.add(node.name); });
  const parameterNames = new Set();
  for (const parameter of container?.params || []) {
    if (parameter.type === "Identifier") parameterNames.add(parameter.name);
  }
  if ([...identifiers].some((name) => parameterNames.has(name))) return false;
  const enclosingFunctions = call.ancestors.filter((ancestor) => (
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(ancestor.type)
  ));
  const owner = enclosingFunctions.length > 1
    ? enclosingFunctions[enclosingFunctions.length - 2]
    : enclosingFunctions.at(-1) || null;
  if (!owner) return true;
  let firstAwait = Infinity;
  visit(owner, (node, ancestors) => {
    if (node.type === "AwaitExpression" && nearestFunction(ancestors) === owner) firstAwait = Math.min(firstAwait, Number(node.start));
  });
  let successDerived = false;
  visit(owner, (node, ancestors) => {
    if (successDerived || Number(node.start) >= Number(call.node.start)) return;
    const assigned = node.type === "AssignmentExpression" && node.left?.type === "Identifier" ? node.left.name
      : node.type === "UpdateExpression" && node.argument?.type === "Identifier" ? node.argument.name : "";
    if (!assigned || !identifiers.has(assigned)) return;
    if (nearestFunction(ancestors) === owner && Number(node.start) > firstAwait) {
      successDerived = true;
      return;
    }
    for (let index = ancestors.length - 1; index >= 1; index -= 1) {
      const callback = ancestors[index];
      const parent = ancestors[index - 1];
      if (!["FunctionExpression", "ArrowFunctionExpression"].includes(callback?.type)
        || parent?.type !== "CallExpression" || !parent.arguments?.includes(callback)) continue;
      const branch = parent.callee?.type === "MemberExpression"
        ? String(parent.callee.property?.name || parent.callee.property?.value || "") : "";
      if (["then", "catch"].includes(branch)) successDerived = true;
      break;
    }
  });
  return !successDerived;
}

function unconditionalIn(container, call, { allowStableConditions = false } = {}) {
  if (!container || !containsNode(container, call.node)) return false;
  for (const ancestor of call.ancestors) {
    if (!containsNode(container, ancestor) || !containsNode(ancestor, call.node) || ancestor === container) continue;
    if (["IfStatement", "ConditionalExpression"].includes(ancestor.type)) {
      if (!allowStableConditions || !conditionIsStable(ancestor.test, container, call)) return false;
    }
    if (["SwitchCase", "WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"].includes(ancestor.type)) return false;
    if (ancestor.type === "LogicalExpression" && containsNode(ancestor.right, call.node)) {
      if (!allowStableConditions || !conditionIsStable(ancestor.left, container, call)) return false;
    }
  }
  let escaped = false;
  visit(container.body || container, (node, ancestors) => {
    if (escaped || !["ReturnStatement", "ThrowStatement"].includes(node.type)) return;
    const owner = nearestFunction(ancestors);
    if (container.type === "BlockStatement" ? Boolean(owner) : owner !== container) return;
    if (Number(node.start) < Number(call.node.start)) escaped = true;
  });
  return !escaped;
}

function callbackEscapesCovered(container, finalClear, clears, { thrownFlowsToCatch = false } = {}) {
  if (!container) return false;
  let covered = true;
  visit(container.body || container, (node, ancestors) => {
    if (!covered || !["ReturnStatement", "ThrowStatement"].includes(node.type) || Number(node.start) >= Number(finalClear.node.start)) return;
    if (thrownFlowsToCatch && node.type === "ThrowStatement") return;
    const owner = nearestFunction(ancestors);
    if (owner && owner !== container) return;
    const guard = [...ancestors].reverse().find((ancestor) => ancestor.type === "IfStatement" && containsNode(ancestor, node));
    const priorClear = clears.some((candidate) => Number(candidate.node.start) < Number(node.start)
      && containsNode(container, candidate.node) && (!guard || containsNode(guard, candidate.node)));
    if (!priorClear) covered = false;
  });
  return covered;
}

function enclosingHandledTry(item, fn) {
  return [...item.ancestors].reverse().find((ancestor) => (
    ancestor.type === "TryStatement"
    && ancestor.handler
    && containsNode(ancestor.block, item.node)
    && (!fn || containsNode(fn, ancestor))
  ));
}

function branchHasClear(container, clears, after = 0) {
  return clears.some((call) => containsNode(container, call.node) && Number(call.node.start) > after);
}

function handledByTwoBranchCleanup(boundary, clears, returns, throws, fn) {
  const statement = enclosingHandledTry(boundary, fn);
  if (!statement) return false;
  const successClear = clears.find((call) => containsNode(statement.block, call.node)
    && (Number(call.node.start) > Number(boundary.node.end) || containsNode(boundary.node, call.node)));
  const catchClear = clears.find((call) => containsNode(statement.handler, call.node));
  if (!successClear || !catchClear) return false;
  const earlySuccessReturn = returns.some(({ node }) => containsNode(statement.block, node)
    && Number(node.start) > Number(boundary.node.start) && Number(node.start) < Number(successClear.node.start));
  const catchEscape = [...returns, ...throws].some(({ node }) => containsNode(statement.handler, node)
    && Number(node.start) < Number(catchClear.node.start));
  return !earlySuccessReturn && !catchEscape;
}

function handledByTrailingCleanup(boundary, clears, returns, throws, fn) {
  const statement = enclosingHandledTry(boundary, fn);
  if (!statement) return false;
  const clear = clears.find((call) => Number(call.node.start) > Number(statement.end)
    && (!fn || containsNode(fn, call.node)));
  if (!clear) return false;
  const escapes = [...returns, ...throws].some(({ node }) => {
    if (Number(node.start) <= Number(boundary.node.start) || Number(node.start) >= Number(clear.node.start)) return false;
    if (node.type === "ThrowStatement" && containsNode(statement.block, node)) return false;
    const container = containsNode(statement.block, node) ? statement.block : containsNode(statement.handler, node) ? statement.handler : null;
    if (!container) return false;
    return !clears.some((candidate) => containsNode(container, candidate.node)
      && Number(candidate.node.start) > Number(boundary.node.start) && Number(candidate.node.start) < Number(node.start));
  });
  return !escapes;
}

function calleeName(call) {
  if (call.node.callee?.type === "Identifier") return call.node.callee.name;
  if (call.node.callee?.type === "MemberExpression") return call.node.callee.property?.name || call.node.callee.property?.value || "";
  return "";
}

function signalHasRealDeadline(signal, call, source) {
  if (!signal) return false;
  const signalText = nodeText(source, signal);
  if (/\bAbortSignal\s*\.\s*timeout\s*\(/.test(signalText)) return true;
  if (signal.type === "Identifier") {
    const escaped = signal.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*AbortSignal\\s*\\.\\s*timeout\\s*\\(`).test(source)) return true;
  }
  const controller = signalText.match(/^\s*([A-Za-z_$][\w$]*)\s*\.\s*signal\s*$/)?.[1];
  if (!controller) return false;
  const escaped = controller.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const owner = nearestFunction(call.ancestors);
  const scope = owner ? nodeText(source, owner) : source;
  return new RegExp(`\\bsetTimeout\\s*\\([\\s\\S]{0,240}?\\b${escaped}\\s*\\.\\s*abort\\s*\\(`).test(scope)
    || new RegExp(`\\bsetTimeout\\s*\\(\\s*${escaped}\\s*\\.\\s*abort\\s*\\.\\s*bind\\s*\\(`).test(scope);
}

function finiteNetworkCall(call, timedFetchNames, source) {
  const name = calleeName(call);
  if (timedFetchNames.has(name)) return true;
  const options = call.node.arguments?.[1];
  const signal = options?.type === "ObjectExpression" ? objectProperty(options, "signal")?.value : null;
  if (signalHasRealDeadline(signal, call, source)) return true;
  if (call.ancestors.some((ancestor) => ancestor.type === "CallExpression"
    && /race/i.test(nodeText(source, ancestor.callee))
    && /(?:AbortSignal\s*\.\s*timeout|setTimeout\s*\()/.test(nodeText(source, ancestor)))) return true;
  return false;
}

function priorEscapeInFunction(call, { ignoreThrows = false } = {}) {
  const owner = call.fn || nearestFunction(call.ancestors);
  if (!owner) return false;
  let escaped = false;
  visit(owner, (node, ancestors) => {
    const isEscape = node.type === "ReturnStatement" || (!ignoreThrows && node.type === "ThrowStatement");
    if (escaped || !isEscape) return;
    if (nearestFunction(ancestors) !== owner) return;
    if (Number(node.start) < Number(call.node.start)) escaped = true;
  });
  return escaped;
}

function finallyProtectsActivations(clear, activations, returns, throws) {
  const statement = [...clear.ancestors].reverse().find((ancestor) => (
    ancestor.type === "TryStatement" && containsNode(ancestor.finalizer, clear.node)
  ));
  if (!statement) return false;
  if (!unconditionalIn(statement.finalizer, clear, { allowStableConditions: true })) return false;
  return activations.every((activation) => {
    if (containsNode(statement.block, activation.node)) return true;
    if (Number(activation.node.end) > Number(statement.start)) return false;
    return ![...returns, ...throws].some(({ node }) => (
      Number(node.start) > Number(activation.node.end) && Number(node.start) < Number(statement.start)
    ));
  });
}

for (const file of await walkFiles(path.join(root, "app"), (target) => target.endsWith(".jsx"))) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push(finding(root, file, { loc: error.loc ? { start: error.loc } : undefined }, "loading-parse", `无法解析 JSX：${error.message}`));
    continue;
  }

  const timedFetchNames = new Set();
  const setters = new Map();
  const calls = [];
  const namedFunctions = new Map();
  const functionNames = new Map();
  for (const statement of ast.program?.body || []) {
    if (statement.type !== "ImportDeclaration" || !String(statement.source?.value || "").startsWith(".")) continue;
    const base = path.resolve(path.dirname(file), String(statement.source.value));
    let importedSource = "";
    for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, "index.js")]) {
      try { importedSource = await sourceFile(candidate); break; } catch {}
    }
    for (const specifier of statement.specifiers || []) {
      const imported = specifier.imported?.name || specifier.local?.name || "";
      if (!specifier.local?.name || !imported) continue;
      const escaped = imported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const definition = importedSource.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b[\\s\\S]{0,1800}`))?.[0] || "";
      if (/\bfetch\s*\(/.test(definition) && /\bsetTimeout\s*\(/.test(definition) && /\.\s*abort\s*\(/.test(definition)) {
        timedFetchNames.add(specifier.local.name);
      }
    }
  }
  visit(ast, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "ArrayPattern"
      && node.init?.type === "CallExpression" && node.init.callee?.name === "useState") {
      const stateName = node.id.elements?.[0]?.name || "";
      const setterName = node.id.elements?.[1]?.name || "";
      const initial = node.init.arguments?.[0];
      const names = activityStateName(stateName) ? [stateName] : [];
      if (initial?.type === "ObjectExpression") {
        for (const property of initial.properties || []) {
          const name = String(propertyName(property));
          if (activityStateName(name)) names.push(name);
        }
      }
      if (setterName && names.length) setters.set(setterName, { declaration: node, initial, names: [...new Set(names)] });
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && setters.has(node.callee.name)) {
      const fn = nearestFunction(ancestors);
      calls.push({ node, ancestors, fn, workflow: hookWorkflow(ancestors) || fn, setter: node.callee.name, argument: node.arguments?.[0] });
    }
    if (node.type === "FunctionDeclaration" && node.id?.name) namedFunctions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      if (["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)) namedFunctions.set(node.id.name, node.init);
      if (node.init?.type === "CallExpression" && /^use(?:Callback|Memo)$/.test(node.init.callee?.name || "")
        && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init.arguments?.[0]?.type)) namedFunctions.set(node.id.name, node.init.arguments[0]);
    }
  });
  for (const [name, fn] of namedFunctions) functionNames.set(fn, name);
  for (const [name, fn] of namedFunctions) {
    const text = nodeText(source, fn);
    if (/fetch/i.test(name) && /\b(?:window\s*\.\s*)?setTimeout\s*\(/.test(text)
      && /\.\s*abort\s*\(/.test(text) && /\bfetch\s*\(/.test(text) && /\bsignal\b/.test(text)) timedFetchNames.add(name);
  }

  const reachableFunctions = (start) => {
    const reached = new Set(start ? [start] : []);
    const queue = start ? [start] : [];
    while (queue.length) {
      const current = queue.shift();
      visit(current.body || current, (node) => {
        if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return;
        const target = namedFunctions.get(node.callee.name);
        if (target && !reached.has(target)) { reached.add(target); queue.push(target); }
      });
    }
    return reached;
  };

  for (const [setter, meta] of setters) {
    const related = calls.filter((call) => call.setter === setter);
    const active = related.filter((call) => stateValue(source, call.argument, meta.names) === true);
    const clear = related.filter((call) => stateValue(source, call.argument, meta.names) === false);
    const initiallyActive = stateValue(source, meta.initial, meta.names) === true;
    const groups = new Map();
    for (const call of active) {
      if (!groups.has(call.workflow)) groups.set(call.workflow, []);
      groups.get(call.workflow).push(call);
    }
    if (initiallyActive) {
      const candidateFunctions = [...new Set(clear.map((call) => call.workflow).filter(Boolean))];
      if (!candidateFunctions.length) groups.set(null, [{ node: meta.declaration, ancestors: [], fn: null }]);
      for (const fn of candidateFunctions) {
        if (!groups.has(fn)) groups.set(fn, [{ node: meta.declaration, ancestors: [], fn }]);
      }
    }

    for (const [fn, activations] of groups) {
      const reachable = reachableFunctions(fn);
      const fnClears = clear.filter((call) => (fn && containsNode(fn, call.node)) || reachable.has(call.fn));
      if (!fnClears.length) {
        findings.push(finding(root, file, activations[0].node, "loading-exit", `${setter} 在 ${functionName(fn, source)} 中进入加载态，但函数内没有退出加载态`));
        continue;
      }
      const activationStart = Math.min(...activations.map((item) => Number(item.node.end || 0)));
      const awaits = nodesInFunction(ast, fn, "AwaitExpression").filter(({ node }) => Number(node.start) > activationStart);
      const returns = nodesInFunction(ast, fn, "ReturnStatement");
      const throws = nodesInFunction(ast, fn, "ThrowStatement");
      const finallyCleanup = fnClears.some((call) => (
        finallyProtectsActivations(call, activations, returns, throws)
        || (promiseBranch(call, "finally") && unconditionalIn(containingCallback(call, "finally"), call, { allowStableConditions: true }) && !priorEscapeInFunction(call))
        || (() => {
          const helperName = functionNames.get(call.fn);
          if (!helperName || !unconditionalIn(call.fn, call) || !fn) return false;
          let protectedCall = false;
          visit(fn, (node, ancestors) => {
            if (protectedCall || node.type !== "CallExpression" || node.callee?.type !== "Identifier" || node.callee.name !== helperName) return;
            const proxy = { node, ancestors, fn };
            if (finallyProtectsActivations(proxy, activations, returns, throws)) protectedCall = true;
          });
          return protectedCall;
        })()
      ));
      const thenClear = fnClears.find((call) => promiseBranch(call, "then")
        && unconditionalIn(containingCallback(call, "then"), call, { allowStableConditions: true })
        && callbackEscapesCovered(containingCallback(call, "then"), call, fnClears, { thrownFlowsToCatch: true }));
      const catchClear = fnClears.find((call) => promiseBranch(call, "catch")
        && unconditionalIn(containingCallback(call, "catch"), call, { allowStableConditions: true })
        && callbackEscapesCovered(containingCallback(call, "catch"), call, fnClears));
      let cleanupProven = finallyCleanup || Boolean(thenClear && catchClear);
      if (!cleanupProven && fn) {
        const activationEnd = Math.max(...activations.map((item) => Number(item.node.end || 0)));
        const rootTail = source.slice(activationEnd, Number(fn.end || activationEnd));
        const clearHelpers = [...namedFunctions.entries()].filter(([, target]) => fnClears.some((call) => call.fn === target));
        cleanupProven = clearHelpers.some(([helperName]) => [...namedFunctions.entries()].some(([driverName, driver]) => {
          if (!reachable.has(driver) || driver === fn || !new RegExp(`\\b${driverName}\\s*\\(`).test(rootTail)) return false;
          const driverText = nodeText(source, driver);
          const calls = driverText.match(new RegExp(`\\b${helperName}\\s*\\(`, "g")) || [];
          return calls.length >= 2 && /\bcatch\b/.test(driverText);
        }));
      }

      const networkCalls = [];
      const networkRoots = fn ? reachable : new Set([ast]);
      for (const networkRoot of networkRoots) {
        visit(networkRoot, (node, ancestors) => {
          if (node.type !== "CallExpression") return;
          const owner = nearestFunction(ancestors);
          if (networkRoot !== ast && owner && owner !== networkRoot) return;
          if (networkRoot === ast && owner) return;
          if (/fetch/i.test(calleeName({ node }))) networkCalls.push({ node, ancestors });
        });
      }

      const incompletePromiseCleanup = !cleanupProven && fnClears.some((call) => (
        promiseBranch(call, "then") || promiseBranch(call, "catch") || promiseBranch(call, "finally")
      ));
      const unsafeBoundary = cleanupProven ? null : awaits.find((boundary) => !handledByTwoBranchCleanup(boundary, fnClears, returns, throws, fn)
        && !handledByTrailingCleanup(boundary, fnClears, returns, throws, fn));
      if (incompletePromiseCleanup || (!cleanupProven && unsafeBoundary)) {
        findings.push(finding(root, file, activations[0].node, "loading-exit", `${setter} 在 ${functionName(fn, source)} 中的异步失败路径没有 finally/完整双分支清理`));
      } else if (!cleanupProven && !awaits.length) {
        const activationEnd = Math.max(...activations.map((item) => Number(item.node.end || 0)));
        const firstClear = fnClears.find((item) => Number(item.node.start) > activationEnd);
        const earlyReturn = returns.some(({ node }) => Number(node.start) > activationEnd && (!firstClear || Number(node.start) < Number(firstClear.node.start)));
        if (!firstClear || earlyReturn) {
          findings.push(finding(root, file, activations[0].node, "loading-exit", `${setter} 在 ${functionName(fn, source)} 中存在清理前返回路径`));
        }
      }

      const unbounded = networkCalls.find((call) => !finiteNetworkCall(call, timedFetchNames, source));
      if (unbounded) {
        findings.push(finding(root, file, unbounded.node, "loading-timeout", `${setter} 激活期间使用无超时/AbortSignal 的 ${calleeName(unbounded)}，网络悬挂会永久加载`));
      }
    }
  }
}

finish(findings);
