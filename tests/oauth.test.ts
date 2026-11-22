import { describe, expect, it, afterAll } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// OTTER_HOME tạm để test OAuth ghi DB riêng, không đụng cấu hình thật.
const prevOtterHome = process.env.OTTER_HOME;
process.env.OTTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "otter-oauth-legacy-"));

afterAll(() => {
  // Khôi phục env để không làm bẩn các file test khác khi chạy chung suite.
  if (prevOtterHome === undefined) delete process.env.OTTER_HOME;
  else process.env.OTTER_HOME = prevOtterHome;
});

import { handleOAuthRoutes } from "../src/daemon/routes/oauth-routes";
import { checkAuth } from "../src/daemon/routes/common";
import { setAuthToken, ensureAuthToken, isRequestAuthorized } from "../src/daemon/security";

describe("OAuth 2.0 / 2.1 Provider & Discovery Tests", () => {
  const testOrigin = "https://otter.example.com";

  it("serves RFC 9728 protected resource metadata at /.well-known/oauth-protected-resource", async () => {
    const req = new Request(`${testOrigin}/.well-known/oauth-protected-resource`, {
      method: "GET",
      headers: { host: "otter.example.com", "x-forwarded-proto": "https" }
    });
    const res = await handleOAuthRoutes(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.resource).toBe(testOrigin);
    expect(data.authorization_servers).toEqual([testOrigin]);
    expect(data.scopes_supported).toContain("all");
  });

  it("serves RFC 8414 metadata at /.well-known/oauth-authorization-server and openid-configuration", async () => {
    const req = new Request(`${testOrigin}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { host: "otter.example.com", "x-forwarded-proto": "https" }
    });
    const res = await handleOAuthRoutes(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(data.issuer).toBe(testOrigin);
    expect(data.authorization_endpoint).toBe(`${testOrigin}/oauth/authorize`);
    expect(data.token_endpoint).toBe(`${testOrigin}/oauth/token`);
    expect(data.client_id_metadata_document_supported).toBe(true);
    expect(data.authorization_response_iss_parameter_supported).toBe(true);
    expect(data.code_challenge_methods_supported).toContain("S256");
  });

  it("renders Consent Screen HTML on GET /oauth/authorize", async () => {
    const authUrl = `${testOrigin}/oauth/authorize?client_id=chatgpt_client&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&state=state123&response_type=code`;
    const req = new Request(authUrl, {
      method: "GET",
      headers: { host: "otter.example.com", "x-forwarded-proto": "https" }
    });
    const res = await handleOAuthRoutes(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");

    const html = await res!.text();
    expect(html).toContain("Cấp quyền kết nối Otter AI");
    expect(html).toContain("chatgpt_client");
    expect(html).toContain("Cho phép & Kết nối");
  });

  it("requires consent even for auto_approve requests from localhost", async () => {
    const origin = "http://localhost:1993";
    const redirectTarget = "https://chatgpt.com/aip/plugin-test/oauth/callback";
    const authUrl = `${origin}/oauth/authorize?client_id=chatgpt&redirect_uri=${encodeURIComponent(redirectTarget)}&state=xyzState&auto_approve=1`;
    const req = new Request(authUrl, { method: "GET", headers: { host: "localhost:1993" } });
    const res = await handleOAuthRoutes(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("location")).toBeNull();
    const html = await res!.text();
    expect(html).toContain("auth_token");
    expect(html).not.toContain("otter_code_");
  });

  it("ignores auto_approve=1 from public internet (shows consent screen instead)", async () => {
    const redirectTarget = "https://chatgpt.com/callback";
    const authUrl = `${testOrigin}/oauth/authorize?client_id=chatgpt&redirect_uri=${encodeURIComponent(redirectTarget)}&auto_approve=1`;
    const req = new Request(authUrl, {
      method: "GET",
      headers: { host: "otter.example.com", "x-forwarded-proto": "https" }
    });
    const res = await handleOAuthRoutes(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("auth_token");
  });

  it("exchanges authorization code for Bearer access token on POST /oauth/token", async () => {
    setAuthToken("otter_secret_token_12345");

    // 1. Tạo auth code qua consent POST (bản sửa bảo mật: bắt buộc nhập Auth Token)
    const redirectTarget = "https://chatgpt.com/callback";
    const authReq = new Request(`${testOrigin}/oauth/authorize`, {
      method: "POST",
      headers: {
        host: "otter.example.com",
        "x-forwarded-proto": "https",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: "chatgpt",
        redirect_uri: redirectTarget,
        scope: "all",
        auth_token: "otter_secret_token_12345"
      }).toString()
    });
    const authRes = await handleOAuthRoutes(authReq, new URL(authReq.url));
    expect(authRes!.status).toBe(302);
    const location = authRes!.headers.get("location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toMatch(/^otter_code_/);

    // 2. Đổi code lấy Access Token
    const tokenReq = new Request(`${testOrigin}/oauth/token`, {
      method: "POST",
      headers: {
        host: "otter.example.com",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectTarget,
        client_id: "chatgpt"
      }).toString()
    });

    const tokenRes = await handleOAuthRoutes(tokenReq, new URL(tokenReq.url));
    expect(tokenRes).not.toBeNull();
    expect(tokenRes!.status).toBe(200);

    const tokenData = await tokenRes!.json();
    // Bản sửa bảo mật: access token riêng từng client, KHÔNG phải token chủ.
    expect(tokenData.access_token).toMatch(/^otter_at_/);
    expect(tokenData.access_token).not.toBe("otter_secret_token_12345");
    expect(tokenData.token_type).toBe("Bearer");
    expect(tokenData.expires_in).toBeGreaterThan(0);
    expect(tokenData.refresh_token).toMatch(/^otter_rt_/);

    // Access token OAuth dùng được cho API qua isRequestAuthorized.
    const apiReq = new Request(`${testOrigin}/mcp`, {
      headers: { host: "otter.example.com", Authorization: `Bearer ${tokenData.access_token}` }
    });
    expect(isRequestAuthorized(apiReq, new URL(apiReq.url))).toBe(true);

    // 3. Mã code không thể tái sử dụng (Single-use security)
    const replayReq = new Request(`${testOrigin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectTarget
      })
    });
    const replayRes = await handleOAuthRoutes(replayReq, new URL(replayReq.url));
    expect(replayRes!.status).toBe(400);
    const errData = await replayRes!.json();
    expect(errData.error).toBe("invalid_grant");
  });

  it("validates PKCE S256 code challenge and verifier", async () => {
    // 1. Tạo PKCE verifier và challenge
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    // 2. Đăng ký auth code kèm PKCE challenge (qua consent POST + Auth Token)
    const redirectTarget = "https://chatgpt.com/callback";
    const authReq = new Request(`${testOrigin}/oauth/authorize`, {
      method: "POST",
      headers: {
        host: "otter.example.com",
        "x-forwarded-proto": "https",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: "chatgpt",
        redirect_uri: redirectTarget,
        scope: "all",
        code_challenge: challenge,
        code_challenge_method: "S256",
        auth_token: "otter_secret_token_12345"
      }).toString()
    });
    const authRes = await handleOAuthRoutes(authReq, new URL(authReq.url));
    expect(authRes!.status).toBe(302);
    const location = authRes!.headers.get("location")!;
    const code = new URL(location).searchParams.get("code")!;

    // 3. Thử đổi token với sai verifier -> Phải từ chối 400
    const failTokenReq = new Request(`${testOrigin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectTarget,
        code_verifier: "wrong_verifier_here"
      })
    });
    const failRes = await handleOAuthRoutes(failTokenReq, new URL(failTokenReq.url));
    expect(failRes!.status).toBe(400);
    const failData = await failRes!.json();
    expect(failData.error).toBe("invalid_grant");
  });

  it("returns 401 with WWW-Authenticate header advertising resource metadata", () => {
    setAuthToken("otter_secret_key");
    const unauthReq = new Request("https://otter.example.com/api/activity/v1/terminal/exec", {
      headers: { host: "otter.example.com" }
    });
    const res = checkAuth(unauthReq, new URL(unauthReq.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://otter.example.com/.well-known/oauth-protected-resource"');
  });

  it("supports RFC 7591 Dynamic Client Registration (DCR) on POST /oauth/register", async () => {
    const regReq = new Request(`${testOrigin}/oauth/register`, {
      method: "POST",
      headers: {
        host: "otter.example.com",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/callback"],
        token_endpoint_auth_method: "none"
      })
    });
    const res = await handleOAuthRoutes(regReq, new URL(regReq.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const data = await res!.json();
    expect(data.client_id).toMatch(/^otter_client_/);
    expect(data.client_name).toBe("ChatGPT");
    expect(data.redirect_uris).toEqual(["https://chatgpt.com/callback"]);
    expect(data.token_endpoint_auth_method).toBe("none");
  });
});

