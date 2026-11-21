import { useState } from "react";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { useAuth, firebaseErrorMessage } from "../auth";

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
      <Section padding={8}>
        <VStack gap={4} maxWidth={520}>
          <Heading level={1}>Xin chào{user.displayName ? `, ${user.displayName}` : ""}</Heading>
          <Text>Bạn đang đăng nhập bằng {user.email}.</Text>
          <Text type="supporting">
            Tài khoản này dùng để nhận thông báo cập nhật và quản lý các dịch vụ Otter của bạn.
          </Text>
          <Button label="Đăng xuất" variant="secondary" onClick={() => logout()} />
        </VStack>
      </Section>
    );
  }

  return (
    <Section padding={8}>
      <VStack gap={5} maxWidth={520}>
        <VStack gap={2}>
          <Heading level={1}>{mode === "login" ? "Đăng nhập Otter" : "Tạo tài khoản Otter"}</Heading>
          <Text type="supporting">
            Đăng nhập để nhận thông báo khi có bản cập nhật mới và quản lý dịch vụ của bạn.
          </Text>
        </VStack>

        <Card>
          <VStack gap={4}>
            {error && <Banner status="error" title={error} />}
            <Button
              label="Tiếp tục với Google"
              variant="secondary"
              size="lg"
              isLoading={busy}
              onClick={() => run(signInGoogle)}
            />
            <Divider label="hoặc" />
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              isRequired
            />
            <TextInput
              label="Mật khẩu"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              isRequired
              onEnter={() =>
                run(() => (mode === "login" ? signInEmail(email, password) : registerEmail(email, password)))
              }
            />
            <Button
              label={mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
              variant="primary"
              size="lg"
              isLoading={busy}
              onClick={() =>
                run(() => (mode === "login" ? signInEmail(email, password) : registerEmail(email, password)))
              }
            />
            <Button
              label={
                mode === "login"
                  ? "Chưa có tài khoản? Tạo tài khoản mới"
                  : "Đã có tài khoản? Đăng nhập"
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
    </Section>
  );
}
