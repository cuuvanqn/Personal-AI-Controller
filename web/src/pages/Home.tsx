import { useEffect, useState } from "react";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { List, ListItem } from "@astryxdesign/core/List";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Divider } from "@astryxdesign/core/Divider";
import { fetchVersions, componentLabel, type VersionRecord } from "../api";

/** Nhóm MCP tools thật của Otter daemon (theo tool-groups trong mã nguồn). */
const TOOL_GROUPS: Array<{ name: string; count: number; desc: string }> = [
  { name: "code", count: 13, desc: "Đọc, viết, chạy và kiểm thử mã nguồn ngay trong thư mục dự án của bạn." },
  { name: "browser", count: 15, desc: "Điều khiển Chrome qua CDP: mở trang, bấm, gõ, chụp màn hình, tải tệp." },
  { name: "desktop", count: 6, desc: "Chuột, bàn phím và cửa sổ ứng dụng trên Windows/macOS." },
  { name: "fb", count: 58, desc: "Facebook: bài viết, nhóm, bình luận, Marketplace, tin nhắn." },
  { name: "meta", count: 16, desc: "Instagram, Threads và Meta Ads qua một cổng thống nhất." },
  { name: "agents", count: 57, desc: "Nhiều AI cùng làm việc: giao việc, theo dõi tiến độ, chia sẻ bộ nhớ." },
  { name: "vps", count: 13, desc: "Quản lý máy chủ qua SSH: cài đặt, giám sát, sao lưu." },
  { name: "skills", count: 14, desc: "Kỹ năng đóng gói sẵn: tạo video, chuyển văn bản thành giọng nói..." },
  { name: "db", count: 10, desc: "Truy vấn và quản lý cơ sở dữ liệu SQLite cục bộ." },
  { name: "social", count: 8, desc: "Đăng bài và tương tác trên các mạng xã hội khác." },
];

const INSTALL_COMMANDS: Record<string, { label: string; code: string; language: string }> = {
  windows: {
    label: "Windows (PowerShell)",
    code: "irm https://otter.gpt.io.vn/setup.ps1 | iex",
    language: "powershell",
  },
  macos: {
    label: "macOS",
    code: "curl -fsSL https://otter.gpt.io.vn/setup.sh | bash",
    language: "bash",
  },
  linux: {
    label: "Linux",
    code: "curl -fsSL https://otter.gpt.io.vn/setup.sh | bash",
    language: "bash",
  },
};

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "Otter có miễn phí thật không?",
    a: "Có. Otter là mã nguồn mở (giấy phép MIT), chạy hoàn toàn trên máy của bạn ở cổng 1993 và không cần khóa bản quyền. Bạn chỉ cần tài khoản ChatGPT của chính mình.",
  },
  {
    q: "Otter có gửi dữ liệu của tôi đi đâu không?",
    a: "Daemon Otter chạy cục bộ trên máy bạn. ChatGPT chỉ gọi các công cụ bạn cho phép qua giao thức MCP, và mọi lệnh nhạy cảm đều đi qua lớp xác thực token của Otter.",
  },
  {
    q: "Tôi có cần cài tiện ích Chrome không?",
    a: "Không bắt buộc. Otter mặc định điều khiển trình duyệt qua CDP. Tiện ích Chrome là tùy chọn phụ cho ai muốn thanh HUD và panel phụ ngay trên trang ChatGPT.",
  },
  {
    q: "Otter hỗ trợ những AI nào?",
    a: "Bất kỳ AI nào hỗ trợ MCP đều kết nối được: ChatGPT, Claude, Gemini và các công cụ lập trình như Cursor hay VS Code. Đăng nhập bằng OAuth chuẩn MCP hoặc token Bearer.",
  },
  {
    q: "Làm sao biết có bản cập nhật mới?",
    a: "Otter tự kiểm tra cập nhật và thông báo trong Dashboard. Bạn cũng xem được toàn bộ lịch sử phiên bản ở mục Cập nhật trên trang này.",
  },
];

function LatestVersionBanner() {
  const [latest, setLatest] = useState<VersionRecord | null>(null);

  useEffect(() => {
    let alive = true;
    fetchVersions()
      .then((v) => {
        if (alive && v.length > 0) setLatest(v[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!latest) return null;
  return (
    <Banner
      status="info"
      title={`Bản mới: ${componentLabel(latest.component)} ${latest.version}`}
      description={<Text type="supporting">Xem chi tiết những gì thay đổi trong mục Cập nhật.</Text>}
      endContent={
        <Button label="Xem cập nhật" variant="secondary" size="sm" onClick={() => (window.location.hash = "#/updates")} />
      }
    />
  );
}

export default function Home() {
  const [os, setOs] = useState<string>("windows");
  const install = INSTALL_COMMANDS[os];

  return (
    <VStack gap={0}>
      {/* ── Hero ─────────────────────────────────────────────── */}
      <Section padding={8}>
        <VStack gap={5} maxWidth={760}>
          <HStack>
            <Badge variant="success" label="Miễn phí · Mã nguồn mở · Chạy trên máy của bạn" />
          </HStack>
          <Heading level={1} type="display-2">
            ChatGPT điều khiển máy tính của bạn
          </Heading>
          <Text type="large">
            Otter là trợ lý chạy ngay trên máy của bạn, kết nối ChatGPT với trình duyệt, terminal và
            desktop qua giao thức MCP. Bạn ra lệnh bằng tiếng Việt, Otter làm phần còn lại.
          </Text>
          <HStack gap={3}>
            <Button
              label="Cài đặt bằng 1 lệnh"
              variant="primary"
              size="lg"
              onClick={() => document.getElementById("cai-dat")?.scrollIntoView({ behavior: "smooth" })}
            />
            <Button
              label="Xem tính năng"
              variant="secondary"
              size="lg"
              onClick={() => document.getElementById("tinh-nang")?.scrollIntoView({ behavior: "smooth" })}
            />
          </HStack>
        </VStack>

        {/* UI thật của sản phẩm: bảng nhóm MCP tools của daemon */}
        <Card padding={0}>
          <VStack gap={0}>
            <HStack padding={4} gap={3} wrap="wrap">
              <Text weight="semibold">Otter Daemon · localhost:1993</Text>
              <Badge variant="success" label="Đang chạy" />
              <Badge variant="neutral" label="229 MCP tools" />
            </HStack>
            <Divider />
            <List hasDividers edge="bleed">
              {TOOL_GROUPS.slice(0, 6).map((g) => (
                <ListItem
                  key={g.name}
                  label={g.name}
                  description={<Text type="supporting">{g.desc}</Text>}
                  endContent={<Badge variant="neutral" label={`${g.count} tools`} />}
                />
              ))}
            </List>
          </VStack>
        </Card>
      </Section>

      <Section padding={4}>
        <LatestVersionBanner />
      </Section>

      {/* ── Cách hoạt động ───────────────────────────────────── */}
      <Section variant="muted" padding={8}>
        <VStack gap={5}>
          <Heading level={2}>Cách hoạt động</Heading>
          <List hasDividers edge="flush">
            <ListItem
              label="1 · Cài Otter trên máy của bạn"
              description={<Text type="supporting">Một lệnh duy nhất. Daemon chạy cục bộ ở cổng 1993, không cần khóa bản quyền.</Text>}
            />
            <ListItem
              label="2 · Kết nối ChatGPT qua MCP"
              description={<Text type="supporting">Thêm Otter làm MCP connector trong ChatGPT, đăng nhập bằng OAuth chuẩn MCP.</Text>}
            />
            <ListItem
              label="3 · Ra lệnh bằng tiếng Việt"
              description={<Text type="supporting">ChatGPT gọi các công cụ của Otter: duyệt web qua CDP, chạy terminal, sửa mã, điều khiển desktop.</Text>}
            />
          </List>
        </VStack>
      </Section>

      {/* ── Tính năng ────────────────────────────────────────── */}
      <Section padding={8}>
        <VStack gap={5}>
          <Heading level={2}>
            <span id="tinh-nang">229 công cụ, chia theo nhóm</span>
          </Heading>
          <Text>
            Mỗi nhóm bật tắt độc lập trong Dashboard, nên AI chỉ nạp những công cụ bạn cần —
            nhẹ ngữ cảnh, ít chọn nhầm.
          </Text>
          <List hasDividers edge="flush">
            {TOOL_GROUPS.map((g) => (
              <ListItem
                key={g.name}
                label={g.name}
                description={<Text type="supporting">{g.desc}</Text>}
                endContent={<Badge variant="neutral" label={`${g.count} tools`} />}
              />
            ))}
          </List>
        </VStack>
      </Section>

      {/* ── Cài đặt ──────────────────────────────────────────── */}
      <Section variant="muted" padding={8}>
        <VStack gap={5}>
          <Heading level={2}>
            <span id="cai-dat">Cài đặt trong 30 giây</span>
          </Heading>
          <SegmentedControl label="Hệ điều hành" value={os} onChange={setOs}>
            <SegmentedControlItem value="windows" label="Windows" />
            <SegmentedControlItem value="macos" label="macOS" />
            <SegmentedControlItem value="linux" label="Linux" />
          </SegmentedControl>
          <CodeBlock code={install.code} language={install.language} title={install.label} />
          <Text type="supporting">
            Muốn thanh HUD ngay trên trang ChatGPT? Tải thêm{" "}
            <a href="https://otter.gpt.io.vn/otter-extension.zip">tiện ích Chrome (tùy chọn)</a> —
            không bắt buộc, Otter mặc định dùng CDP.
          </Text>
        </VStack>
      </Section>

      {/* ── So sánh ──────────────────────────────────────────── */}
      <Section padding={8}>
        <VStack gap={5}>
          <Heading level={2}>Làm thủ công hay để Otter lo?</Heading>
          <List hasDividers edge="flush">
            <ListItem
              label="Duyệt web, điền biểu mẫu"
              description={<Text type="supporting">Thủ công: tự bấm từng bước. Với Otter: nói một câu, ChatGPT tự thao tác qua CDP.</Text>}
            />
            <ListItem
              label="Viết và sửa mã"
              description={<Text type="supporting">Thủ công: sao chép qua lại giữa ChatGPT và editor. Với Otter: AI đọc, sửa và chạy kiểm thử ngay trong dự án.</Text>}
            />
            <ListItem
              label="Quản lý nhiều tài khoản mạng xã hội"
              description={<Text type="supporting">Thủ công: mở từng ứng dụng. Với Otter: 74 công cụ Facebook, Instagram, Threads và Meta Ads trong một nơi.</Text>}
            />
            <ListItem
              label="Việc lặp lại mỗi ngày"
              description={<Text type="supporting">Thủ công: làm lại từ đầu. Với Otter: lưu thành kỹ năng, gọi lại bằng một câu lệnh.</Text>}
            />
          </List>
        </VStack>
      </Section>

      {/* ── FAQ ──────────────────────────────────────────────── */}
      <Section variant="muted" padding={8}>
        <VStack gap={4}>
          <Heading level={2}>Câu hỏi thường gặp</Heading>
          {FAQS.map((f) => (
            <Collapsible key={f.q} trigger={<Text weight="semibold">{f.q}</Text>} defaultIsOpen={false}>
              <Text>{f.a}</Text>
            </Collapsible>
          ))}
        </VStack>
      </Section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <Section padding={8}>
        <VStack gap={3}>
          <Text weight="semibold">🦦 Otter</Text>
          <Text type="supporting">
            Mã nguồn mở MIT · <a href="https://github.com/ptn1411/Otter">GitHub</a> ·{" "}
            <a href="https://www.facebook.com/groups/1131270302617994">Cộng đồng Otter</a> ·{" "}
            <a href="#/updates">Cập nhật</a>
          </Text>
          <Text type="supporting">Làm bởi Phạm Thanh Nam (@ptn1411) tại Việt Nam.</Text>
        </VStack>
      </Section>
    </VStack>
  );
}
