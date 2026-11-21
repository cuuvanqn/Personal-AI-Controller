import { jsonResponse, errorResponse } from "./common";
import { matchDaemonRoute } from "./lcg-routes";
import {
  getToolGroupsState,
  setToolGroupsEnabled,
  applyToolGroupPreset,
  TOOL_GROUP_IDS,
} from "../tool-groups";

/**
 * API bật/tắt nhóm MCP tools (Dashboard):
 * - GET  /api/tool-groups -> trạng thái các nhóm + tổng token ước lượng
 * - POST /api/tool-groups -> { group, enabled } hoặc { groups: { id: bool } }
 *   hoặc { preset: "all"|"minimal"|"code"|"fb" }
 *   Áp trực tiếp lên mọi phiên MCP đang sống (tools/list_changed).
 * Route KHÔNG nằm trong isPublicPath (đổi cấu hình máy chủ, cần xác thực).
 */
export async function handleToolGroupsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!matchDaemonRoute(url.pathname, "TOOL_GROUPS")) return null;

  if (req.method === "GET") {
    return jsonResponse(getToolGroupsState());
  }

  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return errorResponse("Body JSON không hợp lệ", 400);
    }

    if (body && typeof body.preset === "string") {
      try {
        const state = applyToolGroupPreset(body.preset);
        return jsonResponse({ ok: true, ...state });
      } catch (err: any) {
        return errorResponse(err.message, 400);
      }
    }

    const changes: Record<string, boolean> = {};
    if (body && typeof body === "object" && body.groups && typeof body.groups === "object") {
      for (const [id, enabled] of Object.entries(body.groups)) {
        if (!TOOL_GROUP_IDS.has(id)) return errorResponse(`Nhóm không tồn tại: ${id}`, 400);
        changes[id] = Boolean(enabled);
      }
    } else if (body && typeof body.group === "string") {
      if (!TOOL_GROUP_IDS.has(body.group)) {
        return errorResponse(`Nhóm không tồn tại: ${body.group}`, 400);
      }
      changes[body.group] = Boolean(body.enabled);
    } else {
      return errorResponse("Thiếu 'group' hoặc 'groups' trong body", 400);
    }

    const state = setToolGroupsEnabled(changes);
    return jsonResponse({ ok: true, ...state });
  }

  return errorResponse("Phương thức không được hỗ trợ", 405);
}
