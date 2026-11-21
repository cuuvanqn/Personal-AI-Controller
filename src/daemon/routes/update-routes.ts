import { jsonResponse, errorResponse } from "./common";
import { matchDaemonRoute } from "./lcg-routes";
import { getUpdateStatus, checkForUpdate, applyUpdate } from "../updater";

/**
 * API tự cập nhật daemon (Dashboard):
 * - GET  /api/update/status -> trạng thái cập nhật hiện tại
 * - POST /api/update/check  -> kiểm tra phiên bản mới ngay
 * - POST /api/update/apply  -> tải + tráo binary + khởi động lại (chỉ bản exe)
 * Các route KHÔNG nằm trong isPublicPath (cần xác thực như các API quản trị khác).
 */
export async function handleUpdateRoutes(req: Request, url: URL): Promise<Response | null> {
  if (matchDaemonRoute(url.pathname, "UPDATE_STATUS") && req.method === "GET") {
    return jsonResponse(getUpdateStatus());
  }

  if (matchDaemonRoute(url.pathname, "UPDATE_CHECK") && req.method === "POST") {
    const status = await checkForUpdate();
    return jsonResponse(status);
  }

  if (matchDaemonRoute(url.pathname, "UPDATE_APPLY") && req.method === "POST") {
    const status = getUpdateStatus();
    if (!status.isCompiledBinary) {
      return errorResponse(
        "Tự cập nhật chỉ áp dụng cho bản exe đã biên dịch. Bản dev hãy dùng git pull / bun run build:exe.",
        400
      );
    }
    // Trả phản hồi trước, áp dụng sau 300ms để client nhận được JSON
    // trước khi tiến trình khởi động lại.
    setTimeout(() => {
      applyUpdate().catch((err) => {
        console.warn(`[Updater] Áp dụng cập nhật thất bại: ${err.message}`);
      });
    }, 300);
    return jsonResponse({ ok: true, message: "Đang tải và áp dụng bản cập nhật, daemon sẽ khởi động lại..." });
  }

  return null;
}
