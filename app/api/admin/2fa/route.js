// 后台账号两步验证(TOTP)管理 — 每个后台账号管理自己的 2FA。
// GET 状态;POST {action:"begin"} 生成密钥;{action:"confirm",code} 确认启用(返回一次性备用码);
// {action:"disable",code} 用动态码/备用码验证后关闭。
import {
  adminSessionFromRequest, adminActorFromSession, pushAdminActionLog,
  generateTotpSecret, verifyTotp, encryptTotpSecret,
  getStaff2fa, setStaff2fa, clearStaff2fa, verifyStaff2faCode,
  generateBackupCodes, twoFaGloballyDisabled, redisCmd, clean, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";

function pendingKey(id) { return "lm:staff:2fa:pending:" + Number(id); }

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rec = await getStaff2fa(session.staffId);
  return Response.json({
    ok: true,
    enabled: Boolean(rec),
    enabledAtBeijing: rec?.enabledAtBeijing || "",
    remainingBackup: Array.isArray(rec?.backupHashes) ? rec.backupHashes.length : 0,
    globallyDisabled: twoFaGloballyDisabled(),
  });
}

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = String(body.action || "");
  const id = Number(session.staffId);
  const actor = adminActorFromSession(session);

  if (action === "begin") {
    if (await getStaff2fa(id)) return Response.json({ ok: false, error: "already_enabled" }, { status: 400 });
    const secret = generateTotpSecret();
    await redisCmd(["SET", pendingKey(id), secret, "EX", "900"]); // 15 分钟内完成绑定
    const label = encodeURIComponent(`冒央后台:${session.staffUsername || "admin"}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("liumeiti-admin")}&digits=6&period=30`;
    return Response.json({ ok: true, secret, otpauth });
  }

  if (action === "confirm") {
    const secret = await redisCmd(["GET", pendingKey(id)]);
    if (!secret) return Response.json({ ok: false, error: "no_pending" }, { status: 400 });
    if (!verifyTotp(secret, body.code)) return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
    const { codes, hashes } = generateBackupCodes();
    const now = new Date();
    await setStaff2fa(id, {
      secretEnc: encryptTotpSecret(secret),
      enabledAt: now.toISOString(),
      enabledAtBeijing: formatBeijingTime(now),
      backupHashes: hashes,
    });
    await redisCmd(["DEL", pendingKey(id)]);
    await pushAdminActionLog({ action: "2fa_enable", actor, target: "staff:" + id, detail: {} });
    // 备用码明文只返回这一次
    return Response.json({ ok: true, enabled: true, backupCodes: codes });
  }

  // 重新生成备用码(验证动态码后,旧备用码全部作废)
  if (action === "regen") {
    const rec = await getStaff2fa(id);
    if (!rec) return Response.json({ ok: false, error: "not_enabled" }, { status: 400 });
    const check = await verifyStaff2faCode(id, String(body.code || ""));
    if (!check.ok) return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
    const fresh = await getStaff2fa(id); // 若上面消耗了备用码,取最新记录
    const { codes, hashes } = generateBackupCodes();
    await setStaff2fa(id, { ...(fresh || rec), backupHashes: hashes });
    await pushAdminActionLog({ action: "2fa_backup_regen", actor, target: "staff:" + id, detail: {} });
    return Response.json({ ok: true, backupCodes: codes });
  }

  if (action === "disable") {
    const rec = await getStaff2fa(id);
    if (!rec) return Response.json({ ok: false, error: "not_enabled" }, { status: 400 });
    const check = await verifyStaff2faCode(id, String(body.code || ""));
    if (!check.ok) return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
    await clearStaff2fa(id);
    await pushAdminActionLog({ action: "2fa_disable", actor, target: "staff:" + id, detail: {} });
    return Response.json({ ok: true, enabled: false });
  }

  return Response.json({ ok: false, error: clean("bad_action", 40) }, { status: 400 });
}
