import { useState } from "react";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { Avatar } from "@astryxdesign/core/Avatar";
import { useAuth, firebaseErrorMessage } from "../auth";
import { GoogleLogo } from "../components/Icons";

export default function Login() {
  const { user, signInGoogle, signInEmail, registerEmail, logout } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      window.location.hash = "#/";
    } catch (err) {
      setError(firebaseErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <Section paddingBlock={10} paddingInline={6}>
        <div className="otter-wrap-auth">
          <Card padding={6}>
            <VStack gap={4}>
              <HStack gap={3} align="center">
                <Avatar
                  src={user.photoURL || undefined}
                  name={user.displayName || user.email || "User"}
                  size="lg"
                />
                <VStack gap={1}>
                  <Heading level={1}>
                    Xin chào{user.displayName ? `, ${user.displayName}` : ""}
                  </Heading>
                  <Text type="supporting">{user.email}</Text>
                </VStack>
              </HStack>
              <Text type="supporting">
                Tài khoản này dùng để nhận thông báo phát hành mới và quản lý các dịch vụ Otter
                của bạn.
              </Text>
              <HStack gap={3} wrap="wrap">
                <Button
                  label="Xem bản cập nhật"
                  variant="primary"
                  onClick={() => (window.location.hash = "#/updates")}
                />
                <Button label="Đăng xuất" variant="secondary" onClick={() => logout()} />
              </HStack>
            </VStack>
          </Card>
        </div>
      </Section>
    );
  }

  return (
    <Section paddingBlock={10} paddingInline={6}>
      <div className="otter-wrap-auth">
        <VStack gap={5}>
          <VStack gap={2}>
            <Heading level={1}>
              {mode === "login" ? "Đăng nhập Otter" : "Tạo tài khoản Otter"}
            </Heading>
            <Text type="supporting">
              Theo dõi các bản phát hành mới và quản lý kết nối Otter của bạn ở một nơi.
            </Text>
          </VStack>

          <Card padding={6}>
            <VStack gap={4}>
              {error && <Banner status="error" title={error} />}
              <Button
                label="Tiếp tục với Google"
                variant="secondary"
                size="lg"
                icon={<GoogleLogo size={18} />}
                isLoading={busy}
                onClick={() => run(signInGoogle)}
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
                  run(() =>
                    mode === "login" ? signInEmail(email, password) : registerEmail(email, password)
                  )
                }
              />
              <Button
                label={mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
                variant="primary"
                size="lg"
                isLoading={busy}
                onClick={() =>
                  run(() =>
                    mode === "login" ? signInEmail(email, password) : registerEmail(email, password)
                  )
                }
              />
              <Button
                label={
                  mode === "login"
                    ? "Chưa có tài khoản? Tạo tài khoản mới"
                    : "Đã có tài khoản? Quay lại đăng nhập"
                }
                variant="ghost"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
              />
            </VStack>
          </Card>
        </VStack>
      </div>
    </Section>
  );
}
