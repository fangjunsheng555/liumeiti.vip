import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adminLoginErrorMessage,
  adminRequestErrorMessage,
  installAdminUnauthorizedObserver,
  readAdminJson,
  rotateAdminRequestEpoch,
} from "../app/admin/admin-request-feedback.js";

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function declarationBody(source, name) {
  const markers = [`const ${name} =`, `async function ${name}`, `function ${name}`];
  const marker = markers.find((candidate) => source.indexOf(candidate) >= 0);
  const start = marker ? source.indexOf(marker) : -1;
  assert.notEqual(start, -1, `${name} must exist`);
  let open = -1;
  if (marker.startsWith("const ")) {
    const arrow = source.indexOf("=>", start);
    open = source.indexOf("{", arrow);
  } else {
    const paramsOpen = source.indexOf("(", start);
    let paramsDepth = 0;
    let paramsClose = -1;
    for (let index = paramsOpen; index < source.length; index += 1) {
      if (source[index] === "(") paramsDepth += 1;
      if (source[index] === ")") {
        paramsDepth -= 1;
        if (paramsDepth === 0) { paramsClose = index; break; }
      }
    }
    open = source.indexOf("{", paramsClose);
  }
  assert.ok(open > start, `${name} must have a body`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (["\"", "'", "`"].includes(char)) { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body is unterminated`);
}

for (const [status, expected] of [
  [401, /登录已失效/],
  [403, /没有执行/],
  [409, /其他管理员更新/],
  [500, /服务器处理异常/],
  [503, /服务暂时不可用/],
]) {
  test(`admin response ${status} has a readable Chinese retry outcome`, async () => {
    const error = await readAdminJson(response(status, { ok: false, error: `http_${status}` }))
      .then(() => null, (caught) => caught);
    assert.equal(error.responseStatus, status);
    assert.match(adminRequestErrorMessage(error, "测试操作"), expected);
  });
}

test("invalid JSON, network interruption and timeout are readable", async () => {
  const invalid = await readAdminJson({
    status: 200,
    ok: true,
    async json() { throw new SyntaxError("broken"); },
  }).then(() => null, (caught) => caught);
  assert.equal(invalid.code, "invalid_json");
  assert.match(adminRequestErrorMessage(invalid, "列表加载"), /无法解析的数据/);
  assert.match(adminRequestErrorMessage(new TypeError("offline"), "列表加载"), /检查网络后重试/);
  assert.match(adminRequestErrorMessage(Object.assign(new Error("late"), { name: "TimeoutError" }), "列表加载"), /超时.*停止等待.*重试/);
});

test("admin login never exposes raw error codes and bounds response parsing", async () => {
  assert.match(adminLoginErrorMessage(401, { error: "invalid_credentials" }), /账号或密码错误/);
  assert.match(adminLoginErrorMessage(401, { error: "invalid_2fa" }), /动态码错误/);
  assert.match(adminLoginErrorMessage(403, { error: "origin_forbidden" }), /没有执行.*后台登录.*权限/);
  assert.doesNotMatch(adminLoginErrorMessage(403, { error: "origin_forbidden" }), /origin_forbidden/);
  assert.match(adminLoginErrorMessage(503, { error: "session_store_unavailable" }), /暂时不可用/);
  assert.match(adminLoginErrorMessage(0, null, new SyntaxError("broken")), /无法解析的数据/);
  assert.match(adminLoginErrorMessage(0, null, Object.assign(new Error("late"), { name: "TimeoutError", code: "response_body_timeout" })), /超时/);
  assert.match(adminLoginErrorMessage(0, null, new TypeError("offline")), /检查网络后重试/);

  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const login = declarationBody(source, "doLogin");
  assert.match(login, /withClientDeadline\(res\.json\(\), 15_000, "response_body_timeout"\)/);
  assert.match(login, /res\.ok && data\?\.ok === true/);
  assert.match(login, /setLoginError\(adminLoginErrorMessage\(res\.status, data\)\)/);
  assert.match(login, /catch \(error\)[\s\S]*?adminLoginErrorMessage\(0, null, error\)/);
});

test("admin JSON parsing has its own deadline after response headers arrive", async () => {
  const pending = readAdminJson({
    status: 200,
    ok: true,
    json: () => new Promise(() => {}),
  }, { timeoutMs: 10 });
  const error = await pending.then(() => null, (caught) => caught);
  assert.equal(error?.name, "TimeoutError");
  assert.equal(error?.code, "response_body_timeout");
  assert.match(adminRequestErrorMessage(error, "列表加载"), /超时.*停止等待.*重试/);
});

test("protected admin 401 responses immediately cross the client session boundary", async () => {
  const seen = [];
  const target = {
    location: { href: "https://www.liumeiti.vip/admin", origin: "https://www.liumeiti.vip" },
    fetch: async () => response(401, { ok: false, error: "unauthorized" }),
  };
  const restore = installAdminUnauthorizedObserver((result) => seen.push(result.status), target);
  try {
    await target.fetch("/api/admin/users");
    assert.deepEqual(seen, [401]);
    await target.fetch("/api/admin/login", { method: "POST" });
    assert.deepEqual(seen, [401], "credential failures on the login endpoint are not session-revocation events");
  } finally {
    restore();
  }
});

test("a late 401 from the previous administrator cannot sign out the new session", async () => {
  let release;
  const seen = [];
  const target = {
    location: { href: "https://www.liumeiti.vip/admin", origin: "https://www.liumeiti.vip" },
    fetch: () => new Promise((resolve) => { release = resolve; }),
  };
  const restore = installAdminUnauthorizedObserver(() => seen.push("signed-out"), target);
  try {
    const pending = target.fetch("/api/admin/users");
    rotateAdminRequestEpoch();
    release(response(401, { ok: false, error: "unauthorized" }));
    await pending;
    assert.deepEqual(seen, []);
  } finally {
    restore();
  }
});

test("admin loaders and named mutations surface failures without replacing them with empty data", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  for (const name of [
    "loadGlobalLog", "loadWithdrawals", "loadCodes", "loadRedeemHistory",
    "loadStaff", "loadMailLogs", "loadMailTemplates", "loadAllUsers",
    "executeUserAction", "openWithdrawal", "saveMailTemplate", "deleteMailTemplate",
  ]) {
    const excerpt = declarationBody(source, name);
    assert.match(excerpt, /readAdminJson/, `${name} must reject HTTP and invalid JSON failures`);
    assert.match(excerpt, /catch\s*\(/, `${name} must surface network and timeout failures`);
  }
  assert.match(source, /const \[adminLoadErrors, setAdminLoadErrors\] = useState\(\{\}\)/);
  assert.match(source, /<AdminRetryAlert[\s\S]*?message=\{adminLoadErrors\.users\}/);
  assert.match(source, /adminLoadErrors\.users \? "用户数据未更新" : "暂无用户"/);
  assert.match(source, /adminLoadErrors\.withdrawals \? "提现数据未更新" : "暂无提现申请"/);
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /let actions = data\.actions \|\| \[\]/);
  assert.match(source, /showAdminLoadError\("staffActions", actionError, "操作日志加载"\)/);
  assert.match(source, /gError[\s\S]*?setGRetryToken\(\(value\) => value \+ 1\)/);
  assert.match(source, /userActionError && <div className="admin-alert error" role="alert">/);
  assert.match(source, /mailTemplateError[\s\S]*?onClick=\{loadMailTemplates\}/);
  assert.match(source, /const data = await readAdminJson\(res\);[\s\S]*?markPollFailure\("overview", new Error\(adminRequestErrorMessage/);
  assert.match(source, /const \[orderOpenError, setOrderOpenError\] = useState\(null\)/);
  assert.match(source, /message=\{orderOpenError\?\.message\}[\s\S]*?openOrder\(orderOpenError\.order\)/);
  assert.match(source, /pollState\.orders\.failures > 0 \? "订单数据未更新/);
  assert.match(source, /const adminLoadSequenceRef = useRef\(\{\}\)/);
  for (const key of ["balance", "withdrawals", "codes", "redeemHistory", "staff", "mailLogs", "mailTemplatesLoad", "users", "withdrawalDetail"]) {
    assert.match(source, new RegExp(`beginAdminLoadRequest\\("${key}"\\)`), `${key} must reject stale responses`);
    assert.match(source, new RegExp(`isCurrentAdminLoadRequest\\("${key}"`), `${key} must only let the latest request update UI`);
  }
  for (const [name, setter] of [
    ["loadGlobalLog", "setLogLoading"],
    ["loadWithdrawals", "setWithdrawalLoading"],
    ["loadCodes", "setCodesLoading"],
    ["loadRedeemHistory", "setRedeemHistoryLoading"],
    ["loadMailLogs", "setMailLoading"],
    ["loadAllUsers", "setUserListLoading"],
    ["openWithdrawal", "setWithdrawalBusy"],
  ]) {
    const body = declarationBody(source, name);
    assert.match(body, new RegExp(`finally \\{[\\s\\S]*?${setter}\\(false\\)`), `${name} must always release its loading state`);
  }
  assert.match(source, /finally \{\s*if \(isCurrentPollRequest\("overview", sequence\)\) setOverviewLoading\(false\)/);
});

test("system health never presents unloaded or stale sections as healthy empty data", async () => {
  const source = await readFile(new URL("../app/admin/SystemHealthPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /const EMPTY_LOADED_SECTIONS = \{[\s\S]*?health: false,[\s\S]*?incidents: false/);
  assert.match(source, /setLoadedSections\(\(previous\) => \(\{ \.\.\.previous, \.\.\.completed \}\)\)/);
  assert.match(source, /setLoadedSections\(\(previous\) => \(\{ \.\.\.previous, metrics: false \}\)\)/);
  assert.match(source, /setData\(\(previous\) => \(\{ \.\.\.previous, metrics: EMPTY_DATA\.metrics \}\)\)/);
  assert.match(source, /loadedSections\.health \? Number\(health\.counts\?\.error \|\| 0\) : "--"/);
  assert.match(source, /!loadedSections\.metrics \? \([\s\S]*不会显示上一统计区间的数据/);
  assert.match(source, /!loadedSections\.incidents[\s\S]*事故记录尚未加载/);
  assert.match(source, /loadedSections\.incidents && !incidents\.length[\s\S]*暂无事故记录/);
  assert.match(source, /function healthSectionFailure\(error\)[\s\S]*status === 500[\s\S]*服务器处理异常[\s\S]*status === 503[\s\S]*后台服务暂时不可用/);
  assert.match(source, /errors\[key\] = healthSectionFailure\(result\.reason\)/);
});

test("balance mutation distinguishes HTTP, invalid-body, timeout and network outcomes", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const adjust = declarationBody(source, "adjustBalance");
  assert.match(adjust, /if \(res\.ok && data\?\.ok\)/);
  assert.match(adjust, /Number\.isFinite\(nextBalance\)/);
  assert.match(adjust, /res\.status === 401[\s\S]*res\.status === 403[\s\S]*res\.status === 409[\s\S]*\[500, 503\]\.includes\(res\.status\)/);
  assert.match(adjust, /enterAdminSignedOutState\(msg\)/);
  assert.match(adjust, /操作结果尚未确认/);
  assert.match(adjust, /await refreshAfterAdjust\(\);\s*setBalResult\(\{ type: "success"/);
});

test("admin logout invalidates in-flight loaders and stale 401 responses are ignored", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const logout = declarationBody(source, "doLogout");
  const clearSession = declarationBody(source, "clearAdminSessionCache");
  const orders = declarationBody(source, "loadOrders");
  assert.match(logout, /clearAdminSessionCache\(\)[\s\S]*?setAuthed\(false\)/);
  assert.match(clearSession, /Object\.values\(pollControllersRef\.current\)[\s\S]*?controller\?\.abort/);
  assert.match(clearSession, /pollSequenceRef\.current\[key\] = Number\(pollSequenceRef\.current\[key\]/);
  assert.match(clearSession, /adminLoadSequenceRef\.current\[key\] = Number/);
  assert.match(clearSession, /loadUserRequestRef\.current \+= 1/);
  assert.match(clearSession, /mailTplBusyRef\.current = false/);
  assert.match(clearSession, /usdtCheckingRef\.current = false/);
  for (const reset of [
    /setOrderOpeningId\(""\)/,
    /setShowPwds\(\{\}\)/,
    /setBalForm\(\{ amount: "", reason: "" \}\)/,
    /setWithdrawalNote\(""\)/,
    /setStaffForm\(\{ username: "", password: "", role: "operator", remark: "" \}\)/,
    /setMailTplBusy\(false\)/,
    /setOrderDetailRefreshToken\(0\)/,
  ]) assert.match(clearSession, reset, "a new admin identity must not inherit busy or sensitive form state");
  assert.match(clearSession, /rotateAdminRequestEpoch\(\)/);
  assert.match(orders, /if \(res\.status === 401\) \{\s*if \(isCurrentPollRequest\("orders", sequence\)\)/);
  assert.match(source, /installAdminUnauthorizedObserver\(\(\) => \{[\s\S]*?enterAdminSignedOutState\("后台登录已失效/);
});

test("an owner-to-limited-staff login boundary clears privileged caches before rendering", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const clearSession = declarationBody(source, "clearAdminSessionCache");
  const login = declarationBody(source, "doLogin");
  const signedOut = declarationBody(source, "enterAdminSignedOutState");

  for (const assertion of [
    /setTab\("orders"\)/,
    /setCurrentStaff\(null\)/,
    /setAllUsers\(\{ users: \[\], total: 0 \}\)/,
    /setWithdrawals\(\[\]\)/,
    /setGlobalLog\(\{ entries: \[\]/,
    /setStaffPane\(\{ staff: \[\], actions: \[\] \}\)/,
    /setMailLogs\(\[\]\)/,
    /setMailTemplates\(\[\]\)/,
    /setUserInfo\(null\)/,
  ]) assert.match(clearSession, assertion);

  assert.match(login, /if \(res\.ok && data\?\.ok === true\) \{[\s\S]*?clearAdminSessionCache\(\)[\s\S]*?setCurrentStaff\(data\.staff \|\| null\)[\s\S]*?setAuthed\(true\)/);
  assert.match(signedOut, /clearAdminSessionCache\(\)[\s\S]*?setAuthed\(false\)/);
  assert.match(source, /const currentTabAllowed = navGroups\.some\([\s\S]*?item\.key === tab && item\.show/);
  assert.match(source, /!currentTabAllowed \? \([\s\S]*?当前后台账号没有访问该栏目权限/);
  assert.equal((source.match(/setAuthed\(false\)/g) || []).length, 2, "only the shared 401 boundary and verified logout may set signed-out state");

  for (const gate of [
    /tab === "users" && canViewUsers/,
    /tab === "withdrawals" && canReviewWithdrawals/,
    /tab === "codes" && canViewCodes/,
    /tab === "mail" && canSendMail/,
    /tab === "balance" && canViewBalanceLog/,
    /tab === "staff" && isRootStaff/,
    /tab === "health" && isRootStaff/,
    /tab === "settings" && isRootStaff/,
  ]) assert.match(source, gate, "privileged tab must be gated during the first render of a new staff session");
});

test("user detail, mail uncertainty and template mutations expose safe finite outcomes", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const loadUser = declarationBody(source, "loadUser");
  const sendMail = declarationBody(source, "sendCustomerMail");
  for (const name of ["saveMailTemplate", "deleteMailTemplate"]) {
    const body = declarationBody(source, name);
    assert.match(body, /beginAdminLoadRequest\("mailTemplatesMutation"\)/);
    assert.match(body, /beginAdminLoadRequest\("mailTemplatesLoad"\)/);
    assert.match(body, /isCurrentAdminLoadRequest\("mailTemplatesMutation", requestId\)/);
    assert.match(body, /mailTplBusyRef\.current = true/);
    assert.match(body, /mailTplBusyRef\.current = false/);
  }
  assert.match(loadUser, /const data = await readAdminJson\(res\)/);
  assert.match(loadUser, /adminRequestErrorMessage\(e, "用户详情加载"\)/);
  assert.match(source, /message=\{userError\}[\s\S]*?loadUser\(userModalTarget/);
  assert.match(sendMail, /if \(mailBusy \|\| mailSendUncertain\) return/);
  assert.match(sendMail, /setMailSendUncertain\(true\)/);
  assert.match(sendMail, /partialDelivery[\s\S]*?setMailSendUncertain\(true\)/);
  assert.match(sendMail, /res\.status >= 500 \|\| data\.uncertain === true[\s\S]*?setMailSendUncertain\(true\)/);
  assert.match(sendMail, /为避免重复发送[\s\S]*?邮件投递记录/);
  assert.match(source, /disabled=\{mailBusy \|\| mailSendUncertain\}/);
  assert.equal(
    (source.match(/const \[mailSendUncertain, setMailSendUncertain\] = useState\(false\);/g) || []).length,
    1,
    "mail uncertainty state must have exactly one declaration",
  );
});

test("bulk marketing sends lock after an uncertain response instead of restarting the batch", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  for (const name of ["sendMarketingMailToRegisteredUsers", "scheduleMarketingMailForEvenings"]) {
    const body = declarationBody(source, name);
    assert.match(body, /mailSendUncertain\) return/);
    assert.match(body, /uncertainResult/);
    assert.match(body, /unsafeToRepeat[\s\S]*?setMailSendUncertain\(true\)/);
    assert.match(body, /catch \(e\) \{[\s\S]*?setMailSendUncertain\(true\)/);
    assert.match(body, /已暂停再次提交/);
  }
  assert.match(source, /onClick=\{sendMarketingMailToRegisteredUsers\}[\s\S]*?disabled=\{[^}]*mailSendUncertain/);
  assert.match(source, /onClick=\{scheduleMarketingMailForEvenings\}[\s\S]*?disabled=\{[^}]*mailSendUncertain/);
  assert.match(source, /mailResult\.message/);
});

test("filterable admin panels only let the latest response own data and loading state", async () => {
  for (const file of [
    "AfterSalesPanel.jsx",
    "InsightsPanel.jsx",
    "VisitorsPanel.jsx",
    "MailDeliveryPanel.jsx",
    "AIQuotaPanel.jsx",
  ]) {
    const source = await readFile(new URL(`../app/admin/${file}`, import.meta.url), "utf8");
    assert.match(source, /beginLatestRequest/);
    assert.match(source, /isLatestRequest/);
    assert.match(source, /invalidateLatestRequest/);
    assert.match(source, /finally \{[\s\S]*?isLatestRequest\([^\n]+\)[^\n]+set[A-Za-z]*Loading\(false\)/);
  }

  for (const file of ["VisitorsPanel.jsx", "AbandonedPanel.jsx"]) {
    const source = await readFile(new URL(`../app/admin/${file}`, import.meta.url), "utf8");
    assert.match(source, /if \(![a-z]+\.ok \|\| ![a-z]+\?\.ok\)/);
    assert.match(source, /数据未更新/);
    assert.match(source, />重试<\/button>/);
  }
});

test("remaining editable admin panels reject stale reloads and never render failed loads as empty data", async () => {
  for (const file of ["AbandonedPanel.jsx", "CatalogPanel.jsx", "SettingsPanel.jsx", "AnnouncePostsPanel.jsx", "MarketingCampaignPanel.jsx"]) {
    const source = await readFile(new URL(`../app/admin/${file}`, import.meta.url), "utf8");
    assert.match(source, /beginLatestRequest/);
    assert.match(source, /isLatestRequest/);
    assert.match(source, /finally \{[\s\S]*?isLatestRequest\([\s\S]*?set[A-Za-z]*Loading\(false\)/);
  }

  const abandoned = await readFile(new URL("../app/admin/AbandonedPanel.jsx", import.meta.url), "utf8");
  assert.match(abandoned, /if \(loading \|\| busy\) return/);
  assert.match(abandoned, /disabled=\{loading \|\| Boolean\(busy\) \|\| !selected\.size\}/);

  for (const file of ["CatalogPanel.jsx", "SettingsPanel.jsx"]) {
    const source = await readFile(new URL(`../app/admin/${file}`, import.meta.url), "utf8");
    assert.match(source, /onClick=\{load\} disabled=\{saving \|\| loading(?: \|\| historyLoading)?(?: \|\| Boolean\(rollbackBusy\))?\}/);
    assert.match(source, /async function save\(\) \{\s*if \(saving \|\| loading(?: \|\| historyLoading)?(?: \|\| rollbackBusy)?\) return/);
  }

  const announcements = await readFile(new URL("../app/admin/AnnouncePostsPanel.jsx", import.meta.url), "utf8");
  assert.match(announcements, /disabled=\{busy \|\| loading\}/);
  assert.match(announcements, /msg\?\.type === "error" \? "公告数据未更新" : "暂无公告"/);

  const campaigns = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(campaigns, /const \[campaignsLoading, setCampaignsLoading\] = useState\(false\)/);
  assert.match(campaigns, /const \[campaignsError, setCampaignsError\] = useState\(""\)/);
  assert.match(campaigns, /campaignsError && campaigns\.length === 0[\s\S]*?当前空白不代表没有活动/);
});

test("rollback and uncertain non-idempotent admin actions stay locked until verification", async () => {
  const catalog = await readFile(new URL("../app/admin/CatalogPanel.jsx", import.meta.url), "utf8");
  const rollback = declarationBody(catalog, "rollback");
  assert.match(rollback, /historyLoading \|\| rollbackBusy/);
  assert.match(catalog, /onMouseDown=\{\(event\) => event\.target === event\.currentTarget && !rollbackBusy && setHistoryOpen\(false\)\}/);
  assert.match(catalog, /onClick=\{\(\) => setHistoryOpen\(false\)\} disabled=\{Boolean\(rollbackBusy\)\}/);
  for (const action of ["openHistory", "save"]) {
    assert.match(declarationBody(catalog, action), /rollbackBusy\) return/);
  }

  const announcements = await readFile(new URL("../app/admin/AnnouncePostsPanel.jsx", import.meta.url), "utf8");
  const saveAnnouncement = declarationBody(announcements, "save");
  assert.match(announcements, /const \[saveUncertain, setSaveUncertain\] = useState\(false\)/);
  assert.match(saveAnnouncement, /loading \|\| busy \|\| saveUncertain/);
  assert.match(saveAnnouncement, /setSaveUncertain\(true\)[\s\S]*?避免生成重复公告/);
  assert.match(announcements, /saveUncertain \? "结果待核对"/);

  const admin = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  const saveTemplate = declarationBody(admin, "saveMailTemplate");
  const sendCode = declarationBody(admin, "sendRedeemCodeEmail");
  assert.match(admin, /const \[mailTemplateSaveUncertain, setMailTemplateSaveUncertain\] = useState\(false\)/);
  assert.match(saveTemplate, /mailTplBusy \|\| mailTemplateSaveUncertain/);
  assert.match(saveTemplate, /setMailTemplateSaveUncertain\(true\)/);
  assert.match(admin, /mailTemplateSaveUncertain \? "结果待核对"/);
  assert.match(admin, /const \[sendCodeUncertain, setSendCodeUncertain\] = useState\(null\)/);
  assert.match(sendCode, /setSendCodeUncertain\(\{ code: sendCodeModal\.code, email \}\)/);
  assert.match(sendCode, /res\.status >= 500 \|\| data\.uncertain === true[\s\S]*?setSendCodeUncertain/);
  assert.match(sendCode, /为避免重复邮件/);
  assert.match(admin, /disabled=\{sendCodeBusy \|\| sendCodeRetryLocked\}/);
});

test("user activity failures render a finite retry state instead of disappearing", async () => {
  const source = await readFile(new URL("../app/admin/UserActivity.jsx", import.meta.url), "utf8");
  assert.match(source, /import \{ adminRequestErrorMessage, readAdminJson \}/);
  assert.match(source, /operation: fetch\([\s\S]*?\.then\(readAdminJson\)/);
  assert.match(source, /onError: \(caught\) => setError\(adminRequestErrorMessage\(caught, "用户访问数据加载"\)\)/);
  assert.match(source, /onFinally: \(\) => setLoading\(false\)/);
  assert.match(source, /if \(error && !d\) return \(/);
  assert.match(source, /setRetryToken\(\(value\) => value \+ 1\)/);
  assert.match(source, /settleLatestRequest/);
});

test("incident mutations share the finite request deadline and Chinese failure mapping", async () => {
  const source = await readFile(new URL("../app/admin/SystemHealthPanel.jsx", import.meta.url), "utf8");
  const mutation = source.slice(source.indexOf("const mutateIncident"), source.indexOf("const resolveIncident"));
  assert.match(mutation, /await requestJson\(`/);
  assert.doesNotMatch(mutation, /await fetch\(`/);
  assert.match(mutation, /request_timeout: "事故更新超时/);
  assert.match(mutation, /invalid_response: "事故更新失败，后台返回了无法解析的数据/);
  assert.match(mutation, /http_503: "事故更新失败，后台服务暂时不可用/);
  assert.match(mutation, /error\?\.responseStatus/);
  assert.match(mutation, /finally \{\s*setActing\(""\)/);
});

test("closing admin detail overlays invalidates late responses instead of reopening them", async () => {
  const visitors = await readFile(new URL("../app/admin/VisitorsPanel.jsx", import.meta.url), "utf8");
  const closeDetail = declarationBody(visitors, "closeDetail");
  assert.match(closeDetail, /invalidateLatestRequest\(detailRequestRef\)/);
  assert.match(closeDetail, /setDetailLoading\(false\)/);
  assert.match(closeDetail, /setDetail\(null\)/);
  assert.match(visitors, /onClick=\{closeDetail\}/);

  const campaigns = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  const viewStats = declarationBody(campaigns, "viewStats");
  const closeStats = declarationBody(campaigns, "closeStats");
  assert.match(campaigns, /const statsRequestRef = useRef\(0\)/);
  assert.match(viewStats, /beginLatestRequest\(statsRequestRef\)/);
  assert.match(viewStats, /isLatestRequest\(statsRequestRef, requestId\)/);
  assert.match(closeStats, /invalidateLatestRequest\(statsRequestRef\)/);
  assert.match(closeStats, /setSelectedStats\(null\)/);
  assert.match(campaigns, /onClick=\{closeStats\}/);
});
