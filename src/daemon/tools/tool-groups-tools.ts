import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getToolGroupsState,
  setToolGroupsEnabled,
  applyToolGroupPreset,
  TOOL_GROUP_IDS,
  TOOL_GROUP_PRESETS,
} from "../tool-groups";

/**
 * Tool hệ thống cho phép AI tự bật/tắt nhóm MCP tools theo nhu cầu,
 * để giảm token schema nạp vào context (xem tool-groups.ts).
 * Hai tool này được đăng ký NGOÀI cơ chế capture nhóm trong mcp.ts
 * nên luôn khả dụng — AI không tự khóa mình ra ngoài được.
 */
export function registerToolGroupsTools(mcp: McpServer, onActivity?: (event: any) => void): void {
  mcp.tool(
    "tool_groups_list",
    "Liệt kê các nhóm MCP tools của Otter (core, browser, code, fb, meta, vps, db, agents...) kèm trạng thái bật/tắt, số tool và ước lượng token schema của từng nhóm. Dùng để quyết định nên bật/tắt nhóm nào cho nhẹ context trước khi làm việc.",
    {},
    async () => {
      const state = getToolGroupsState();
      onActivity?.({ type: "tool_groups_list" });
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
      };
    }
  );

  mcp.tool(
    "tool_groups_set",
    "Bật/tắt nhóm MCP tools của Otter theo nhu cầu công việc. Thay đổi áp dụng ngay cho mọi phiên MCP đang kết nối (tool bị tắt biến mất khỏi danh sách tool). Có thể dùng preset: 'all' (bật tất cả), 'minimal' (core+browser), 'code' (core+code+agents+skills), 'fb' (core+browser+fb+meta). Hoặc bật/tắt từng nhóm bằng group+enabled, hoặc nhiều nhóm bằng groups. Sau khi đổi, hãy gọi lại tool_groups_list để xác nhận.",
    {
      preset: z
        .enum(["all", "minimal", "code", "fb"])
        .optional()
        .describe("Preset bật nhanh: all/minimal/code/fb. Ưu tiên hơn group/groups nếu có mặt."),
      group: z
        .string()
        .optional()
        .describe("Một nhóm cần bật/tắt, ví dụ: fb, code, browser, vps, meta, agents, db, gpm, social, antigravity, muse, skills, motion, desktop, core, external"),
      enabled: z.boolean().optional().describe("true = bật nhóm, false = tắt nhóm (đi kèm group)"),
      groups: z
        .record(z.string(), z.boolean())
        .optional()
        .describe("Bật/tắt nhiều nhóm cùng lúc, ví dụ: {\"fb\": false, \"code\": true}"),
    },
    async ({ preset, group, enabled, groups }) => {
      try {
        let state;
        if (preset) {
          state = applyToolGroupPreset(preset);
        } else if (groups && Object.keys(groups).length > 0) {
          for (const id of Object.keys(groups)) {
            if (!TOOL_GROUP_IDS.has(id)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Nhóm không tồn tại: ${id}. Các nhóm hợp lệ: ${[...TOOL_GROUP_IDS].join(", ")}`,
                  },
                ],
                isError: true,
              };
            }
          }
          state = setToolGroupsEnabled(groups);
        } else if (group) {
          if (!TOOL_GROUP_IDS.has(group)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Nhóm không tồn tại: ${group}. Các nhóm hợp lệ: ${[...TOOL_GROUP_IDS].join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          state = setToolGroupsEnabled({ [group]: enabled !== false });
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Thiếu tham số: cần một trong preset (${Object.keys(TOOL_GROUP_PRESETS).join("/")}), group+enabled, hoặc groups.`,
              },
            ],
            isError: true,
          };
        }
        onActivity?.({ type: "tool_groups_set", preset, group, enabled });
        return {
          content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
