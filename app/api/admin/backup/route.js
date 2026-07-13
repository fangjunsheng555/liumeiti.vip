import {
  adminSessionFromRequest,
  isRootAdminSession,
  pushAdminActionLog,
} from "../../_utils.js";
import { createCompleteBackup } from "../../_backup.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const backup = await createCompleteBackup();
    await pushAdminActionLog({
      action: "backup_export",
      actor: { staffId: Number(session.staffId || 1), staffUsername: session.staffUsername || "admin" },
      target: "backup",
      detail: { version: backup.version, keyCount: backup.keyCount, checksum: backup.checksum },
    }).catch(() => {});
    const stamp = backup.generatedAt.slice(0, 19).replace(/[T:]/g, "-");
    return new Response(JSON.stringify(backup), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="liumeiti-complete-backup-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || "backup_failed" }, { status: 500 });
  }
}
