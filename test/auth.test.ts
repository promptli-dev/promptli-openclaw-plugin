import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserLogin, loadTokenSource, OAuthToken, pkce, readCredentialFile, saveCredentialFile } from "../src/auth.js";
import { tokenFetch } from "../src/client.js";

const tmp = () => mkdtempSync(join(tmpdir(), "promptli-auth-"));

describe("credentials", () => {
  it("writes credential files with mode 600 and reads keys back", () => {
    const p = join(tmp(), "credentials");
    saveCredentialFile(p, { api_key: "psk_test_abc" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const src = loadTokenSource({ path: p });
    expect(src?.kind).toBe("api_key");
  });

  it("env PROMPTLI_API_KEY wins", async () => {
    process.env.PROMPTLI_API_KEY = "psk_test_env";
    try {
      expect(await loadTokenSource({ path: "/nonexistent" })!.token()).toBe("psk_test_env");
    } finally {
      delete process.env.PROMPTLI_API_KEY;
    }
  });

  it("refreshes an expired browser login and persists the rotated token", async () => {
    const p = join(tmp(), "credentials");
    saveCredentialFile(p, { oauth: { client_id: "c", refresh_token: "r0", base_url: "http://api.test", access_token: "", expires_at: 0 } });
    const bodies: string[] = [];
    const src = loadTokenSource({
      path: p,
      fetch: (async (_u: unknown, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }));
      }) as any,
    })!;
    expect(src.kind).toBe("browser_login");
    const [a, b] = await Promise.all([src.token(), src.token()]);
    expect(a).toBe("a1");
    expect(b).toBe("a1");
    expect(bodies).toHaveLength(1); // concurrent callers share one refresh
    expect(bodies[0]).toContain("grant_type=refresh_token");
    expect((readCredentialFile(p)!.oauth as any).refresh_token).toBe("r1");
  });

  it("a revoked login says how to fix it", async () => {
    const t = new OAuthToken(
      { client_id: "c", refresh_token: "r", base_url: "http://api.test", access_token: "", expires_at: 0 },
      { fetch: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as any },
    );
    await expect(t.token()).rejects.toMatchObject({ code: "login_expired" });
  });

  it("tokenFetch injects the current token and retries a 401 once after refresh", async () => {
    let token = "t1";
    const auth = { kind: "browser_login" as const, token: async () => token, invalidate: () => void (token = "t2") };
    const seen: string[] = [];
    const f = tokenFetch(auth, (async (_u: unknown, init: RequestInit) => {
      const h = new Headers(init.headers).get("authorization")!;
      seen.push(h);
      return new Response("{}", { status: h === "Bearer t1" ? 401 : 200 });
    }) as any);
    const res = await f("http://api.test/v1/whoami", { headers: { Authorization: "Bearer placeholder" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });
});

describe("browser login (PKCE, loopback)", () => {
  it("runs discovery, registration, the loopback callback and the code exchange", async () => {
    const { verifier, challenge } = pkce();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toContain("=");
    const calls: string[] = [];
    let authorizeUrl = "";
    const f = (async (u: string, init: RequestInit = {}) => {
      const url = new URL(u);
      calls.push(`${init.method ?? "GET"} ${url.pathname}`);
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({ authorization_endpoint: "http://console.test/oauth/authorize", token_endpoint: "http://api.test/oauth/token", registration_endpoint: "http://api.test/oauth/register" });
      if (url.pathname === "/oauth/register") return json({ client_id: "cli_1" });
      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("code")).toBe("code123");
        expect(body.get("code_verifier")).toBeTruthy();
        return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
      }
      if (url.pathname === "/v1/whoami") return json({ identity: { handle: "glow" }, env: "test" });
      return new Response("{}", { status: 404 });
    }) as any;
    const cred = await browserLogin({
      baseUrl: "http://api.test",
      clientName: "test",
      env: "test",
      fetch: f,
      onUrl: (u) => (authorizeUrl = u),
      open: (u) => {
        // play the browser: approve and hit the loopback redirect
        const q = new URL(u).searchParams;
        void fetch(`${q.get("redirect_uri")}?code=code123&state=${q.get("state")}`);
      },
    });
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(authorizeUrl).searchParams.get("promptli_env")).toBe("test");
    expect(cred).toMatchObject({ client_id: "cli_1", access_token: "acc", refresh_token: "ref", identity: "glow", env: "test" });
    expect(calls).toContain("POST /oauth/token");
  });

  it("rejects a callback with the wrong state", async () => {
    const f = (async (u: string) => {
      const p = new URL(u).pathname;
      if (p.startsWith("/.well-known")) return new Response(JSON.stringify({ authorization_endpoint: "http://c.test/a", token_endpoint: "http://api.test/t", registration_endpoint: "http://api.test/r" }));
      return new Response(JSON.stringify({ client_id: "x" }));
    }) as any;
    await expect(
      browserLogin({
        baseUrl: "http://api.test",
        clientName: "t",
        fetch: f,
        onUrl: () => undefined,
        open: (u) => void fetch(`${new URL(u).searchParams.get("redirect_uri")}?code=c&state=forged`),
      }),
    ).rejects.toMatchObject({ code: "login_state_mismatch" });
  });
});
