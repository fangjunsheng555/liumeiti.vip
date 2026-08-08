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
    "From: Netflix <info@account.netflix.com>",
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
// messageId 没有默认值：每个用例必须显式声明投递身份，否则默认值会替代码
// 满足去重/关联条件，让用例失去意义。
function ingestRequest(raw, { messageId } = {}) {
  assert.equal(typeof messageId, "string", "用例必须显式提供 messageId");
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
      "x-email-envelope-from": "info@account.netflix.com",
      "x-email-envelope-to": INBOX,
      "x-email-message-id": messageId,
    },
    body,
  });
}

test("Cloudflare 投递的邮件能入库，并出现在后台收件记录里", async () => {
  const response = await webhook.POST(ingestRequest(netflixEmail(), { messageId: "<first@test>" }));
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
  const first = await webhook.POST(ingestRequest(raw, { messageId: "<dup-a@test>" }));
  assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
  const afterFirst = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(afterFirst, before + 1, "首次投递应新增一条记录");

  // 双路转发会把同一封邮件送两次，投递方可能给出不同的 Message-ID。
  // 按原始内容摘要去重，避免同一封邮件在后台出现两条。
  const second = await webhook.POST(ingestRequest(raw, { messageId: "<dup-b@test>" }));
  assert.equal(second.status, 202, JSON.stringify(await second.clone().json()));
  const afterSecond = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(afterSecond, afterFirst, "内容相同的重复投递不应再新增记录");
});

test("存储短暂故障后重投递仍能补录，不会永久丢记录", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = netflixEmail({ code: "7314", src: "SRC: 111111AC_bbbbbbbb-cccc-dddd-eeee-ffffffffffff_en_ES_EVO" });
  redis.state.failAll = true;
  const failed = await webhook.POST(ingestRequest(raw, { messageId: "<retry@test>" }));
  assert.notEqual(failed.status, 202, "存储故障时不应谎报成功");
  redis.state.failAll = false;
  const retried = await webhook.POST(ingestRequest(raw, { messageId: "<retry@test>" }));
  assert.equal(retried.status, 202, JSON.stringify(await retried.clone().json()));
  const after = (await store.listNetflixMailEvents({ limit: 100 })).length;
  assert.equal(after, before + 1, "重投递必须补录成功");
});

test("解析失败的邮件同样会留下记录，便于排查", async () => {
  const before = (await store.listNetflixMailEvents({ limit: 100 })).length;
  const raw = [
    "From: Netflix <info@account.netflix.com>",
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
  const response = await webhook.POST(ingestRequest(raw, { messageId: "<broken@test>" }));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const events = await store.listNetflixMailEvents({ limit: 100 });
  assert.equal(events.length, before + 1, "解析失败也必须留痕");
  assert.equal(events[0].accepted, false);
  assert.ok(events[0].reason, "应记录未采用的原因");
});
