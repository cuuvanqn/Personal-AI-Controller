import { useCallback, useEffect, useState } from "react";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { List, ListItem } from "@astryxdesign/core/List";
import { Switch } from "@astryxdesign/core/Switch";
import { TextInput } from "@astryxdesign/core/TextInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Markdown } from "@astryxdesign/core/Markdown";
import {
  apiGet,
  apiPost,
  initTokenFromUrl,
  setToken,
  ApiError,
  type HealthInfo,
  type TunnelInfo,
  type LicenseInfo,
  type ToolGroupsResponse,
  type UpdateStatus,
  type OAuthClientInfo,
} from "./api";

initTokenFromUrl();

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} giờ ${m} phút` : `${m} phút`;
}

function fmtDate(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("vi-VN");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [tunnel, setTunnel] = useState<TunnelInfo | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [fullAccess, setFullAccess] = useState<boolean | null>(null);
  const [toolGroups, setToolGroups] = useState<ToolGroupsResponse | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [oauthClients, setOauthClients] = useState<OAuthClientInfo[] | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, t, lic, fa, tg, upd, oc] = await Promise.all([
        apiGet<HealthInfo>("/health"),
        apiGet<TunnelInfo>("/api/system/tunnel").catch(() => null),
        apiGet<LicenseInfo>("/api/system/license").catch(() => null),
        apiGet<{ fullAccess: boolean }>("/api/system/security/full-access").catch(() => null),
        apiGet<ToolGroupsResponse>("/api/tool-groups").catch(() => null),
        apiGet<UpdateStatus>("/api/update/status").catch(() => null),
        apiGet<{ clients: OAuthClientInfo[] }>("/api/oauth/clients").catch(() => null),
      ]);
      setHealth(h);
      setTunnel(t);
      setLicense(lic);
      setFullAccess(fa?.fullAccess ?? null);
      setToolGroups(tg);
      setUpdate(upd);
      setOauthClients(oc?.clients ?? null);
      setNeedToken(tg === null && upd === null && oc === null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedToken(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  async function act(key: string, fn: () => Promise<void>, okText?: string) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice({ type: "success", text: okText });
      await load();
    } catch (err) {
      setNotice({ type: "error", text: err instanceof Error ? err.message : "Thao tác thất bại." });
    } finally {
      setBusy(null);
    }
  }

  const origin = window.location.origin;

  return (
    <>
      <TopNav
        label="Otter Dashboard"
        heading={<TopNavHeading heading="🦦 Otter Dashboard" headingHref="/dashboard" />}
        endContent={
          <HStack gap={2} wrap="wrap">
            {health ? (
              <Badge variant="success" label={`Online · v${health.version}`} />
            ) : (
              <Badge variant="warning" label="Đang kết nối…" />
            )}
            {license &&
              (license.licensed ? (
                <Badge variant="success" label={`Bản quyền: ${license.payload?.license_type?.toUpperCase() || "OK"}`} />
              ) : (
                <Badge variant="warning" label="Chưa kích hoạt" />
              ))}
            {fullAccess !== null &&
              (fullAccess ? (
                <Badge variant="success" label="Full Access" />
              ) : (
                <Badge variant="neutral" label="Giới hạn Workspace" />
              ))}
          </HStack>
        }
      />

      <VStack gap={0}>
        {notice && (
          <Section padding={4}>
            <Banner status={notice.type === "success" ? "success" : "error"} title={notice.text} isDismissable onDismiss={() => setNotice(null)} />
          </Section>
        )}

        {needToken && (
          <Section padding={4}>
            <Banner
              status="warning"
              title="Cần token xác thực để quản lý"
              description="Bạn đang truy cập từ ngoài mạng tin cậy. Nhập Auth Token của Otter (file ~/.otter/auth.token trên máy chạy daemon) để dùng các chức năng quản lý."
              endContent={
                <HStack gap={2}>
                  <TextInput label="Auth Token" type="password" value={tokenInput} onChange={setTokenInput} isLabelHidden />
                  <Button
                    label="Lưu token"
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setToken(tokenInput.trim());
                      setTokenInput("");
                      load();
                    }}
                  />
                </HStack>
              }
            />
          </Section>
        )}

        {/* ── Tổng quan ─────────────────────────────────────── */}
        <Section padding={6}>
          <VStack gap={4}>
            <Heading level={2}>Tổng quan</Heading>
            {!health ? (
              <HStack gap={3}>
                <Spinner />
                <Text>Đang tải trạng thái daemon…</Text>
              </HStack>
            ) : (
              <List hasDividers edge="flush">
                <ListItem label="Daemon" description={<Text type="supporting">{`Otter v${health.version} · cổng ${health.port} · chạy ${fmtUptime(health.uptime)} · ${health.platform}`}</Text>} />
                <ListItem
                  label="Mã thiết bị (Support Code)"
                  description={<Text type="supporting">{license?.supportCode || "—"}</Text>}
                  endContent={
                    license?.supportCode ? (
                      <Button label="Sao chép" size="sm" variant="ghost" onClick={() => copyText(license.supportCode)} />
                    ) : undefined
                  }
                />
                <ListItem
                  label="Quyền tệp tin & dự án"
                  description={
                    <Text type="supporting">
                      {fullAccess ? "Toàn quyền (Full Access) — AI truy cập mọi tệp trên máy." : "Giới hạn trong các workspace an toàn."}
                    </Text>
                  }
                  endContent={
                    fullAccess !== null ? (
                      <Switch
                        label="Full Access"
                        value={fullAccess}
                        isLabelHidden
                        isLoading={busy === "full-access"}
                        onChange={(v) =>
                          act("full-access", async () => {
                            await apiPost("/api/system/security/full-access", { enabled: v });
                          }, v ? "Đã bật Full Access." : "Đã tắt Full Access.")
                        }
                      />
                    ) : undefined
                  }
                />
                <ListItem
                  label="MCP servers ngoài"
                  description={<Text type="supporting">{`${health.externalMcpServers.connected}/${health.externalMcpServers.total} đang kết nối`}</Text>}
                />
              </List>
            )}
          </VStack>
        </Section>

        {/* ── Kết nối từ xa ─────────────────────────────────── */}
        <Section variant="muted" padding={6}>
          <VStack gap={4}>
            <Heading level={2}>Kết nối từ xa</Heading>

            <Card>
              <VStack gap={3}>
                <HStack gap={2} wrap="wrap">
                  <Text weight="semibold">Cloudflare Quick Tunnel</Text>
                  {tunnel?.status === "running" || tunnel?.url ? (
                    <Badge variant="success" label="Đang chạy" />
                  ) : (
                    <Badge variant="neutral" label="Chưa bật" />
                  )}
                </HStack>
                {tunnel?.url ? (
                  <>
                    <Text type="supporting">URL công khai hiện tại (dùng tạm, đổi mỗi lần bật lại):</Text>
                    <CodeBlock code={tunnel.url} language="plaintext" hasLanguageLabel={false} />
                    <HStack gap={2} wrap="wrap">
                      <Button label="Mở Tunnel" variant="primary" size="sm" onClick={() => window.open(tunnel.url!, "_blank", "noopener")} />
                      <Button label="Sao chép URL" size="sm" onClick={() => copyText(tunnel.url!)} />
                      <Button label="Sao chép MCP" size="sm" onClick={() => copyText(tunnel.mcpUrl || `${tunnel.url}/mcp`)} />
                      <Button
                        label="Dừng Tunnel"
                        variant="destructive"
                        size="sm"
                        isLoading={busy === "tunnel-stop"}
                        onClick={() => act("tunnel-stop", async () => { await apiPost("/api/system/tunnel/stop"); }, "Đã dừng Quick Tunnel.")}
                      />
                    </HStack>
                  </>
                ) : (
                  <>
                    <Text type="supporting">Bật để có domain HTTPS tạm thời, không cần cấu hình. Truy cập từ Internet luôn cần token/OAuth.</Text>
                    <HStack>
                      <Button
                        label="Bật Quick Tunnel"
                        variant="primary"
                        size="sm"
                        isLoading={busy === "tunnel-start"}
                        onClick={() => act("tunnel-start", async () => { await apiPost("/api/system/tunnel/start"); }, "Quick Tunnel đã sẵn sàng.")}
                      />
                    </HStack>
                  </>
                )}
                {tunnel?.error && <Text type="supporting">Lỗi gần nhất: {tunnel.error}</Text>}
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <HStack gap={2} wrap="wrap">
                  <Text weight="semibold">Tailscale</Text>
                  {health?.tailscaleIp ? <Badge variant="success" label={health.tailscaleIp} /> : <Badge variant="neutral" label="Không thấy" />}
                </HStack>
                {health?.tailscaleIp ? (
                  <>
                    <Text type="supporting">Truy cập an toàn qua mạng riêng Tailscale của bạn:</Text>
                    <CodeBlock code={`http://${health.tailscaleIp}:${health.port}`} language="plaintext" hasLanguageLabel={false} />
                    <HStack gap={2} wrap="wrap">
                      <Button label="Sao chép URL" size="sm" onClick={() => copyText(`http://${health.tailscaleIp}:${health.port}`)} />
                      <Button label="Sao chép MCP" size="sm" onClick={() => copyText(`http://${health.tailscaleIp}:${health.port}/mcp`)} />
                    </HStack>
                  </>
                ) : (
                  <Text type="supporting">Chưa phát hiện Tailscale trên máy này.</Text>
                )}
              </VStack>
            </Card>
          </VStack>
        </Section>

        {/* ── Nhóm MCP Tools ────────────────────────────────── */}
        <Section padding={6}>
          <VStack gap={4}>
            <Heading level={2}>Nhóm MCP Tools</Heading>
            <Text type="supporting">
              Tắt các nhóm không dùng để giảm token schema nạp vào AI mỗi phiên. Thay đổi áp dụng ngay cho các phiên MCP đang kết nối.
            </Text>
            {!toolGroups ? (
              <EmptyState title="Chưa tải được danh sách nhóm" description="Kiểm tra kết nối tới daemon hoặc nhập token ở phía trên." />
            ) : (
              <>
                <HStack gap={2} wrap="wrap">
                  <Badge variant="info" label={`${toolGroups.enabledTools}/${toolGroups.totalTools} tools đang bật`} />
                  <Badge variant="neutral" label={`~${fmtTokens(toolGroups.enabledEstTokens)} token schema`} />
                  <Badge variant="neutral" label={`${toolGroups.liveSessions} phiên MCP đang sống`} />
                </HStack>
                <HStack gap={2} wrap="wrap">
                  {[
                    { id: "all", label: "Bật tất cả" },
                    { id: "minimal", label: "Tối thiểu" },
                    { id: "code", label: "Chỉ Code" },
                    { id: "fb", label: "Chỉ Facebook" },
                  ].map((p) => (
                    <Button
                      key={p.id}
                      label={p.label}
                      size="sm"
                      variant="secondary"
                      isLoading={busy === `preset-${p.id}`}
                      onClick={() =>
                        act(`preset-${p.id}`, async () => {
                          const res = await apiPost<ToolGroupsResponse>("/api/tool-groups", { preset: p.id });
                          setToolGroups(res);
                        }, `Đã áp dụng preset “${p.label}”.`)
                      }
                    />
                  ))}
                </HStack>
                <List hasDividers edge="flush">
                  {toolGroups.groups.map((g) => (
                    <ListItem
                      key={g.id}
                      label={g.nameVi}
                      description={<Text type="supporting">{`${g.descVi} · ${g.toolCount} tools · ~${fmtTokens(g.estTokens)} token`}</Text>}
                      endContent={
                        <Switch
                          label={g.nameVi}
                          value={g.enabled}
                          isLabelHidden
                          isLoading={busy === `group-${g.id}`}
                          onChange={(v) =>
                            act(`group-${g.id}`, async () => {
                              const res = await apiPost<ToolGroupsResponse>("/api/tool-groups", { group: g.id, enabled: v });
                              setToolGroups(res);
                            })
                          }
                        />
                      }
                    />
                  ))}
                </List>
              </>
            )}
          </VStack>
        </Section>

        {/* ── Cập nhật ──────────────────────────────────────── */}
        <Section variant="muted" padding={6}>
          <VStack gap={4}>
            <Heading level={2}>Cập nhật Daemon</Heading>
            {!update ? (
              <EmptyState title="Chưa tải được trạng thái cập nhật" description="Kiểm tra kết nối tới daemon hoặc nhập token ở phía trên." />
            ) : (
              <VStack gap={3}>
                <HStack gap={2} wrap="wrap">
                  <Badge variant="neutral" label={`Hiện tại: v${update.currentVersion}`} />
                  {update.updateAvailable && update.latestVersion ? (
                    <Badge variant={update.mandatory ? "error" : "success"} label={`Có bản mới: v${update.latestVersion}${update.mandatory ? " (bắt buộc)" : ""}`} />
                  ) : (
                    <Badge variant="success" label="Đã là bản mới nhất" />
                  )}
                  {update.autoUpdateEnabled && <Badge variant="info" label="Tự động cập nhật: bật" />}
                </HStack>
                {update.lastCheckedAt && <Text type="supporting">Kiểm tra lần cuối: {fmtDate(update.lastCheckedAt)}</Text>}
                {update.lastError && <Text type="supporting">Lỗi kiểm tra gần nhất: {update.lastError}</Text>}
                {update.updateAvailable && update.changelog && <Markdown headingLevelStart={3}>{update.changelog}</Markdown>}
                <HStack gap={2} wrap="wrap">
                  <Button
                    label="Kiểm tra cập nhật"
                    size="sm"
                    isLoading={busy === "update-check"}
                    onClick={() =>
                      act("update-check", async () => {
                        const res = await apiPost<UpdateStatus>("/api/update/check");
                        setUpdate(res);
                      })
                    }
                  />
                  {update.updateAvailable && (
                    <Button
                      label="Cập nhật ngay"
                      variant="primary"
                      size="sm"
                      isLoading={busy === "update-apply"}
                      onClick={() =>
                        act("update-apply", async () => {
                          await apiPost("/api/update/apply");
                        }, "Đang cập nhật — daemon sẽ khởi động lại trong giây lát.")
                      }
                    />
                  )}
                </HStack>
              </VStack>
            )}
          </VStack>
        </Section>

        {/* ── AI đã kết nối (OAuth) ─────────────────────────── */}
        <Section padding={6}>
          <VStack gap={4}>
            <Heading level={2}>AI đã kết nối (OAuth)</Heading>
            <Text type="supporting">Các AI/ứng dụng đã được cấp quyền qua OAuth. Thu hồi sẽ ngắt kết nối của ứng dụng đó ngay lập tức.</Text>
            {oauthClients === null ? (
              <EmptyState title="Chưa tải được danh sách" description="Kiểm tra kết nối tới daemon hoặc nhập token ở phía trên." />
            ) : oauthClients.length === 0 ? (
              <EmptyState title="Chưa có AI nào kết nối qua OAuth" description="Khi bạn kết nối ChatGPT hoặc Claude qua OAuth, chúng sẽ xuất hiện tại đây." />
            ) : (
              <List hasDividers edge="flush">
                {oauthClients.map((c) => (
                  <ListItem
                    key={c.clientId}
                    label={c.clientName || c.clientId}
                    description={
                      <Text type="supporting">
                        {`${c.activeTokens} token đang hoạt động · cấp lần cuối ${fmtDate(c.lastIssuedAt)} · đăng ký ${fmtDate(c.createdAt)}`}
                      </Text>
                    }
                    endContent={
                      <Button
                        label="Thu hồi"
                        variant="destructive"
                        size="sm"
                        isLoading={busy === `revoke-${c.clientId}`}
                        onClick={() =>
                          act(`revoke-${c.clientId}`, async () => {
                            await apiPost("/api/oauth/revoke", { client_id: c.clientId });
                          }, `Đã thu hồi quyền của ${c.clientName || c.clientId}.`)
                        }
                      />
                    }
                  />
                ))}
              </List>
            )}
          </VStack>
        </Section>

        {/* ── Endpoints ─────────────────────────────────────── */}
        <Section variant="muted" padding={6}>
          <VStack gap={4}>
            <Heading level={2}>Điểm cuối kết nối</Heading>
            <CodeBlock
              code={`MCP (Streamable HTTP): ${origin}/mcp\nMCP (SSE):             ${origin}/sse\nWebSocket:             ws://${window.location.host}/api/activity/v1/stream`}
              language="plaintext"
              hasLanguageLabel={false}
            />
            <Text type="supporting">
              Tài liệu OpenAPI: <a href="/openapi.json" target="_blank" rel="noreferrer">/openapi.json</a> ·{" "}
              <a href="https://www.facebook.com/share/g/1CN8sjFYDH/?mibextid=wwXIfr" target="_blank" rel="noreferrer">
                Cộng đồng Otter
              </a>
            </Text>
          </VStack>
        </Section>
      </VStack>
    </>
  );
}
