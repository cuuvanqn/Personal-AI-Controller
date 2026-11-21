import { useEffect, useState } from "react";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { Avatar } from "@astryxdesign/core/Avatar";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { useAuth } from "./auth";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Updates from "./pages/Updates";

type Route = "home" | "login" | "updates";

function routeFromHash(): Route {
  const h = window.location.hash;
  if (h.startsWith("#/login")) return "login";
  if (h.startsWith("#/updates")) return "updates";
  return "home";
}

function go(route: Route) {
  window.location.hash = route === "home" ? "#/" : `#/${route}`;
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const { user, isLoading, logout } = useAuth();

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <>
      <TopNav
        label="Điều hướng chính"
        heading={<TopNavHeading heading="🦦 Otter" headingHref="#/" />}
        startContent={
          <>
            <TopNavItem label="Trang chủ" href="#/" isSelected={route === "home"} />
            <TopNavItem label="Cập nhật" href="#/updates" isSelected={route === "updates"} />
          </>
        }
        endContent={
          isLoading ? null : user ? (
            <HStack gap={3}>
              <Avatar src={user.photoURL || undefined} name={user.displayName || user.email || "User"} size="sm" />
              <Text type="supporting">{user.displayName || user.email}</Text>
              <Button label="Đăng xuất" variant="ghost" size="sm" onClick={() => logout()} />
            </HStack>
          ) : (
            <Button label="Đăng nhập" variant="primary" size="sm" onClick={() => go("login")} />
          )
        }
      />
      {route === "home" && <Home />}
      {route === "login" && <Login />}
      {route === "updates" && <Updates />}
    </>
  );
}
