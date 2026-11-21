import { useState } from "react";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { List, ListItem } from "@astryxdesign/core/List";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { Avatar } from "@astryxdesign/core/Avatar";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { GoogleLogo } from "../components/Icons";
import { useAuth, firebaseErrorMessage } from "../auth";
import { apiPost, fmtDate, type OAuthClientInfo } from "../api";

interface Props {
  oauthClients: OAuthClientInfo[] | null;
  busy: string | null;
  act: (key: string, fn: () => Promise<void>, okText?: string) => Promise<void>;
}

export default function SecurityAccountTab({ oauthClients, busy, act }: Props) {
  const { user, isLoading, signInGoogle, signInEmail, registerEmail, logout } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  async function runAuth(fn: () => Promise<void>) {
    setAuthError(null);
    setAuthBusy(true);
    try {
      await fn();
      setPassword("");
    } catch (err) {
      setAuthError(firebaseErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <VStack gap={6}>
      <PageHeader
        title="Tài khoản & Bảo mật"
        description="Đăng nhập tài khoản Firebase Otter và quản lý quyền truy cập OAuth 2.1 của từng ứng dụng AI."
      />

      <Grid columns={{ minWidth: 320, max: 2 }} gap={5} align="start">
        {/* Tài khoản Firebase */}
        <VStack gap={3}>
          <HStack justify="between" align="center" gap={2} wrap="wrap">
            <Heading level={2}>Tài khoản Firebase</Heading>
            <Badge
              variant={user ? "success" : "neutral"}
              label={user ? "Đã đăng nhập" : "Chưa đăng nhập"}
            />
          </HStack>

          <Card padding={5}>
            {isLoading ? (
              <Text type="supporting">Đang kiểm tra phiên đăng nhập…</Text>
            ) : user ? (
              <VStack gap={4}>
                <HStack gap={3} align="center">
                  <Avatar
                    src={user.photoURL || undefined}
                    name={user.displayName || user.email || "User"}
                    size="lg"
                  />
                  <VStack gap={0.5}>
                    <Text weight="semibold">{user.displayName || "Người dùng Otter"}</Text>
                    <Text type="supporting">{user.email}</Text>
                  </VStack>
                </HStack>
                <Divider />
                <Text type="supporting">
                  Otter là mã nguồn mở miễn phí (MIT). Tài khoản Firebase dùng để đồng bộ thông báo
                  cập nhật và các dịch vụ mở rộng của bạn.
                </Text>
                <HStack>
                  <Button
                    label="Đăng xuất"
                    variant="secondary"
                    size="sm"
                    isLoading={authBusy}
                    onClick={() => runAuth(logout)}
                  />
                </HStack>
              </VStack>
            ) : (
              <VStack gap={4}>
                <Text type="supporting">
                  Đăng nhập bằng Google hoặc email để liên kết tài khoản Otter của bạn.
                </Text>
                {authError && <Banner status="error" title={authError} />}
                <Button
                  label="Tiếp tục với Google"
                  variant="secondary"
                  size="md"
                  icon={<GoogleLogo size={18} />}
                  isLoading={authBusy}
                  onClick={() => runAuth(signInGoogle)}
                />
                <Divider label="hoặc dùng email" />
                <TextInput
                  label="Email"
                  type="email"
                  placeholder="ban@domain.com"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  isRequired
                />
                <TextInput
                  label="Mật khẩu"
                  type="password"
                  placeholder={mode === "register" ? "Tối thiểu 6 ký tự" : "Nhập mật khẩu"}
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  isRequired
                  onEnter={() =>
                    runAuth(() =>
                      mode === "login"
                        ? signInEmail(email, password)
                        : registerEmail(email, password)
                    )
                  }
                />
                <HStack gap={2} wrap="wrap">
                  <Button
                    label={mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
                    variant="primary"
                    size="md"
                    isDisabled={!email.trim() || !password}
                    isLoading={authBusy}
                    onClick={() =>
                      runAuth(() =>
                        mode === "login"
                          ? signInEmail(email, password)
                          : registerEmail(email, password)
                      )
                    }
                  />
                  <Button
                    label={mode === "login" ? "Tạo tài khoản mới" : "Đã có tài khoản"}
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setMode(mode === "login" ? "register" : "login");
                      setAuthError(null);
                    }}
                  />
                </HStack>
              </VStack>
            )}
          </Card>
        </VStack>

        {/* AI đã kết nối (OAuth 2.1) */}
        <VStack gap={3}>
          <HStack justify="between" align="center" gap={2}>
            <Heading level={2}>AI đã kết nối (OAuth 2.1)</Heading>
            <Badge variant="neutral" label={`${oauthClients?.length ?? 0} kết nối`} />
          </HStack>

          {oauthClients === null ? (
            <Card padding={4}>
              <EmptyState
                title="Chưa tải được danh sách OAuth"
                description="Kiểm tra kết nối tới daemon hoặc nhập Auth Token ở đầu trang."
              />
            </Card>
          ) : oauthClients.length === 0 ? (
            <Card padding={4}>
              <EmptyState
                title="Chưa có AI nào kết nối qua OAuth"
                description="Khi ChatGPT hoặc Claude kết nối bằng OAuth, chúng sẽ xuất hiện tại đây để bạn quản lý và thu hồi riêng từng ứng dụng."
              />
            </Card>
          ) : (
            <Card padding={0}>
              <List hasDividers edge="bleed">
                {oauthClients.map((c) => (
                  <ListItem
                    key={c.clientId}
                    label={c.clientName || c.clientId}
                    description={
                      <Text type="supporting">
                        {`${c.activeTokens} token hoạt động · cấp cuối ${fmtDate(c.lastIssuedAt)}`}
                      </Text>
                    }
                    endContent={
                      <Button
                        label="Thu hồi"
                        variant="destructive"
                        size="sm"
                        isLoading={busy === `revoke-${c.clientId}`}
                        onClick={() =>
                          act(
                            `revoke-${c.clientId}`,
                            async () => {
                              await apiPost("/api/oauth/revoke", { client_id: c.clientId });
                            },
                            `Đã thu hồi quyền của ${c.clientName || c.clientId}.`
                          )
                        }
                      />
                    }
                  />
                ))}
              </List>
            </Card>
          )}
        </VStack>
      </Grid>
    </VStack>
  );
}
