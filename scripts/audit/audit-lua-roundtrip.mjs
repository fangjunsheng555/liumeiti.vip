import {
  auditRoot, finish, parseModule, relative, sourceFile, visit, walkFiles,
} from "./_shared.mjs";

const root = auditRoot();
const findings = [];

function lineNumber(source, offset) {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingClose(text, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchingArgument(text, openIndex) {
  const close = matchingClose(text, openIndex);
  return close < 0 ? "" : text.slice(openIndex + 1, close);
}

function luaCodeMask(lua) {
  const output = [...lua];
  let quote = "";
  let longClose = "";
  let escaped = false;
  for (let index = 0; index < lua.length; index += 1) {
    const char = lua[index];
    if (longClose) {
      if (lua.startsWith(longClose, index)) {
        for (let offset = 0; offset < longClose.length; offset += 1) output[index + offset] = " ";
        index += longClose.length - 1;
        longClose = "";
      } else if (char !== "\r" && char !== "\n") output[index] = " ";
      continue;
    }
    if (quote) {
      if (char !== "\r" && char !== "\n") output[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      output[index] = " ";
      quote = char;
      continue;
    }
    const long = lua.slice(index).match(/^\[(=*)\[/);
    if (long) {
      longClose = `]${long[1]}]`;
      for (let offset = 0; offset < long[0].length; offset += 1) output[index + offset] = " ";
      index += long[0].length - 1;
      continue;
    }
    if (lua.startsWith("--", index)) {
      const block = lua.slice(index + 2).match(/^\[(=*)\[/);
      if (block) {
        longClose = `]${block[1]}]`;
        const length = 2 + block[0].length;
        for (let offset = 0; offset < length; offset += 1) output[index + offset] = " ";
        index += length - 1;
      } else {
        while (index < lua.length && lua[index] !== "\r" && lua[index] !== "\n") {
          output[index] = " ";
          index += 1;
        }
        index -= 1;
      }
    }
  }
  return output.join("");
}

function maskRanges(source, ranges) {
  const output = [...source];
  for (const { start, end } of ranges) {
    for (let index = Math.max(0, start); index < Math.min(source.length, end); index += 1) {
      if (output[index] !== "\r" && output[index] !== "\n") output[index] = " ";
    }
  }
  return output.join("");
}

function isFixedScalarTable(argument) {
  const trimmed = argument.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const withoutStrings = trimmed.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  const withoutPairs = withoutStrings
    .replace(/\b[A-Za-z_]\w*\s*=\s*(?:true|false|nil|-?\d+(?:\.\d+)?|''|"")/g, "")
    .replace(/(?:true|false|nil|-?\d+(?:\.\d+)?|''|"")/g, "")
    .replace(/[{},;\s]/g, "");
  return withoutPairs === "";
}

function luaScalarConstants(lua) {
  const constants = new Map();
  for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*['"]([^'"]+)['"]\s*(?=;|\n|$)/g)) constants.set(match[1], match[2]);
  return constants;
}

function directRedisWriteArguments(lua) {
  const argumentsList = [];
  const callAliases = functionAliases(lua, "redis.call");
  for (const alias of functionAliases(lua, "redis.pcall")) callAliases.add(alias);
  const constants = luaScalarConstants(lua);
  for (const alias of callAliases) {
    const escaped = escapeRegExp(alias);
    for (const match of lua.matchAll(new RegExp(`${escaped}\\s*\\(`, "g"))) {
      const open = lua.indexOf("(", Number(match.index));
      const argument = matchingArgument(lua, open);
      const commandToken = argument.split(",", 1)[0]?.trim() || "";
      const literal = commandToken.match(/^['"]([^'"]+)['"]$/)?.[1] || constants.get(commandToken) || "";
      if (/^(?:SET|HSET|HMSET|LPUSH|RPUSH|LSET|SADD|ZADD|MSET|XADD|JSON\.SET)$/i.test(literal)) argumentsList.push(argument);
    }
  }
  return argumentsList;
}

function persisted(writeArguments, variable) {
  const escaped = escapeRegExp(variable);
  return writeArguments.some((argument) => new RegExp(`\\b${escaped}\\b`).test(argument));
}

function functionAliases(lua, original) {
  const aliases = new Set([original]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:--[^\n]*)?(?=;|\n|$)/g)) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return aliases;
}

function assignedFromCall(lua, functions) {
  const variables = new Set();
  for (const fn of functions) {
    const escaped = escapeRegExp(fn);
    for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?([A-Za-z_]\\w*)\\s*=\\s*${escaped}\\s*\\(`, "g"))) variables.add(match[1]);
    for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?[A-Za-z_]\\w*\\s*,\\s*([A-Za-z_]\\w*)\\s*=\\s*pcall\\s*\\(\\s*${escaped}\\s*,`, "g"))) variables.add(match[1]);
  }
  return variables;
}

function propagateAliases(lua, variables) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*(?:--[^\n]*)?(?=;|\n|$)/g)) {
      if (variables.has(match[2]) && !variables.has(match[1])) {
        variables.add(match[1]);
        changed = true;
      }
    }
    for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\[[^\]\n]+\]/g)) {
      if (variables.has(match[2]) && !variables.has(match[1])) {
        variables.add(match[1]);
        changed = true;
      }
    }
    for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*(?:\.[A-Za-z_]\w*)+/g)) {
      if (variables.has(match[2]) && !variables.has(match[1])) {
        variables.add(match[1]);
        changed = true;
      }
    }
    for (const match of lua.matchAll(/\bfor\s+(?:[A-Za-z_]\w*\s*,\s*)?([A-Za-z_]\w*)\s+in\s+(?:i?pairs)\s*\(\s*([A-Za-z_]\w*)(?:\s*(?:\.[A-Za-z_]\w*|\[[^\]\n]+\]))*\s*\)\s+do/g)) {
      if (variables.has(match[2]) && !variables.has(match[1])) {
        variables.add(match[1]);
        changed = true;
      }
    }
    for (const match of lua.matchAll(/(?:^|[;\n])\s*([A-Za-z_]\w*)\s*\[[^\]\n]+\]\s*=\s*([A-Za-z_]\w*)\b/g)) {
      if (variables.has(match[2]) && !variables.has(match[1])) {
        variables.add(match[1]);
        changed = true;
      }
    }
  }
  return variables;
}

function encodedResults(lua, encodeFunctions, values) {
  const encoded = new Set();
  for (const fn of encodeFunctions) {
    const escapedFn = escapeRegExp(fn);
    for (const value of values) {
      const escapedValue = escapeRegExp(value);
      for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?([A-Za-z_]\\w*)\\s*=\\s*${escapedFn}\\s*\\(\\s*${escapedValue}(?:\\s*,[\\s\\S]{0,240}?)?\\s*\\)`, "g"))) encoded.add(match[1]);
      for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?[A-Za-z_]\\w*\\s*,\\s*([A-Za-z_]\\w*)\\s*=\\s*pcall\\s*\\(\\s*${escapedFn}\\s*,\\s*${escapedValue}\\s*\\)`, "g"))) encoded.add(match[1]);
      for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?[A-Za-z_]\\w*\\s*,\\s*([A-Za-z_]\\w*)\\s*=\\s*xpcall\\s*\\(\\s*${escapedFn}\\s*,[\\s\\S]{0,240}?,\\s*${escapedValue}\\s*\\)`, "g"))) encoded.add(match[1]);
      for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?[A-Za-z_]\\w*\\s*,\\s*([A-Za-z_]\\w*)\\s*=\\s*pcall\\s*\\(\\s*function\\s*\\([^)]*\\)?[\\s\\S]{0,240}?${escapedFn}\\s*\\(\\s*${escapedValue}\\s*\\)[\\s\\S]{0,120}?end\\s*\\)`, "g"))) encoded.add(match[1]);
    }
    for (const match of lua.matchAll(new RegExp(`(?:local\\s+)?([A-Za-z_]\\w*)(?:\\s*\\[[^\\]\\n]+\\])?\\s*=\\s*${escapedFn}\\s*\\(`, "g"))) {
      const open = lua.indexOf("(", Number(match.index) + match[0].lastIndexOf("("));
      const argument = matchingArgument(lua, open);
      if ([...values].some((value) => new RegExp(`\\b${escapeRegExp(value)}\\b`).test(argument))) encoded.add(match[1]);
    }
  }
  return propagateAliases(lua, encoded);
}

function functionBlocks(lua) {
  const code = luaCodeMask(lua);
  const tokens = [...code.matchAll(/\b[A-Za-z_]\w*\b/g)].map((match) => ({
    value: match[0],
    start: Number(match.index),
    end: Number(match.index) + match[0].length,
  }));
  const headers = [...code.matchAll(/(?:^|[;\n])\s*(?:local\s+)?function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)];
  const blocks = [];
  for (const match of headers) {
    const header = Number(match.index);
    const start = header + match[0].length;
    const functionToken = tokens.findIndex((token) => token.value === "function" && token.start >= header && token.start < start);
    if (functionToken < 0) continue;
    let depth = 0;
    let pendingDo = 0;
    let end = lua.length;
    for (let index = functionToken; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.value === "function" || token.value === "if") depth += 1;
      else if (token.value === "for" || token.value === "while") {
        depth += 1;
        pendingDo += 1;
      } else if (token.value === "do") {
        if (pendingDo > 0) pendingDo -= 1;
        else depth += 1;
      } else if (token.value === "end") {
        depth -= 1;
        if (depth === 0) {
          end = token.end;
          break;
        }
      }
    }
    blocks.push({
      name: match[1],
      parameters: match[2].split(",").map((value) => value.trim()).filter((value) => /^[A-Za-z_]\w*$/.test(value)),
      header,
      start,
      end,
      bodyEnd: Math.max(start, end - 3),
    });
  }
  return blocks.map((block) => {
    const children = blocks
      .filter((candidate) => candidate.header > block.header && candidate.end <= block.end)
      .map((candidate) => ({ start: candidate.header - block.start, end: candidate.end - block.start }));
    const rawBody = lua.slice(block.start, block.bodyEnd);
    return { ...block, body: maskRanges(rawBody, children) };
  });
}

function splitLuaArguments(source) {
  const values = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") round += 1;
    else if (char === ")") round = Math.max(0, round - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if (char === "{") curly += 1;
    else if (char === "}") curly = Math.max(0, curly - 1);
    else if (char === "," && round === 0 && square === 0 && curly === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values;
}

function wrappedWriteArguments(lua, wrappers) {
  const writes = [];
  for (const [name, metadata] of wrappers) {
    const indexes = metadata.indexes;
    for (const match of lua.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"))) {
      const open = lua.indexOf("(", Number(match.index));
      const argumentsList = splitLuaArguments(matchingArgument(lua, open));
      for (const index of indexes) if (argumentsList[index]) writes.push(argumentsList[index]);
    }
  }
  return writes;
}

function encodedByFunction(argument, variable, encodeFunctions) {
  return [...encodeFunctions].some((name) => new RegExp(
    `${escapeRegExp(name)}\\s*\\([\\s\\S]{0,240}?\\b${escapeRegExp(variable)}\\b`,
  ).test(argument));
}

function wrappedWriteEntries(lua, wrappers) {
  const writes = [];
  for (const [name, metadata] of wrappers) {
    for (const match of lua.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"))) {
      const open = lua.indexOf("(", Number(match.index));
      const argumentsList = splitLuaArguments(matchingArgument(lua, open));
      for (const index of metadata.indexes) {
        if (argumentsList[index]) writes.push({ argument: argumentsList[index], encoded: metadata.encoded.has(index) });
      }
    }
  }
  return writes;
}

function persistenceWrappers(lua, encodeFunctions) {
  const wrappers = new Map();
  const blocks = functionBlocks(lua);
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      const writes = [
        ...directRedisWriteArguments(block.body).map((argument) => ({ argument, encoded: false })),
        ...wrappedWriteEntries(block.body, wrappers),
      ];
      for (let index = 0; index < block.parameters.length; index += 1) {
        const parameter = block.parameters[index];
        const matchingWrites = writes.filter((entry) => persisted([entry.argument], parameter));
        if (!matchingWrites.length) continue;
        if (!wrappers.has(block.name)) wrappers.set(block.name, { indexes: new Set(), encoded: new Set() });
        const metadata = wrappers.get(block.name);
        if (!metadata.indexes.has(index)) {
          metadata.indexes.add(index);
          changed = true;
        }
        const encoded = matchingWrites.some((entry) => entry.encoded || encodedByFunction(entry.argument, parameter, encodeFunctions));
        if (encoded && !metadata.encoded.has(index)) {
          metadata.encoded.add(index);
          changed = true;
        }
      }
    }
  }
  return wrappers;
}

function redisWriteArguments(lua, wrappers = new Map()) {
  return [...directRedisWriteArguments(lua), ...wrappedWriteArguments(lua, wrappers)];
}

function encodedWrappedWriteArguments(lua, wrappers) {
  return wrappedWriteEntries(lua, wrappers).filter((entry) => entry.encoded).map((entry) => entry.argument);
}

function transformWrappers(lua, originalFunctions) {
  const functions = new Set(originalFunctions);
  const blocks = functionBlocks(lua);
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (functions.has(block.name) || !block.parameters.length) continue;
      for (const parameter of block.parameters) {
        const values = propagateAliases(block.body, new Set([parameter]));
        const results = encodedResults(block.body, functions, values);
        const returnsResult = [...results].some((result) => new RegExp(`\\breturn\\b[^;\\n]*\\b${escapeRegExp(result)}\\b`).test(block.body));
        const returnsCall = [...functions].some((fn) => [...values].some((value) => (
          new RegExp(`\\breturn\\s+${escapeRegExp(fn)}\\s*\\(\\s*${escapeRegExp(value)}(?:\\s*,[\\s\\S]{0,240}?)?\\s*\\)`).test(block.body)
        )));
        if (returnsResult || returnsCall) {
          functions.add(block.name);
          changed = true;
          break;
        }
      }
    }
    for (const match of lua.matchAll(/(?:^|[;\n])\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*(?:--[^\n]*)?(?=;|\n|$)/g)) {
      if (functions.has(match[2]) && !functions.has(match[1])) {
        functions.add(match[1]);
        changed = true;
      }
    }
  }
  return functions;
}

function directlyPersistedEncoding(writeArguments, encodeFunctions, values) {
  return writeArguments.some((argument) => [...encodeFunctions].some((fn) => [...values].some((value) => (
    new RegExp(`${escapeRegExp(fn)}\\s*\\(\\s*${escapeRegExp(value)}(?:\\s*,[\\s\\S]{0,240}?)?\\s*\\)`).test(argument)
  ))));
}

function insideProtectedFunction(lua, index) {
  for (const match of lua.matchAll(/(?:pcall|xpcall)\s*\(\s*function\b/g)) {
    const open = lua.indexOf("(", Number(match.index));
    const close = matchingClose(lua, open);
    if (open >= 0 && close >= 0 && index > open && index < close) return true;
  }
  return false;
}

function insideProtectedNamedWrapper(lua, index, blocks = functionBlocks(lua)) {
  for (const block of blocks) {
    if (index < block.start || index > block.bodyEnd) continue;
    const name = block.name;
    const directCalls = [...lua.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"))]
      .filter((call) => Number(call.index) < block.header || Number(call.index) >= block.end);
    const protectedCalls = [...lua.matchAll(new RegExp(`(?:pcall|xpcall)\\s*\\(\\s*${escapeRegExp(name)}\\s*[,)]`, "g"))];
    if (!directCalls.length && protectedCalls.length) return true;
  }
  return false;
}

function topLevelStringDefinitions(ast) {
  const definitions = new Map();
  const duplicates = new Set();
  for (const statement of ast.program?.body || []) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations || []) {
      if (item.id?.type !== "Identifier" || !item.init) continue;
      if (definitions.has(item.id.name)) duplicates.add(item.id.name);
      else definitions.set(item.id.name, { init: item.init, declaration: item });
    }
  }
  for (const name of duplicates) definitions.delete(name);
  return definitions;
}

function unwrapStaticStringNode(node) {
  let current = node;
  while (["ParenthesizedExpression", "TSAsExpression", "TSTypeAssertion"].includes(current?.type)) {
    current = current.expression;
  }
  return current;
}

function resolveStaticString(node, definitions, seen = new Set()) {
  const value = unwrapStaticStringNode(node);
  if (value?.type === "StringLiteral") return value.value;
  if (value?.type === "TemplateLiteral") {
    let result = "";
    for (let index = 0; index < value.quasis.length; index += 1) {
      result += value.quasis[index].value?.cooked ?? value.quasis[index].value?.raw ?? "";
      if (index >= value.expressions.length) continue;
      const expression = resolveStaticString(value.expressions[index], definitions, seen);
      if (expression === null) return null;
      result += expression;
    }
    return result;
  }
  if (value?.type === "BinaryExpression" && value.operator === "+") {
    const left = resolveStaticString(value.left, definitions, seen);
    const right = resolveStaticString(value.right, definitions, seen);
    return left === null || right === null ? null : left + right;
  }
  if (value?.type !== "Identifier" || seen.has(value.name) || !definitions.has(value.name)) return null;
  return resolveStaticString(
    definitions.get(value.name).init,
    definitions,
    new Set([...seen, value.name]),
  );
}

const files = await walkFiles(root, (target) => /\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(target));
for (const file of files) {
  const source = await sourceFile(file);
  let ast;
  try {
    ast = parseModule(source, file);
  } catch (error) {
    findings.push({
      file: relative(root, file),
      line: Number(error?.loc?.line || 1),
      column: Number(error?.loc?.column || 0) + 1,
      code: "lua-source-parse",
      message: `无法解析可能包含 Lua 的源码：${error.message}`,
    });
    continue;
  }
  const definitions = topLevelStringDefinitions(ast);
  const programs = [];
  const coveredRanges = [];
  for (const { init, declaration } of definitions.values()) {
    const lua = resolveStaticString(init, definitions);
    if (lua === null) continue;
    coveredRanges.push({ start: Number(init.start), end: Number(init.end) });
    if (!/\bcjson\.(?:decode|encode)\b/.test(lua)) continue;
    programs.push({
      lua,
      base: init.type === "TemplateLiteral" ? Number(init.start) + 1 : Number(declaration.start),
      preciseOffsets: init.type === "TemplateLiteral",
    });
  }
  visit(ast, (node) => {
    if (node.type !== "TemplateLiteral") return;
    if (coveredRanges.some((range) => Number(node.start) >= range.start && Number(node.end) <= range.end)) return;
    programs.push({
      lua: source.slice(Number(node.start) + 1, Number(node.end) - 1),
      base: Number(node.start) + 1,
      preciseOffsets: true,
    });
  });
  for (const program of programs) {
    const { lua, base, preciseOffsets } = program;
    if (!/\bcjson\.(?:decode|encode)\b/.test(lua)) continue;
    const blocks = functionBlocks(lua);
    const decodeFunctions = transformWrappers(lua, functionAliases(lua, "cjson.decode"));
    const directEncodeFunctions = functionAliases(lua, "cjson.encode");
    const encodeFunctions = transformWrappers(lua, directEncodeFunctions);
    const writeWrappers = persistenceWrappers(lua, encodeFunctions);
    const topLevel = maskRanges(lua, blocks.map((block) => ({ start: block.header, end: block.end })));
    const scopes = [topLevel, ...blocks.map((block) => block.body)];
    const roundtrip = scopes.some((scope) => {
      const writeArguments = redisWriteArguments(scope, writeWrappers);
      const decoded = propagateAliases(scope, assignedFromCall(scope, decodeFunctions));
      const encoded = encodedResults(scope, encodeFunctions, decoded);
      return decoded.size && (
        directlyPersistedEncoding(writeArguments, encodeFunctions, decoded)
        || [...encoded].some((name) => persisted(writeArguments, name))
        || encodedWrappedWriteArguments(scope, writeWrappers).some((argument) => [...decoded].some((name) => (
          new RegExp(`\\b${escapeRegExp(name)}\\b`).test(argument)
        )))
      );
    });
    if (roundtrip) {
      const firstDecode = Math.max(0, [...decodeFunctions].map((name) => lua.indexOf(name)).filter((index) => index >= 0).sort((a, b) => a - b)[0] || 0);
      findings.push({
        file: relative(root, file),
        line: lineNumber(source, preciseOffsets ? base + firstDecode : base),
        column: 1,
        code: "lua-json-roundtrip",
        message: `Lua 将 cjson.decode 得到的数据重新编码并持久化，可能改写 []、null 或长数字`,
      });
    }

    for (const fn of directEncodeFunctions) {
      const call = new RegExp(`${escapeRegExp(fn)}\\s*\\(`, "g");
      for (const match of lua.matchAll(call)) {
        if (insideProtectedFunction(lua, Number(match.index)) || insideProtectedNamedWrapper(lua, Number(match.index), blocks)) continue;
        const openIndex = lua.indexOf("(", Number(match.index));
        const argument = matchingArgument(lua, openIndex);
        if (isFixedScalarTable(argument)) continue;
        findings.push({
          file: relative(root, file),
          line: lineNumber(source, preciseOffsets ? base + Number(match.index) : base),
          column: 1,
          code: "lua-unprotected-encode",
          message: "可变数据的 cjson.encode（或其局部别名）未通过 pcall 保护；无论它位于 Redis 写入前后，编码异常都可能留下失败或部分写入",
        });
      }
    }
  }
}

finish(findings);
