function mapFor(container, key, factory) {
  if (!container) return factory();
  if (!container.has(key)) container.set(key, factory());
  return container.get(key);
}

function listFor(stores, key) {
  return mapFor(stores.lists, key, () => []);
}

function sortedSetFor(stores, key) {
  return mapFor(stores.sortedSets, key, () => new Map());
}

function hashFor(stores, key) {
  return mapFor(stores.hashes, key, () => new Map());
}

function setFor(stores, key) {
  return mapFor(stores.sets, key, () => new Set());
}

function listRemove(list, value) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index] === value) list.splice(index, 1);
  }
}

// Execute the observable semantics of app/api/_utils.js SET_ORDER_AT_SCRIPT.
// Unit suites use this adapter for their in-memory REST Redis; the actual Lua
// is additionally exercised against a real Redis-compatible server.
export function executeOrderCasEval(command, stores) {
  const script = String(command?.[1] || "");
  if (!script.includes("No command below can fail after the complete read/validation phase")) {
    return { handled: false, result: null };
  }
  const keyCount = Number(command[2] || 0);
  const keys = command.slice(3, 3 + keyCount);
  const args = command.slice(3 + keyCount);
  const absent = "__LM_ORDER_RECORD_ABSENT__";
  const current = stores.values.get(keys[0]);
  if ((args[0] === absent && current != null) || (args[0] !== absent && current !== args[0])) {
    return { handled: true, result: JSON.stringify({ ok: false, error: "stale_order" }) };
  }
  const legacyIndex = Number(args[2]);
  let baseRaw = current;
  if (legacyIndex >= 0) {
    const legacy = listFor(stores, keys[2])[legacyIndex];
    if (args[1] === absent || legacy !== args[1]) {
      return { handled: true, result: JSON.stringify({ ok: false, error: "stale_order" }) };
    }
    if (baseRaw == null) baseRaw = legacy;
  }

  const order = JSON.parse(args[3]);
  const orderId = args[4];
  const expectedRevision = Number(args[18]);
  const existing = args[19] === "1";
  if (existing) {
    const baseOrder = baseRaw == null ? null : JSON.parse(baseRaw);
    if (!baseOrder || Number(baseOrder.revision ?? 0) !== expectedRevision) {
      return { handled: true, result: JSON.stringify({ ok: false, error: "stale_order" }) };
    }
    if (Number(order.revision) !== expectedRevision + 1) {
      return { handled: true, result: JSON.stringify({ ok: false, error: "invalid_order_revision" }) };
    }
  } else if (baseRaw != null || Number(order.revision) !== 1) {
    return { handled: true, result: JSON.stringify({ ok: false, error: "stale_order" }) };
  }
  stores.values.set(keys[0], args[3]);
  const primary = listFor(stores, keys[1]);
  const membership = setFor(stores, keys[15]);
  if (!membership.has(orderId)) {
    membership.add(orderId);
    primary.push(orderId);
  }
  if (legacyIndex >= 0) listFor(stores, keys[2])[legacyIndex] = args[3];

  if (args[5] === "1") sortedSetFor(stores, keys[3]).set(orderId, Number(args[6]));
  else sortedSetFor(stores, keys[3]).delete(orderId);
  if (args[7] === "1") sortedSetFor(stores, keys[4]).set(orderId, Number(args[8]));
  else sortedSetFor(stores, keys[4]).delete(orderId);
  if (args[9] === "1") {
    hashFor(stores, keys[5]).set(orderId, args[10]);
    sortedSetFor(stores, keys[6]).set(orderId, Number(args[6]));
  } else {
    hashFor(stores, keys[5]).delete(orderId);
    sortedSetFor(stores, keys[6]).delete(orderId);
  }
  const revision = Number(stores.values.get(keys[7]) || 0) + 1;
  stores.values.set(keys[7], String(revision));

  if (args[11] === "1" && (args[12] !== "1" || keys[8] !== keys[9])) setFor(stores, keys[8]).delete(orderId);
  if (args[12] === "1") setFor(stores, keys[9]).add(orderId);
  if (args[13] === "1") setFor(stores, keys[10]).add(orderId);
  else setFor(stores, keys[10]).delete(orderId);

  for (let slot = 11; slot <= 12; slot += 1) {
    const oldEnabled = args[slot + 3] === "1";
    const nextSlot = slot + 2;
    const nextEnabled = args[nextSlot + 3] === "1";
    if (oldEnabled && (!nextEnabled || keys[slot] !== keys[nextSlot])) listRemove(listFor(stores, keys[slot]), orderId);
  }
  for (let slot = 13; slot <= 14; slot += 1) {
    if (args[slot + 3] === "1") {
      const list = listFor(stores, keys[slot]);
      if (!list.includes(orderId)) list.unshift(orderId);
    }
  }
  return { handled: true, result: JSON.stringify({ ok: true, listRevision: revision, order }) };
}
