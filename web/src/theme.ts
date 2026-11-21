import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

/**
 * Chủ đề Otter (Web) kế thừa Astryx Neutral:
 * - Chế độ tối dùng nền Slate Charcoal nhiều lớp rõ ràng (#121721 / #161C27 / #1C2331)
 * - Chữ chính #F8FAFC (>14:1) và chữ phụ #CBD5E1 (>8.5:1) dễ đọc sắc nét cả dấu tiếng Việt
 * - Điểm nhấn Signal Emerald (#22C55E / #4ADE80), không dùng tím
 */
export const otterTheme = defineTheme({
  name: "otter",
  extends: neutralTheme,
  color: {
    accent: ["#059669", "#22C55E"],
    neutralStyle: "cool",
    contrast: "high",
  },
  typography: {
    scale: { base: 15.5, ratio: 1.2 },
    heading: {
      family: "Space Grotesk",
      fallbacks: "system-ui, -apple-system, sans-serif",
    },
    body: {
      family: "IBM Plex Sans",
      fallbacks: "system-ui, -apple-system, sans-serif",
    },
    code: {
      family: "JetBrains Mono",
      fallbacks: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
  radius: { base: 4, multiplier: 1.2 },
  motion: { character: "crisp" },
  tokens: {
    "--color-background-body": ["#F1F5F9", "#121721"],
    "--color-background-surface": ["#FFFFFF", "#161C27"],
    "--color-background-card": ["#FFFFFF", "#1C2331"],
    "--color-background-popover": ["#FFFFFF", "#212A3A"],
    "--color-background-muted": ["#F8FAFC", "#1B2230"],
    "--color-text-primary": ["#0F172A", "#F8FAFC"],
    "--color-text-secondary": ["#334155", "#CBD5E1"],
    "--color-text-disabled": ["#64748B", "#94A3B8"],
    "--color-text-accent": ["#047857", "#4ADE80"],
    "--color-icon-primary": ["#0F172A", "#F8FAFC"],
    "--color-icon-secondary": ["#475569", "#CBD5E1"],
    "--color-border": ["rgba(15, 23, 42, 0.12)", "rgba(226, 232, 240, 0.16)"],
    "--color-border-emphasized": ["#94A3B8", "#64748B"],
  },
});
