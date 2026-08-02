import {
  verifyAdminLogin, signSession, setCookieValue, clearCookieValue,
  checkCriticalRateLimit, rateLimitResponse, pushAdminActionLog,
  clientIpFromRequest, clientUserAgentFromRequest,
  adminPermissionProfile,
  adminSessionFromRequest, getStaffKickState, reserveAdminSessionIssuance, revokeAdminSession,
  getStaff2faState, verifyStaff2faCode, twoFaGloballyDisabled, pushAdminLoginLog,
} from "../../_utils.js";

const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const AFTER_STABLE_SNAPSHOT_TEST_HOOK = Symbol.for("liumeiti.admin.login.after-stable-snapshot");
const AFTER_ISSUANCE_RESERVATION_TEST_HOOK = Symbol.for("liumeiti.admin.login.after-issuance-reservation");

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const username = String(body.username || "");
  const password = String(body.password || "");
  const otp = String(body.otp || "").trim();
  if (!username || username.length > 120 || !password || password.length > 256 || otp.length > 64) {
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }
  const ip = clientIpFromRequest(request);
  const userAgent = clientUserAgentFromRequest(request);
  const guard = await checkCriticalRateLimit(request, {
    namespace: "admin:login",
    identityLimit: 6,
    ipLimit: 40,
    windowSec: 15 * 60,
    identity: username,
  });
  if (!guard.ok) return rateLimitResponse(guard, "后台登录尝试过多，请稍后再试");

  let login = await verifyAdminLogin(username, password);
  if (!login.ok) {
    await pushAdminLoginLog({ username, ok: false, reason: "wrong_password", ip, userAgent });
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  // Bind the credential/permission snapshot to one stable revocation boundary.
  // If a password/role/permission update races this login, its atomic kick
  // changes the boundary and we re-read the employee instead of minting a
  // fresh JWT containing stale privileges.
  let kickState = await getStaffKickState(login.staff.id);
  let issuedAt = Date.now();
  if (!kickState.ok) {
    return Response.json({ ok: false, error: "session_store_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
    });
  }
  if (kickState.ok) {
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Keep one provisional candidate while pairing the credential and kick
      // snapshots. The authoritative iat is reserved atomically after 2FA;
      // this loop only avoids signing permissions already stale at the read.
      const candidateIssuedAt = Math.max(Date.now(), kickState.kickTs + 1);
      const rechecked = await verifyAdminLogin(username, password);
      if (!rechecked.ok || Number(rechecked.staff?.id) !== Number(login.staff.id)) {
        await pushAdminLoginLog({ username, staffId: login.staff.id, ok: false, reason: "credentials_changed", ip, userAgent });
        return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
      }
      const nextKick = await getStaffKickState(rechecked.staff.id);
      if (!nextKick.ok) {
        return Response.json({ ok: false, error: "session_store_unavailable" }, {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5" },
        });
      }
      login = rechecked;
      if (nextKick.kickTs === kickState.kickTs && nextKick.kickTs < candidateIssuedAt) {
        kickState = nextKick;
        issuedAt = candidateIssuedAt;
        stable = true;
        break;
      }
      kickState = nextKick;
    }
    if (!stable) {
      return Response.json({ ok: false, error: "session_state_changed" }, {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "1" },
      });
    }
  }

  // Direct route tests can deterministically place a mutation in the otherwise
  // unobservable final-GET/sign gap. HTTP-created Request objects cannot carry
  // this symbol property.
  const afterStableSnapshot = request?.[AFTER_STABLE_SNAPSHOT_TEST_HOOK];
  if (typeof afterStableSnapshot === "function") {
    await afterStableSnapshot({ staffId: Number(login.staff.id), issuedAt, kickTs: Number(kickState.kickTs || 0) });
  }

  // 两步验证:该账号已绑定 TOTP 时,要求动态码(或一次性备用码)。
  // env ADMIN_2FA_DISABLE=1 为紧急兜底,全局跳过 2FA(防丢手机锁死)。
  if (!twoFaGloballyDisabled()) {
    const twoFaState = await getStaff2faState(login.staff.id);
    if (!twoFaState.ok) {
      return Response.json({ ok: false, error: "two_factor_store_unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      });
    }
    if (twoFaState.exists) {
      if (!otp) {
        return Response.json({ ok: false, need2fa: true, error: "need_2fa" }, { status: 401 });
      }
      const otpGuard = await checkCriticalRateLimit(request, {
        namespace: "admin:2fa",
        identityLimit: 8,
        ipLimit: 40,
        windowSec: 15 * 60,
        identity: username,
      });
      if (!otpGuard.ok) return rateLimitResponse(otpGuard, "动态码尝试过多，请稍后再试");
      const check = await verifyStaff2faCode(login.staff.id, otp);
      if (!check.ok) {
        if (check.storageError) {
          return Response.json({ ok: false, error: "two_factor_store_unavailable" }, {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "5" },
          });
        }
        await pushAdminLoginLog({ username, staffId: login.staff.id, ok: false, reason: "wrong_2fa", ip, userAgent });
        return Response.json({ ok: false, need2fa: true, error: "invalid_2fa" }, { status: 401 });
      }
    }
  }

  if (kickState.ok) {
    // This is the authoritative final boundary. Redis compares the exact kick
    // value observed above and reserves an issuance fence in one script. A
    // mutation that commits before this script makes the CAS fail; a mutation
    // that commits after it must advance kick to at least the reserved iat.
    const reserved = await reserveAdminSessionIssuance(login.staff.id, kickState.kickTs, issuedAt);
    if (!reserved.ok) {
      return Response.json({ ok: false, error: reserved.error === "session_state_changed" ? "session_state_changed" : "session_store_unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": reserved.error === "session_state_changed" ? "1" : "5" },
      });
    }
    issuedAt = reserved.issuedAt;
    kickState = { ...kickState, kickTs: reserved.kickTs };
  }

  const afterIssuanceReservation = request?.[AFTER_ISSUANCE_RESERVATION_TEST_HOOK];
  if (typeof afterIssuanceReservation === "function") {
    await afterIssuanceReservation({ staffId: Number(login.staff.id), issuedAt, kickTs: Number(kickState.kickTs || 0) });
  }

  const sessionPayload = {
    role: "admin",
    staffId: login.staff.id,
    staffUsername: login.staff.username,
    staffRole: login.staff.role || (login.staff.root ? "owner" : "operator"),
    staffRoot: Boolean(login.staff.root),
    staffPerms: login.staff.perms || undefined, // 细粒度权限覆盖(登录时嵌入,改权限后踢下线重登生效)
    iat: issuedAt, // 签发时间:配合 lm:staff:kick:<id> 实现强制下线
    exp: Date.now() + ADMIN_SESSION_SECONDS * 1000,
  };
  const token = signSession(sessionPayload);
  const staff = {
    ...login.staff,
    role: sessionPayload.staffRole,
    root: Boolean(login.staff.root),
    permissions: adminPermissionProfile(sessionPayload),
  };
  await pushAdminActionLog({
    action: "admin_login",
    actor: { staffId: login.staff.id, staffUsername: login.staff.username },
    target: "staff:" + login.staff.id,
    detail: { ip, userAgent },
  });
  await pushAdminLoginLog({ username: login.staff.username, staffId: login.staff.id, ok: true, reason: "", ip, userAgent });
  return Response.json({ ok: true, staff }, {
    headers: { "Set-Cookie": setCookieValue("lm_admin", token, ADMIN_SESSION_SECONDS) },
  });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, {
      status: 401,
      headers: { "Set-Cookie": clearCookieValue("lm_admin") },
    });
  }
  const revoked = await revokeAdminSession(session.staffId, session.iat);
  if (!revoked.ok) {
    if (revoked.error === "session_revoked") {
      return Response.json({ ok: false, error: "session_revoked" }, {
        status: 401,
        headers: { "Set-Cookie": clearCookieValue("lm_admin"), "Cache-Control": "no-store" },
      });
    }
    // Do not clear the only browser copy until the durable global revocation
    // has succeeded. The client may safely retry this idempotent logout.
    return Response.json({ ok: false, error: "session_revocation_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
    });
  }
  return Response.json({ ok: true, revoked: true }, {
    headers: { "Set-Cookie": clearCookieValue("lm_admin") },
  });
}
