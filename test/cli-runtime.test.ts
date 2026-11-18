import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, loadTokenSource, readCredentialFile, saveCredentialFile } from "../src/auth.js";
import { doctor, logout, setup, status, type CliHost } from "../src/cli.js";
import { resolveAccount } from "../src/config.js";
import { startAccount } from "../src/runtime.js";
import { FakeEngine, tick } from "./helpers.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  constructor() {
    super();
    setTimeout(() => this.server({ type: "hello", session_id: "s1", cursor: 0 }), 1);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  server(f: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(f)));
  }
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { date: new Date().toUTCString() } });

function fakeFetch(log: string[] = []) {
  return (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    log.push(`${init.method ?? "GET"} ${url.pathname}`);
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return json({ authorization_endpoint: "http://console.test/oauth/authorize", token_endpoint: "http://api.test/oauth/token", registration_endpoint: "http://api.test/oauth/register" });
      case "/oauth/register":
        return json({ client_id: "cli_1" });
      case "/oauth/token":
        return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
      case "/oauth/revoke":
        return json({});
      case "/v1/whoami":
        return json({ identity: { handle: "glow" }, env: "test" });
      case "/v1/identities/glow":
        return json({ handle: "glow", display_name: "Glow", email_address: "glow@agents.promptli.com" });
      case "/v1/identities/glow/channel-status":
        return json({ email: { ready: true, address: "glow@agents.promptli.com" }, sms: { ready: true, number: "+15550001111" }, voice: { ready: false, status: "no_number" }, issues: [] });
      default:
        return json({ id: "obj_1", status: "queued" });
    }
  }) as typeof fetch;
}

function host(cfg: any = {}): CliHost & { lines: string[]; cfg: any } {
  const h: any = {
    cfg,
    lines: [] as string[],
    currentConfig: () => h.cfg,
    mutateConfig: async (m: (d: any) => void) => {
      const draft = structuredClone(h.cfg);
      m(draft);
      h.cfg = draft;
    },
    out: (l: string) => void h.lines.push(l),
    err: (l: string) => void h.lines.push(l),
    fetch: fakeFetch(),
    wsFactory: () => new FakeWs(),
    prompt: async () => "y",
    openUrl: (u: string) => {
      const q = new URL(u).searchParams;
      void fetch(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}`);
    },
  };
  return h;
}

beforeEach(() => {
  process.env.PROMPTLI_HOME = mkdtempSync(join(tmpdir(), "promptli-home-"));
  delete process.env.PROMPTLI_API_KEY;
  process.env.PROMPTLI_BASE_URL = "http://api.test";
});

describe("openclaw promptli setup / status / doctor / logout", () => {
  it("setup shows the warning, logs in with the browser, saves 600 credentials and writes channel config", async () => {
    const h = host();
    expect(await setup(h, { test: true })).toEqual({ identity: "glow" });
    expect(h.lines[0]).toContain("Anyone who knows your agent's email address");
    const p = credentialsPath();
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect((readCredentialFile(p)!.oauth as any).identity).toBe("glow");
    expect(h.cfg.channels.promptli).toMatchObject({ enabled: true, identity: "glow", dmPolicy: "open", allowFrom: ["*"] });
    expect(h.cfg.plugins.entries["promptli-comms"].enabled).toBe(true);
    expect(h.lines.join("\n")).not.toMatch(/acc|ref/); // tokens never printed
  });

  it("setup stops if the warning is declined", async () => {
    const h = host();
    h.prompt = async () => "n";
    await expect(setup(h, {})).rejects.toThrow("cancelled");
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("status and doctor report the agent, channels and Agent Link", async () => {
    const h = host();
    await setup(h, {});
    const s = await status(h);
    expect(s).toMatchObject({ configured: true, credential: "browser_login", identity: "glow", email: "glow@agents.promptli.com", number: "+15550001111" });
    const checks = await doctor(h);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.credentials!.ok && byName.agent!.ok && byName.api!.ok && byName.clock!.ok && byName.agent_link!.ok).toBe(true);
    expect(byName.voice).toMatchObject({ ok: false, warn: true });
  });

  it("logout revokes and deletes the login", async () => {
    const log: string[] = [];
    const h = host();
    await setup(h, {});
    h.fetch = fakeFetch(log);
    await logout(h);
    expect(log).toContain("POST /oauth/revoke");
    expect(existsSync(credentialsPath())).toBe(false);
  });
});

describe("runtime: a running account end to end (fake API and link)", () => {
  it("connects, answers a text through the engine and acks it, then stops on abort", async () => {
    saveCredentialFile(credentialsPath(), { api_key: "psk_test_fake" });
    const cfg = { channels: { promptli: { identity: "glow", baseUrl: "http://api.test" } } };
    const account = resolveAccount(cfg);
    const apiLog: string[] = [];
    const sockets: FakeWs[] = [];
    const engine = new FakeEngine(() => [{ type: "done", text: "Got it" }]);
    const abort = new AbortController();
    const statusSeen: any[] = [];
    const done = startAccount({
      account: { ...account, batchWindowMs: 1 },
      auth: loadTokenSource()!,
      identity: "glow",
      makeEngine: () => engine,
      abortSignal: abort.signal,
      fetch: fakeFetch(apiLog),
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws as never;
      },
      statePath: null,
      instance: "test-instance",
      onStatus: (s) => void statusSeen.push(s),
    });
    await tick(20);
    expect(statusSeen.at(-1)).toMatchObject({ connected: true, email: "glow@agents.promptli.com", number: "+15550001111" });
    sockets[0]!.server({ type: "event", event: { id: "evt_7", seq: 7, type: "text.received", data: { contact_key: "sms:+15551230000", text: { from: "+15551230000", body: "hi" } } } });
    await tick(30);
    expect(engine.requests).toHaveLength(1);
    expect(apiLog).toContain("POST /v1/identities/glow/texts");
    expect(sockets[0]!.sent).toContainEqual({ type: "ack", seq: 7 });
    abort.abort();
    await done;
    expect(statusSeen.at(-1).connected).toBe(false);
  });
});
