import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditDirectory = path.join(repositoryRoot, "scripts", "audit");

async function withFixture(files, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "liumeiti-audit-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source, "utf8");
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runAudit(name, root) {
  return spawnSync(process.execPath, [path.join(auditDirectory, name), "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function assertAuditFinding(audit, files, code) {
  await withFixture(files, (root) => {
    const result = runAudit(audit, root);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stdout, new RegExp(`\\[${code}\\]`));
  });
}

async function assertAuditClean(audit, files) {
  await withFixture(files, (root) => {
    const result = runAudit(audit, root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
}

test("loading audit accepts finally + AbortSignal and rejects success-only cleanup", async () => {
  await withFixture({
    "app/good.jsx": `
      const [loading, setLoading] = useState(false);
      async function load() {
        setLoading(true);
        const signal = AbortSignal.timeout(1000);
        try { await fetch("/api/data", { signal }); }
        finally { setLoading(false); }
      }
    `,
  }, (root) => {
    const result = runAudit("audit-loading-states.mjs", root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
  await withFixture({
    "app/bad.jsx": `
      const [loading, setLoading] = useState(false);
      async function load() {
        setLoading(true);
        const response = await fetch("/api/data");
        if (response.ok) setLoading(false);
      }
    `,
  }, (root) => {
    const result = runAudit("audit-loading-states.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[loading-exit\]/);
    assert.match(result.stdout, /\[loading-timeout\]/);
  });
});

test("fail-closed audit distinguishes corrupt historical data from an outage", async () => {
  await withFixture({
    "app/api/good/route.js": `
      export async function GET() {
        return Response.json({ error: "redis_unavailable" }, { status: 503 });
      }
    `,
  }, (root) => {
    const result = runAudit("audit-fail-closed.mjs", root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
  await withFixture({
    "app/api/bad/route.js": `
      export async function GET(record) {
        if (!/^[0-9]+$/.test(record.version)) {
          return Response.json({ error: "auth_record_invalid" }, { status: 503 });
        }
        return Response.json({ ok: true });
      }
    `,
  }, (root) => {
    const result = runAudit("audit-fail-closed.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[data-validation-5xx\]/);
  });
});

test("Lua audit catches persisted JSON round-trips and unprotected variable encodes", async () => {
  await withFixture({
    "app/api/good.js": "const SCRIPT = `local ok, encoded = pcall(cjson.encode, { ok = true })\\nreturn encoded`;",
  }, (root) => {
    const result = runAudit("audit-lua-roundtrip.mjs", root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
  await withFixture({
    "app/api/bad.js": "const SCRIPT = `local record = cjson.decode(ARGV[1])\\nlocal encoded = cjson.encode(record)\\nredis.call('SET', KEYS[1], encoded)\\nreturn encoded`;",
  }, (root) => {
    const result = runAudit("audit-lua-roundtrip.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[lua-json-roundtrip\]/);
    assert.match(result.stdout, /\[lua-unprotected-encode\]/);
  });
});

test("Lua audit follows decoded data through protected local encode wrappers", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/wrapped.js": [
      "const SCRIPT = `",
      "local function decode(value)",
      "  local ok, decoded = pcall(cjson.decode, value)",
      "  if not ok then return nil end",
      "  return decoded",
      "end",
      "local function protectedencode(value)",
      "  local ok, encoded = pcall(cjson.encode, value)",
      "  if not ok then return nil end",
      "  return encoded",
      "end",
      "local function encodepreservingemptyarrays(value, original)",
      "  local encoded = protectedencode(value)",
      "  if original == '[]' then encoded = '[]' end",
      "  return encoded",
      "end",
      "local record = decode(ARGV[1])",
      "local stored = encodepreservingemptyarrays(record, ARGV[1])",
      "redis.call('SET', KEYS[1], stored)",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit follows decoded collection members into encoded write buffers", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/collection.js": [
      "const SCRIPT = `",
      "local itemsOk, items = pcall(cjson.decode, ARGV[1])",
      "if not itemsOk then return 0 end",
      "local encodedItems = {}",
      "for itemIndex = 1, #items do",
      "  local item = items[itemIndex]",
      "  local encodedOk, encoded = pcall(cjson.encode, item)",
      "  if not encodedOk then return 0 end",
      "  encodedItems[itemIndex] = encoded",
      "end",
      "for itemIndex = 1, #items do",
      "  redis.call('SET', KEYS[itemIndex], encodedItems[itemIndex])",
      "end",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit composes shared top-level Lua prefixes before analyzing writes", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/composed.js": [
      "const LUA_COMMON = `",
      "local function decode(value) return cjson.decode(value) end",
      "local function encode(value) return cjson.encode(value) end",
      "`;",
      "const SCRIPT = LUA_COMMON + `",
      "local record = decode(ARGV[1])",
      "local encoded = encode(record)",
      "redis.call('SET', KEYS[1], encoded)",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit follows decoded values through local Redis write wrappers", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/wrapped-sink.js": [
      "const LUA_COMMON = `",
      "local function decode(value) return cjson.decode(value) end",
      "local function encode(value) local ok,result=pcall(cjson.encode,value); return result end",
      "local function pushtrim(key,value) redis.call('LPUSH',key,value); redis.call('LTRIM',key,0,99) end",
      "`;",
      "const SCRIPT = LUA_COMMON + `",
      "local record = decode(ARGV[1])",
      "local encoded = encode(record)",
      "pushtrim(KEYS[1], encoded)",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit tracks wrapper-internal encoding of a decoded argument", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/saveop-sink.js": [
      "const SCRIPT = `",
      "local function saveop(key,value) redis.call('SET',key,cjson.encode(value)) end",
      "local decoded=cjson.decode(ARGV[1])",
      "saveop(KEYS[1],{withdrawal=decoded})",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("test-default audit resolves named constants and requires adverse identity defaults", async () => {
  await withFixture({
    "tests/good.test.mjs": "function mail({ requestFingerprint = '' } = {}) { return requestFingerprint; }",
  }, (root) => {
    const result = runAudit("audit-test-defaults.mjs", root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
  await withFixture({
    "tests/bad.test.mjs": "const SHARED = 'same'; function mail({ requestFingerprint = SHARED } = {}) { return requestFingerprint; }",
  }, (root) => {
    const result = runAudit("audit-test-defaults.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[friendly-test-default\]/);
  });
});

test("test-default audit scans shared helper modules outside test files", async () => {
  await assertAuditFinding("audit-test-defaults.mjs", {
    "tests/helpers/mail.mjs": `export function mail({ requestFingerprint = "shared" } = {}) { return requestFingerprint; }`,
  }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/helpers/mail.mjs": `export function mail({ requestFingerprint = "" } = {}) { return requestFingerprint; }`,
  });
});

const protectedRoute = `
  function requiredIdempotencyKey() { return "key"; }
  export async function POST(request) {
    requiredIdempotencyKey(request);
    const body = await request.json();
    const email = String(body.email || "");
    if (!email) return Response.json({ error: "email_required" }, { status: 400 });
    return Response.json({ ok: true });
  }
`;

test("contract audit compares idempotency headers and required JSON fields", async () => {
  await withFixture({
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `fetch("/api/order", { method: "POST", headers: { "Idempotency-Key": "one" }, body: JSON.stringify({ email: "a@example.com" }) });`,
    "docs/idempotency-integrations.md": "| `POST /api/order` | `app/page.jsx` |",
  }, (root) => {
    const result = runAudit("audit-contract.mjs", root);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
  });
  await withFixture({
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "x" }) });`,
    "docs/idempotency-integrations.md": "| `POST /api/order` | `app/page.jsx` |",
  }, (root) => {
    const result = runAudit("audit-contract.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[missing-idempotency-key\]/);
    assert.match(result.stdout, /\[missing-required-field\]/);
  });
});

test("contract audit follows handlers wrapped by withApiTelemetry", async () => {
  const wrappedRoute = `
    function requiredIdempotencyKey() { return "key"; }
    async function createOrder(request) {
      requiredIdempotencyKey(request);
      const body = await request.json();
      if (!body.email) return Response.json({ error: "email_required" }, { status: 400 });
      return Response.json({ ok: true });
    }
    export const POST = withApiTelemetry("order_create", createOrder);
  `;
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": wrappedRoute,
    "app/page.jsx": `fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "x" }) });`,
    "docs/idempotency-integrations.md": "| `POST /api/order` | `app/page.jsx` |",
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": wrappedRoute,
    "app/page.jsx": `fetch("/api/order", { method: "POST", headers: { "Idempotency-Key": "one" }, body: JSON.stringify({ email: "a@example.com" }) });`,
    "docs/idempotency-integrations.md": "| `POST /api/order` | `app/page.jsx` |",
  });
});

test("loading audit rejects a return between activation and the protecting try", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false); async function load(id){ setLoading(true); if(!id)return; try{await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{setLoading(false)} }`,
  }, "loading-exit");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false); async function load(id){ if(!id)return; setLoading(true); try{await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{setLoading(false)} }`,
  });
});

test("loading audit rejects an unreachable catch cleanup", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false); async function load(){setLoading(true);try{await fetch('/api/x',{signal:AbortSignal.timeout(50)});setLoading(false)}catch(e){return;setLoading(false)}}`,
  }, "loading-exit");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false); async function load(){setLoading(true);try{await fetch('/api/x',{signal:AbortSignal.timeout(50)});setLoading(false)}catch(e){setLoading(false);return}}`,
  });
});

test("loading audit requires a real timer to abort an AbortController", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);async function load(){setLoading(true);const c=new AbortController();try{await fetch('/api/x',{signal:c.signal})}finally{setLoading(false)}}`,
  }, "loading-timeout");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);async function load(){setLoading(true);const c=new AbortController();const timer=setTimeout(()=>c.abort(),50);try{await fetch('/api/x',{signal:c.signal})}finally{clearTimeout(timer);setLoading(false)}}`,
  });
});

test("loading audit rejects unreachable Promise catch cleanup", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);function load(){setLoading(true);fetch('/api/x',{signal:AbortSignal.timeout(50)}).then(()=>setLoading(false)).catch(()=>{return;setLoading(false)})}`,
  }, "loading-exit");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);function load(){setLoading(true);fetch('/api/x',{signal:AbortSignal.timeout(50)}).then(()=>setLoading(false)).catch(()=>setLoading(false))}`,
  });
});

test("fail-closed audit resolves a local 5xx status constant", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `const BAD=503;export function GET(record){if(!record.version)return Response.json({error:'auth_record_invalid'},{status:BAD})}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/x/route.js": `const DOWN=503;export function GET(){return Response.json({error:'redis_unavailable'},{status:DOWN})}`,
  });
});

test("fail-closed audit recognizes corrupt JSON caught as a 5xx", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `export function GET(raw){try{JSON.parse(raw)}catch{return Response.json({error:'profile_deserialize_failed'},{status:503})}}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/x/route.js": `export function GET(raw){try{JSON.parse(raw)}catch{return Response.json({error:'profile_invalid'},{status:400})}}`,
  });
});

test("fail-closed audit follows a returned local error helper", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `function serverError(error,status){return Response.json({error},{status})}export function GET(record){if(!record.version)return serverError('auth_record_invalid',503)}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/x/route.js": `function serverError(error,status){return Response.json({error},{status})}export function GET(){return serverError('redis_unavailable',503)}`,
  });
});

test("fail-closed audit follows local parsing helpers called inside a guarded try", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `
      function parseStored(raw) {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') throw new Error('health_status_store_corrupt');
        return value;
      }
      function readStored(raw) { return parseStored(raw); }
      export function GET(raw) {
        try { readStored(raw); return Response.json({ok:true}); }
        catch (error) { return Response.json({error:error.message},{status:503}); }
      }
    `,
  }, "data-validation-5xx");
});

test("fail-closed audit follows imported parsing helpers called inside a guarded try", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/_stored.js": `export function readStored(raw){const value=JSON.parse(raw);if(!value||typeof value!=='object')throw new Error('historical_record_invalid');return value}`,
    "app/api/x/route.js": `import{readStored}from'../_stored.js';export function GET(raw){try{readStored(raw);return Response.json({ok:true})}catch(error){return Response.json({error:error.message},{status:503})}}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/_stored.js": `export async function readStored(){throw new Error('redis_unavailable')}`,
    "app/api/x/route.js": `import{readStored}from'../_stored.js';export async function GET(){try{await readStored();return Response.json({ok:true})}catch(error){return Response.json({error:error.message},{status:503})}}`,
  });
});

test("fail-closed audit traces a conditional identifier back to an imported parser", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/_stored.js": `export function readStored(raw){try{return JSON.parse(raw)}catch{return null}}`,
    "app/api/x/route.js": `import{readStored}from'../_stored.js';export async function GET(raw){const record=await readStored(raw);if(!record)return Response.json({error:'storage_unavailable'},{status:503});return Response.json({ok:true})}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/_stored.js": `export async function readStored(){return fetch('https://redis.example/status')}`,
    "app/api/x/route.js": `import{readStored}from'../_stored.js';export async function GET(){const record=await readStored();if(!record)return Response.json({error:'storage_unavailable'},{status:503});return Response.json({ok:true})}`,
  });
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/_stored.js": `export async function readStored(raw){let value=null;try{value=JSON.parse(raw)}catch{}if(!value)value=await repairCorruptRecord(raw);return value}`,
    "app/api/x/route.js": `import{readStored}from'../_stored.js';export async function GET(raw){const record=await readStored(raw);if(!record)return Response.json({error:'storage_unavailable'},{status:503});return Response.json({ok:true})}`,
  });
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/_stored.js": `function parseStored(raw){try{return JSON.parse(raw)}catch{return null}}function readState(raw){return parseStored(raw)}export function ensureStored(raw){return readState(raw)}`,
    "app/api/x/route.js": `import{ensureStored}from'../_stored.js';export async function GET(raw){const record=await ensureStored(raw);if(!record)return Response.json({error:'storage_unavailable'},{status:503});return Response.json({ok:true})}`,
  }, "data-validation-5xx");
});

test("Lua audit follows local cjson decode and encode aliases", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local decode=cjson.decode\nlocal encode=cjson.encode\nlocal user=decode(ARGV[1])\nlocal ok,encoded=pcall(encode,user)\nredis.call('SET',KEYS[1],encoded)`;",
  }, "lua-json-roundtrip");
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local encode=cjson.encode\nlocal ok,encoded=pcall(encode,{ok=true})\nredis.call('SET',KEYS[1],encoded)`;",
  });
});

test("Lua audit follows one-step aliases of decoded values", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local user=cjson.decode(ARGV[1])\nlocal clone=user\nlocal ok,encoded=pcall(cjson.encode,clone)\nredis.call('SET',KEYS[1],encoded)`;",
  }, "lua-json-roundtrip");
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local user=cjson.decode(ARGV[1])\nlocal clone=user\nlocal ok,encoded=pcall(cjson.encode,clone)\nreturn encoded`;",
  });
});

test("Lua audit treats JSON.SET as a persistence write", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local user=cjson.decode(ARGV[1])\nlocal ok,encoded=pcall(cjson.encode,user)\nredis.call('JSON.SET',KEYS[1],'$',encoded)`;",
  }, "lua-json-roundtrip");
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local ok,encoded=pcall(cjson.encode,{ok=true})\nredis.call('JSON.SET',KEYS[1],'$',encoded)`;",
  });
});

test("Lua audit understands pcall function wrappers but flags encode after a write", async () => {
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local user={value=ARGV[1]}\nlocal ok,encoded=pcall(function() return cjson.encode(user) end)\nreturn encoded`;",
  });
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`redis.call('SET',KEYS[1],ARGV[1])\nlocal user={value=ARGV[1]}\nlocal encoded=cjson.encode(user)\nreturn encoded`;",
  }, "lua-unprotected-encode");
});

test("test-default audit checks nullish defaults inside helper bodies", async () => {
  await assertAuditFinding("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `function mail(options={}){const requestFingerprint=options.requestFingerprint??'shared';return requestFingerprint}`,
  }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `function mail(options={}){const requestFingerprint=options.requestFingerprint??'';return requestFingerprint}`,
  });
});

test("test-default audit checks favorable default object spreads", async () => {
  await assertAuditFinding("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const DEFAULT_MAIL={requestFingerprint:'shared'};function mail(overrides={}){return {...DEFAULT_MAIL,...overrides}}`,
  }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const DEFAULT_MAIL={requestFingerprint:''};function mail(overrides={}){return {...DEFAULT_MAIL,...overrides}}`,
  });
});

test("test-default audit includes object methods", async () => {
  await assertAuditFinding("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const fixture={mail({requestFingerprint='shared'}={}){return requestFingerprint}}`,
  }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const fixture={mail({requestFingerprint=''}={}){return requestFingerprint}}`,
  });
});

const idempotencyDocs = "| `POST /api/order` | caller |";

test("contract audit resolves a local URL constant", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `const endpoint='/api/order';fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'x'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `const endpoint='/api/order';fetch(endpoint,{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("contract audit includes window.fetch", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `window.fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'x'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-required-field");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `window.fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("contract audit includes repository scripts", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "scripts/client.mjs": `fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'x'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "scripts/client.mjs": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("contract audit extracts fields from a local validation helper call", async () => {
  const helperRoute = `function requiredIdempotencyKey(){return'x'};function requireBody(){};export async function POST(request){requiredIdempotencyKey(request);const body=await request.json();requireBody(body,['email']);return Response.json({ok:true})}`;
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": helperRoute,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({code:'x'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-required-field");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": helperRoute,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("contract audit only accepts Idempotency-Key from the actual headers object", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},metadata:{'Idempotency-Key':'not-a-header'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},metadata:{},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("contract audit emits explicit findings for genuinely dynamic URL and body contracts", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": protectedRoute,
    "app/page.jsx": `const endpoint=enabled?'/api/order':'/api/quote-orders';fetch(endpoint,{method:'POST'})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "unverifiable-fetch-url");
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": `function requiredIdempotencyKey(){return'x'};function validate(){};export async function POST(request){requiredIdempotencyKey(request);const body=await request.json();validate(body,schema);return Response.json({ok:true})}`,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({email:'a@b.c'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "unverifiable-route-contract");
});

test("loading audit red-team round 2: conditional finally, helper cleanup, and Promise branches", async () => {
  const bad = [
    `const [loading,setLoading]=useState(false);async function load(){setLoading(true);let ok=false;try{await fetch('/api/x',{signal:AbortSignal.timeout(50)});ok=true}finally{if(ok)setLoading(false)}}`,
    `const [loading,setLoading]=useState(false);async function load(){setLoading(true);try{await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{return;setLoading(false)}}`,
    `const [loading,setLoading]=useState(false);function load(){setLoading(true);fetch('/api/x',{signal:AbortSignal.timeout(50)}).then((ok)=>{if(ok)setLoading(false)}).catch(()=>setLoading(false))}`,
  ];
  for (const source of bad) await assertAuditFinding("audit-loading-states.mjs", { "app/page.jsx": source }, "loading-exit");
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/lib/client-fetch.js": `export function clientFetch(url,options){return fetch(url,options)}`,
    "app/page.jsx": `import {clientFetch} from './lib/client-fetch';const [loading,setLoading]=useState(false);async function load(){setLoading(true);try{await clientFetch('/api/x')}finally{setLoading(false)}}`,
  }, "loading-timeout");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);function stop(){setLoading(false)}async function load(){setLoading(true);try{await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{stop()}}`,
  });
});

test("fail-closed audit red-team round 2: nested helpers, arithmetic status, and error constants", async () => {
  const bad = [
    `function response(error,status){return Response.json({error},{status})}function problem(error,status){return response(error,status)}export function GET(record){if(!record.version)return problem('auth_record_invalid',503)}`,
    `export function GET(record){if(!record.version)return Response.json({error:'auth_record_invalid'},{status:500+3})}`,
    `const ERR='auth_record_invalid';export function GET(record){if(!record.version)return Response.json({error:ERR},{status:503})}`,
    `function problem(error,status){return Response.json({error},{status})}export function GET(record){if(!record.version)return problem('auth_record_invalid',503)}`,
  ];
  for (const source of bad) await assertAuditFinding("audit-fail-closed.mjs", { "app/api/x/route.js": source }, "data-validation-5xx");
});

test("Lua audit red-team round 2: aliases, wrappers, JSON.SET, pcall and xpcall", async () => {
  const bad = [
    "const SCRIPT=`local d=cjson.decode; local d2=d; local e=cjson.encode; local e2=e; local user=d2(ARGV[1]); local ok,encoded=pcall(e2,user); redis.call('SET',KEYS[1],encoded)`;",
    "const SCRIPT=`local user=cjson.decode(ARGV[1]); local ok,encoded=pcall(function() return cjson.encode(user) end); redis.call('SET',KEYS[1],encoded)`;",
    "const SCRIPT=`local user=cjson.decode(ARGV[1]); local ok,encoded=pcall(cjson.encode,user); local write=redis.call; write('JSON.SET',KEYS[1],'$',encoded)`;",
    "const SCRIPT=`local user=cjson.decode(ARGV[1]); local ok,encoded=pcall(cjson.encode,user); local cmd='JSON.SET'; redis.call(cmd,KEYS[1],'$',encoded)`;",
    "const SCRIPT=`local user=cjson.decode(ARGV[1]); local ok,encoded=xpcall(cjson.encode,function(e)return e end,user); redis.call('SET',KEYS[1],encoded)`;",
  ];
  for (const source of bad) await assertAuditFinding("audit-lua-roundtrip.mjs", { "app/api/x.js": source }, "lua-json-roundtrip");
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local function safe(value) return cjson.encode(value) end; local ok,encoded=pcall(safe,{value=ARGV[1]}); return encoded`;",
  });
});

test("test-default audit red-team round 2: aliases, assignment defaults, inherited spreads, and adverse negatives", async () => {
  const bad = [
    `function mail({requestFingerprint:fp='shared'}={}){return fp}`,
    `function mail(options={}){const fp=options.requestFingerprint??'shared';return fp}`,
    `const BASE={requestFingerprint:'shared'};const DEFAULTS={...BASE};function mail(overrides={}){return {...DEFAULTS,...overrides}}`,
    `function mail(options={}){options.requestFingerprint??='shared';return options}`,
    `function mail({requestFingerprint=CI?'shared':''}={}){return requestFingerprint}`,
  ];
  for (const source of bad) await assertAuditFinding("audit-test-defaults.mjs", { "tests/x.test.mjs": source }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `function account({authVersion=-1}={}){return authVersion}`,
  });
});

test("contract audit red-team round 2: mutations, spreads, computed keys and fetch aliases", async () => {
  const route = { "app/api/order/route.js": protectedRoute, "docs/idempotency-integrations.md": idempotencyDocs };
  const bad = [
    [`function endpoint(){return '/api/order'}fetch(endpoint(),{method:'POST'})`, "unverifiable-fetch-url"],
    [`const headers={'Idempotency-Key':'x'};delete headers['Idempotency-Key'];fetch('/api/order',{method:'POST',headers,body:JSON.stringify({email:'a@b.c'})})`, "missing-idempotency-key"],
    [`const payload={email:'a@b.c'};delete payload.email;fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify(payload)})`, "missing-required-field"],
    [`const base={method:'POST',headers:{'Idempotency-Key':'x'}};fetch('/api/order',{...base,body:JSON.stringify({code:'x'})})`, "missing-required-field"],
    [`const send=fetch;send('/api/order',{method:'POST',headers:{},body:JSON.stringify({email:'a@b.c'})})`, "missing-idempotency-key"],
    [`fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({code:'x'})})`, "missing-required-field"],
  ];
  for (const [source, code] of bad) await assertAuditFinding("audit-contract.mjs", { ...route, "app/page.jsx": source }, code);
  const good = [
    `const headers={};headers['Idempotency-Key']='x';fetch('/api/order',{method:'POST',headers,body:JSON.stringify({email:'a@b.c'})})`,
    `const payload={};payload.email='a@b.c';fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify(payload)})`,
    `const EMAIL='email';fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({[EMAIL]:'a@b.c'})})`,
  ];
  for (const source of good) await assertAuditClean("audit-contract.mjs", { ...route, "app/page.jsx": source });
});

test("contract audit recognizes optional-chain trim as a required route field", async () => {
  const route = `function requiredIdempotencyKey(){return'x'};export async function POST(request){requiredIdempotencyKey(request);const body=await request.json();if(!body.email?.trim())return Response.json({error:'email_required'},{status:400});return Response.json({ok:true})}`;
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": route,
    "app/page.jsx": `fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'x'},body:JSON.stringify({code:'x'})})`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-required-field");
});

test("contract audit scans internal callers that share a protected route file", async () => {
  await assertAuditFinding("audit-contract.mjs", {
    "app/api/order/route.js": `${protectedRoute}\nexport async function forwardQuote(){return fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'a@b.c'})})}`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    "app/api/order/route.js": `${protectedRoute}\nexport async function forwardQuote(){return fetch('/api/order',{method:'POST',headers:{'Idempotency-Key':'internal-call'},body:JSON.stringify({email:'a@b.c'})})}`,
    "docs/idempotency-integrations.md": idempotencyDocs,
  });
});

test("loading audit red-team round 3: async generators cannot escape before finally", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);async function* load(enabled){setLoading(true);if(!enabled)return;try{yield await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{setLoading(false)}}`,
  }, "loading-exit");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);async function* load(enabled){if(!enabled)return;setLoading(true);try{yield await fetch('/api/x',{signal:AbortSignal.timeout(50)})}finally{setLoading(false)}}`,
  });
});

test("loading audit red-team round 3: Promise.finally cleanup must be unconditional", async () => {
  await assertAuditFinding("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);function load(){setLoading(true);let completed=false;return fetch('/api/x',{signal:AbortSignal.timeout(50)}).then(()=>{completed=true}).finally(()=>{if(completed)setLoading(false)})}`,
  }, "loading-exit");
  await assertAuditClean("audit-loading-states.mjs", {
    "app/page.jsx": `const [loading,setLoading]=useState(false);function load(){setLoading(true);return fetch('/api/x',{signal:AbortSignal.timeout(50)}).finally(()=>setLoading(false))}`,
  });
});

test("fail-closed audit red-team round 3: follows historical-format predicates and response helpers", async () => {
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `function legacyFormatInvalid(record){return !Number.isInteger(record.authVersion)}function failed(){return Response.json({error:'auth_check_failed'},{status:503})}export function GET(record){if(legacyFormatInvalid(record))return failed();return Response.json({ok:true})}`,
  }, "data-validation-5xx");
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/x/route.js": `function redisUnavailable(error){return error?.code==='ECONNREFUSED'}function unavailable(){return Response.json({error:'redis_unavailable'},{status:503})}export function GET(error){if(redisUnavailable(error))return unavailable();return Response.json({ok:true})}`,
  });
});

test("fail-closed audit red-team round 3: provider rate outages are not historical corruption", async () => {
  await assertAuditClean("audit-fail-closed.mjs", {
    "app/api/x/route.js": `export function GET(usdtRate){if(!Number.isFinite(usdtRate))return Response.json({error:'usdt_rate_unavailable'},{status:503});return Response.json({ok:true})}`,
  });
  await assertAuditFinding("audit-fail-closed.mjs", {
    "app/api/x/route.js": `export function GET(version){if(!Number.isFinite(version))return Response.json({error:'record_invalid'},{status:503});return Response.json({ok:true})}`,
  }, "data-validation-5xx");
});

test("Lua audit red-team round 3: follows multilevel decoded-value aliases through nested pcall", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local decode=cjson.decode\nlocal encode=cjson.encode\nlocal user=decode(ARGV[1])\nlocal alias1=user\nlocal alias2=alias1\nlocal alias3=alias2\nlocal ok,encoded=pcall(function() return encode(alias3) end)\nredis.call('SET',KEYS[1],encoded)`;",
  }, "lua-json-roundtrip");
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": "const SCRIPT=`local encode=cjson.encode\nlocal fresh={value=ARGV[1]}\nlocal alias1=fresh\nlocal alias2=alias1\nlocal ok,encoded=pcall(function() return encode(alias2) end)\nreturn encoded`;",
  });
});

test("test-default audit red-team round 3: resolves friendly member defaults in nested destructuring", async () => {
  await assertAuditFinding("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const FRIENDLY={requestFingerprint:'shared'};function mail({delivery:{requestFingerprint=FRIENDLY.requestFingerprint}={}}={}){return requestFingerprint}`,
  }, "friendly-test-default");
  await assertAuditClean("audit-test-defaults.mjs", {
    "tests/x.test.mjs": `const ADVERSE={requestFingerprint:''};function mail({delivery:{requestFingerprint=ADVERSE.requestFingerprint}={}}={}){return requestFingerprint}`,
  });
});

test("contract audit red-team round 3: understands Headers construction and mutation", async () => {
  const route = { "app/api/order/route.js": protectedRoute, "docs/idempotency-integrations.md": idempotencyDocs };
  await assertAuditFinding("audit-contract.mjs", {
    ...route,
    "app/page.jsx": `const headers=new Headers({'Content-Type':'application/json'});headers.set('X-Trace','one');fetch('/api/order',{method:'POST',headers,body:JSON.stringify({email:'a@b.c'})})`,
  }, "missing-idempotency-key");
  await assertAuditClean("audit-contract.mjs", {
    ...route,
    "app/page.jsx": `const base={'Content-Type':'application/json'};const headers=new Headers({...base});headers.set('Idempotency-Key','one');fetch('/api/order',{method:'POST',headers,body:JSON.stringify({email:'a@b.c'})})`,
  });
});

test("Lua audit adversarial scope round: nested pairs and ipairs preserve decoded taint", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local document = cjson.decode(ARGV[1])",
      "local buffer = {}",
      "for _, group in pairs(document.groups) do",
      "  for _, item in ipairs(group.items) do",
      "    local ok, encoded = pcall(cjson.encode, item)",
      "    if not ok then return 0 end",
      "    buffer[#buffer + 1] = encoded",
      "  end",
      "end",
      "redis.call('RPUSH', KEYS[1], unpack(buffer))",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit adversarial scope round: aliased multi-argument encode wrapper", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local function encodeWithPrefix(prefix, value)",
      "  local ok, encoded = pcall(cjson.encode, value)",
      "  if not ok then return nil end",
      "  return prefix .. encoded",
      "end",
      "local wrap = encodeWithPrefix",
      "local document = cjson.decode(ARGV[1])",
      "local stored = wrap('v1:', document)",
      "redis.call('SET', KEYS[1], stored)",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit adversarial scope round: same local name in isolated functions is clean", async () => {
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local function inspect(raw)",
      "  local record = cjson.decode(raw)",
      "  return record and record.kind",
      "end",
      "local function persistFresh()",
      "  local record = { value = ARGV[2] }",
      "  local ok, encoded = pcall(cjson.encode, record)",
      "  if not ok then return 0 end",
      "  redis.call('SET', KEYS[1], encoded)",
      "  return 1",
      "end",
      "inspect(ARGV[1])",
      "return persistFresh()",
      "`;",
    ].join("\n"),
  });
});

test("Lua audit adversarial scope round: independently created object may be encoded safely", async () => {
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local document = cjson.decode(ARGV[1])",
      "local observed = document and document.kind",
      "local fresh = { value = ARGV[2], observed = observed ~= nil }",
      "local ok, encoded = pcall(cjson.encode, fresh)",
      "if not ok then return 0 end",
      "redis.call('SET', KEYS[1], encoded)",
      "return 1",
      "`;",
    ].join("\n"),
  });
});

test("Lua audit adversarial scope round: encoded index buffer through wrapper is persisted", async () => {
  await assertAuditFinding("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local function safeEncode(value)",
      "  local ok, encoded = pcall(cjson.encode, value)",
      "  if not ok then return nil end",
      "  return encoded",
      "end",
      "local document = cjson.decode(ARGV[1])",
      "local buffer = {}",
      "for _, item in ipairs(document) do",
      "  buffer[#buffer + 1] = safeEncode(item)",
      "end",
      "redis.call('RPUSH', KEYS[1], unpack(buffer))",
      "`;",
    ].join("\n"),
  }, "lua-json-roundtrip");
});

test("Lua audit adversarial scope round: function boundaries do not absorb later call sites", async () => {
  await assertAuditClean("audit-lua-roundtrip.mjs", {
    "app/api/x.js": [
      "const SCRIPT = `",
      "local function identity(value)",
      "  if value == nil then return '' end",
      "  return value",
      "end",
      "local decoded = cjson.decode(ARGV[1])",
      "local ignored = identity(decoded.kind)",
      "local fresh = { value = ARGV[2] }",
      "local ok, encoded = pcall(cjson.encode, fresh)",
      "if not ok then return 0 end",
      "redis.call('SET', KEYS[1], encoded)",
      "return ignored",
      "`;",
    ].join("\n"),
  });
});

test("partial-failure audit does not let an unrelated function warning hide a bad collection", async () => {
  await assertAuditFinding("audit-partial-failure.mjs", {
    "app/api/x/route.js": `
      function parseRecord(raw) { if (raw === "bad") throw new Error("record_invalid"); return raw; }
      export function recordsFromIndex(rows) {
        console.warn("ignored a different cache warning");
        return rows.map((row) => parseRecord(row));
      }
    `,
  }, "partial-failure-map-parser-throw");
  await assertAuditClean("audit-partial-failure.mjs", {
    "app/api/x/route.js": `
      function parseRecord(raw) { if (raw === "bad") throw new Error("record_invalid"); return raw; }
      export function recordsFromIndex(rows) {
        const kept=[]; let corruptCount=0;
        for (const row of rows) { try { kept.push(parseRecord(row)); } catch { corruptCount += 1; } }
        if (corruptCount) console.warn("ignored corrupt records", { corruptCount });
        return kept;
      }
    `,
  });
});

test("partial-failure audit expands read contexts to GET, usersByEmail and backfill", async () => {
  for (const name of ["GET", "usersByEmail", "analyticsBackfill"]) {
    await assertAuditFinding("audit-partial-failure.mjs", {
      "app/api/x/route.js": `
        function parseStored(raw) { if (!raw) throw new Error("record_invalid"); return raw; }
        export function ${name}(records) { return records.map((record) => parseStored(record)); }
      `,
    }, "partial-failure-map-parser-throw");
  }
});

test("partial-failure audit requires pipeline length and per-command error checks", async () => {
  await withFixture({
    "app/api/x/route.js": `export async function recordsFromIndex(commands) { const response=await redisPipeline(commands); return response.map((row)=>row?.result); }`,
  }, (root) => {
    const result = runAudit("audit-partial-failure.mjs", root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[partial-failure-pipeline-shape\]/);
    assert.match(result.stdout, /\[partial-failure-pipeline-errors\]/);
  });
  await assertAuditClean("audit-partial-failure.mjs", {
    "app/api/x/route.js": `export async function recordsFromIndex(commands) { const response=await redisPipeline(commands); if(!Array.isArray(response)||response.length!==commands.length||response.some((row)=>row?.error))throw new Error("store_unavailable"); return response.map((row)=>row.result); }`,
  });
});

test("partial-failure audit catches swallowed pagination failure followed by completion marker", async () => {
  await assertAuditFinding("audit-partial-failure.mjs", {
    "app/api/x/route.js": `
      export async function analyticsBackfill() {
        let page=0;
        while(page<10){try{await readPage(page);page+=1}catch(error){console.warn(error);break}}
        await redisCmd(["SET","analytics:backfill:complete","1"]);
      }
    `,
  }, "partial-failure-backfill-completion");
  await assertAuditClean("audit-partial-failure.mjs", {
    "app/api/x/route.js": `export async function analyticsBackfill(){let page=0;while(page<10){try{await readPage(page);page+=1}catch(error){throw error}}await redisCmd(["SET","analytics:backfill:complete","1"])}`,
  });
});

test("partial-failure audit catches fixed-window starvation and accepts cleanup", async () => {
  await assertAuditFinding("audit-partial-failure.mjs", {
    "app/api/x/route.js": `
      export async function readRetryQueue(limit=30){
        const rows=await redisCmd(["LRANGE","retry","0",String(limit-1)]);
        return rows.map((raw)=>{try{return JSON.parse(raw)}catch{return null}}).filter(Boolean);
      }
    `,
  }, "partial-failure-fixed-window-starvation");
  await assertAuditClean("audit-partial-failure.mjs", {
    "app/api/x/route.js": `
      export async function readRetryQueue(limit=30){
        const rows=await redisCmd(["LRANGE","retry","0",String(limit-1)]);const kept=[];
        for(const raw of rows){try{kept.push(JSON.parse(raw))}catch{await redisCmd(["LREM","retry","1",raw])}}
        return kept;
      }
    `,
  });
});

test("partial-failure audit safety comment is rule-specific and adjacent", async () => {
  await assertAuditClean("audit-partial-failure.mjs", {
    "app/api/x/route.js": `export function readRows(rows){\n// audit-partial-failure: allow partial-failure-every-empty -- pre-write atomic integrity check\nreturn rows.every(Boolean)?rows:[]\n}`,
  });
  await assertAuditFinding("audit-partial-failure.mjs", {
    "app/api/x/route.js": `export function readRows(rows){\n// audit-partial-failure: allow partial-failure-silent-filter -- wrong rule\nreturn rows.every(Boolean)?rows:[]\n}`,
  }, "partial-failure-every-empty");
});

test("partial-failure audit classification cannot exempt a different node in the same function", async () => {
  await assertAuditFinding("audit-partial-failure.mjs", {
    "app/admin/MarketingCampaignPanel.jsx": `
      export function campaignActionFromPayload(rows) {
        if (rows.some((row) => !row || row.invalid)) return {};
        return { rows };
      }
    `,
  }, "partial-failure-predicate-abort");
});
