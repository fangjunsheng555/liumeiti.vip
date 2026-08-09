import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createNetflixIngestRedis } from "./helpers/netflix-ingest-redis-mock.mjs";

// 此前没有任何测试覆盖「Cloudflare 投递 → webhook 入库 → 后台收件记录 → 用户取码」
// 这条完整链路，导致入库一旦失效只能靠人工发现。以下用例把它固定下来。
const INGEST_SECRET = "netflix-ingest-secret-value-32-characters-long";
const ENCRYPTION_KEY = "netflix-code-encryption-key-32-characters-long";
const INBOX = "netflix@codes.liumeiti.vip";
const ACCOUNT = "member.forward@outlook.es";
const NETFLIX_SENDER = "info@account.netflix.com";
const NL = "\r\n";

const redis = createNetflixIngestRedis();
process.env.KV_REST_API_URL = redis.url;
process.env.KV_REST_API_TOKEN = redis.token;
process.env.NETFLIX_EMAIL_INGEST_SECRET = INGEST_SECRET;
process.env.NETFLIX_CODE_ENCRYPTION_KEY = ENCRYPTION_KEY;
process.env.AUTH_SECRET = "auth-secret-value-for-netflix-ingest-tests-32";
globalThis.fetch = redis.fetch;

const webhook = await import("../app/api/webhooks/netflix-email/route.js");
const store = await import("../app/api/netflix-code/_store.js");

function netflixEmail({ code = "8653", src = "SRC: 653956AC_aebc4b04-b480-42f1-b3a0-37bbe5d7ba6e_en_ES_EVO" } = {}) {
  const boundary = "----ingest-alt";
  const text = [
    "Enter this code to sign in",
    code,
    "Enter the code above on your device to sign in to Netflix. This code will expire in 15 minutes.",
    `This message was mailed to ${ACCOUNT} by Netflix as part of your Netflix membership.`,
    src,
  ].join(NL);
  return [
    `From: Netflix <${NETFLIX_SENDER}>`,
    `To: ${ACCOUNT}`,
    "Subject: Netflix: Your sign-in code",
    `Message-ID: <${code}-ingest@us-west-2.amazonses.com>`,
    "Date: Tue, 04 Aug 2026 04:22:49 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    `--${boundary}--`,
    "",
  ].join(NL);
}

// 与 cloudflare/netflix-email-worker.js 完全一致的签名方式。
// messageId 与 envelopeFrom 都没有默认值：它们决定去重身份与发件人是否可信，
// 一旦给了「友好默认值」，用例就会绕过真实判定而失去意义。
function ingestRequest(raw, { messageId, envelopeFrom } = {}) {
  assert.equal(typeof messageId, "string", "用例必须显式提供 messageId");
  assert.equal(typeof envelopeFrom, "string", "用例必须显式提供信封发件人");
  const body = Buffer.from(raw);
  const timestamp = String(Date.now());
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", INGEST_SECRET).update(`${timestamp}\n${digest}`).digest("base64url");
  return new Request("https://www.liumeiti.vip/api/webhooks/netflix-email", {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-email-timestamp": timestamp,
      "x-email-signature": signature,
      "x-email-envelope-from": envelopeFrom,
      "x-email-envelope-to": INBOX,
      "x-email-message-id": messageId,
    },
    body,
  });
}

test("Cloudflare 投递的邮件能入库，并出现在后台收件记录里", async () => {
  const response = await webhook.POST(ingestRequest(netflixEmail(), {
    messageId: "<first@test>",
    envelopeFrom: NETFLIX_SENDER,
  }));
  const data = await response.json();
  assert.equal(response.status, 202, JSON.stringify(data));
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(data.accepted, true, JSON.stringify(data));

  const events = await store.listNetflixMailEvents({ limit: 100 });
  assert.equal(events.length, 1, "后台收件记录应能读到刚入库的邮件");
  assert.equal(events[0].accepted, true);
  assert.equal(events[0].kind, "code");
  assert.ok(events[0].accountHints.length > 0);
});

test("入库后用户能取到验证码", async () => {
  const stateResult = await store.findLatestNetflixMailState(ACCOUNT, { since: Date.now() - 60_000 });
  assert.equal(stateResult.state, "result", JSON.stringify(stateResult));
  assert.equal(stateResult.result.kind, "code");
  assert.equal(stateResult.result.value, "8653");
});

test("同一封邮件重复投递按内容去重，只留一条记录", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = netflixEmail({ code: "2468", src: "SRC: 222222AC_dddddddd-1111-2222-3333-444444444444_en_ES_EVO" });
  const first = await webhook.POST(ingestRequest(raw, { messageId: "<dup-a@test>", envelopeFrom: NETFLIX_SENDER }));
  assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
  const afterFirst = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(afterFirst, before + 1, "首次投递应新增一条记录");

  // 双路转发会把同一封邮件送两次，投递方可能给出不同的 Message-ID。
  // 按原始内容摘要去重，避免同一封邮件在后台出现两条。
  const second = await webhook.POST(ingestRequest(raw, { messageId: "<dup-b@test>", envelopeFrom: NETFLIX_SENDER }));
  assert.equal(second.status, 202, JSON.stringify(await second.clone().json()));
  const afterSecond = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(afterSecond, afterFirst, "内容相同的重复投递不应再新增记录");
});

test("存储短暂故障后重投递仍能补录，不会永久丢记录", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = netflixEmail({ code: "7314", src: "SRC: 111111AC_bbbbbbbb-cccc-dddd-eeee-ffffffffffff_en_ES_EVO" });
  redis.state.failAll = true;
  const failed = await webhook.POST(ingestRequest(raw, { messageId: "<retry@test>", envelopeFrom: NETFLIX_SENDER }));
  assert.notEqual(failed.status, 202, "存储故障时不应谎报成功");
  redis.state.failAll = false;
  const retried = await webhook.POST(ingestRequest(raw, { messageId: "<retry@test>", envelopeFrom: NETFLIX_SENDER }));
  assert.equal(retried.status, 202, JSON.stringify(await retried.clone().json()));
  const after = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(after, before + 1, "重投递必须补录成功");
});

test("无法识别为 Netflix 的投递也会留痕，而不是静默消失", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = [
    `From: ${ACCOUNT}`,
    `To: ${INBOX}`,
    "Subject: Netflix code",
    "Message-ID: <flattened@outlook.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Enter this code to sign in",
    "8653",
    `This message was mailed to ${ACCOUNT}.`,
    "",
  ].join(NL);
  const response = await webhook.POST(ingestRequest(raw, {
    messageId: "<flattened@test>",
    envelopeFrom: ACCOUNT,
  }));
  const data = await response.json();
  assert.equal(response.status, 202, JSON.stringify(data));
  assert.notEqual(data.ignored, true, "被拒绝的投递不应再被静默丢弃");

  const events = await store.listNetflixMailEvents({ limit: 100 });
  assert.equal(events.length, before + 1, "无法识别的投递也必须留下记录");
  const refused = events.find((event) => event.reason === "untrusted_sender");
  assert.ok(refused, "应能在收件记录里找到这条被拒的投递");
  assert.equal(refused.accepted, false);
  assert.ok(refused.receivedAt, "记录必须带收件时间，否则会被校验判为无效");
  assert.ok(refused.expiresAt, "记录必须带有效期字段，否则整份列表会被判为不可读");
});

test("索引里出现一条坏记录时，其余记录依然可见", async () => {
  const healthy = await store.listNetflixMailEvents({ limit: 100 });
  assert.ok(healthy.length > 0, "前置条件：应已有正常记录");

  // 直接往索引里塞一条内容损坏的成员，模拟历史遗留或写入中断的数据。
  // 这类记录以前会让整份收件记录变成空列表。
  const brokenId = "NM" + "F".repeat(24);
  const auth = { headers: { Authorization: `Bearer ${redis.token}` } };
  await redis.fetch(`${redis.url}/ZADD/${encodeURIComponent("liumeiti:netflix-mail:received")}/${Date.now()}/${brokenId}`, auth);
  await redis.fetch(`${redis.url}/SET/${encodeURIComponent(`liumeiti:netflix-mail:event:${brokenId}`)}/${encodeURIComponent(JSON.stringify({ eventId: brokenId }))}`, auth);

  const afterBreak = await store.listNetflixMailEvents({ limit: 100 });
  assert.equal(afterBreak.length, healthy.length, "一条坏记录只应被跳过，不能让整个收件记录变空");
  assert.ok(!afterBreak.some((event) => event.eventId === brokenId), "坏记录本身不应出现在列表里");
});

test("Netflix preview reads past corrupt records that fill its requested window", async () => {
  const brokenId = "NM" + "E".repeat(24);
  const auth = { headers: { Authorization: `Bearer ${redis.token}` } };
  await redis.fetch(`${redis.url}/SET/${encodeURIComponent(`liumeiti:netflix-mail:event:${brokenId}`)}/${encodeURIComponent(JSON.stringify({ eventId: brokenId }))}`, auth);
  await redis.fetch(`${redis.url}/ZADD/${encodeURIComponent("liumeiti:netflix-mail:received")}/${Date.now() + 9_000_000}/${brokenId}`, auth);
  const preview = await store.listNetflixMailEvents({ limit: 1 });
  assert.equal(preview.length, 1);
  assert.notEqual(preview[0].eventId, brokenId);
});

test("解析失败的邮件同样会留下记录，便于排查", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = [
    `From: Netflix <${NETFLIX_SENDER}>`,
    `To: ${ACCOUNT}`,
    "Subject: Netflix: Your sign-in code",
    "Message-ID: <broken@us-west-2.amazonses.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Enter this code to sign in",
    "[image removed]",
    "This code will expire in 15 minutes.",
    "",
  ].join(NL);
  const response = await webhook.POST(ingestRequest(raw, {
    messageId: "<broken@test>",
    envelopeFrom: NETFLIX_SENDER,
  }));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const events = await store.listNetflixMailEvents({ limit: 100 });
  assert.equal(events.length, before + 1, "解析失败也必须留痕");
  const unparsed = events.find((event) => event.reason === "supported_content_not_found");
  assert.ok(unparsed, "应能找到这条解析失败的记录并说明原因");
  assert.equal(unparsed.accepted, false);
});

test("a corrupt record on the second storage page does not discard the first page", async () => {
  const seedResponse = await webhook.POST(ingestRequest(netflixEmail({
    code: "4444",
    src: "SRC: 444444AC_12345678-1234-1234-1234-1234567890ab_en_ES_EVO",
  }), {
    messageId: "<pagination-seed@test>",
    envelopeFrom: NETFLIX_SENDER,
  }));
  const seed = await seedResponse.json();
  assert.equal(seedResponse.status, 202, JSON.stringify(seed));
  const before = await store.listAllNetflixMailEvents();
  const dump = redis.dump();
  const seedRaw = dump.strings.get(`liumeiti:netflix-mail:event:${seed.eventId}`);
  assert.equal(typeof seedRaw, "string");
  const template = JSON.parse(seedRaw);
  const baseScore = Date.now() + 1_000_000;
  const commands = [];
  for (let index = 0; index < 205; index += 1) {
    const eventId = `NM${(0x100000 + index).toString(16).toUpperCase().padStart(24, "0")}`;
    const record = { ...template, eventId, receivedAt: new Date(baseScore + index).toISOString() };
    commands.push(["SET", `liumeiti:netflix-mail:event:${eventId}`, JSON.stringify(record)]);
    commands.push(["ZADD", "liumeiti:netflix-mail:received", String(baseScore + index), eventId]);
  }
  const brokenId = `NM${"D".repeat(24)}`;
  commands.push(["SET", `liumeiti:netflix-mail:event:${brokenId}`, JSON.stringify({ eventId: brokenId })]);
  commands.push(["ZADD", "liumeiti:netflix-mail:received", String(baseScore + 1.5), brokenId]);
  const seeded = await redis.fetch(`${redis.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${redis.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  assert.equal(seeded.status, 200);

  const after = await store.listAllNetflixMailEvents();
  assert.equal(after.length, before.length + 205);
  assert.equal(after.some((record) => record.eventId === brokenId), false);
  assert.equal(after.some((record) => record.eventId === template.eventId), true);
});
