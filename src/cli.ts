// `openclaw promptli setup | status | doctor | logout`.
// Setup logs in with the browser (no key pasting), saves the login to ~/.promptli/openclaw/credentials
// (mode 600) and writes channels.promptli in openclaw.json. Keys are never printed or put on argv.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  AuthError,
  browserLogin,
  credentialsPath,
  DEFAULT_BASE_URL,
  deleteCredentialFile,
  loadTokenSource,
  OAuthToken,
  readCredentialFile,
  saveCredentialFile,
  type OAuthCredential,
} from "./auth.js";
import { makeClient } from "./client.js";
import { CHANNEL_ID, resolveAccount } from "./config.js";
import { AgentLink, linkUrl, type WsFactory } from "./link.js";
import { resolveIdentity } from "./runtime.js";

export const STRANGER_WARNING =
  "Anyone who knows your agent's email address or phone number can reach it. Every person gets their own " +
  "OpenClaw conversation, but it runs with YOUR agent's tools and permissions. Message content is marked as " +
  "untrusted, yet a stranger can still try to talk the agent into using any tool it has (prompt injection). " +
  "Keep the agent's tool policy tight, or set channels.promptli.dmPolicy to \"allowlist\" or \"pairing\".";

/** What the CLI needs from OpenClaw (narrow so tests can fake it). */
export type CliHost = {
  currentConfig: () => unknown;
  mutateConfig: (mutate: (draft: Record<string, any>) => void) => Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  wsFactory?: WsFactory;
  prompt?: (question: string) => Promise<string>;
  openUrl?: (url: string) => void;
};

type Cmd = {
  command(name: string): Cmd;
  description(d: string): Cmd;
  option(flags: string, description: string, defaultValue?: unknown): Cmd;
  action(fn: (...args: any[]) => unknown): Cmd; // eslint-disable-line @typescript-eslint/no-explicit-any
};

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export type SetupOptions = { browser?: boolean; number?: boolean; test?: boolean; apiKeyStdin?: boolean; yes?: boolean; baseUrl?: string; dmPolicy?: string };

export async function setup(host: CliHost, o: SetupOptions): Promise<{ identity: string }> {
  const baseUrl = o.baseUrl || resolveAccount(host.currentConfig()).baseUrl || DEFAULT_BASE_URL;
  host.out(STRANGER_WARNING);
  if (!o.yes) {
    const answer = (await (host.prompt ?? ask)("Continue? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new Error("Setup cancelled.");
  }
  const path = credentialsPath();
  let identity: string | null = null;
  if (o.apiKeyStdin) {
    const key = await readStdin();
    if (!/^psk_(live|test)_/.test(key)) throw new Error("That does not look like a Promptli key (psk_live_… or psk_test_…).");
    const who = (await makeClient(loadTokenSource({ apiKey: key })!, { baseUrl, fetch: host.fetch }).whoami()) as { identity?: { handle?: string } | null };
    identity = who.identity?.handle ?? null;
    if (!identity) throw new Error("Use an identity-scoped key (one agent), not an organization key.");
    saveCredentialFile(path, { api_key: key });
  } else {
    const browser = o.browser !== false;
    const cred = await browserLogin({
      baseUrl,
      clientName: `OpenClaw on ${process.env.HOSTNAME || "this computer"}`,
      openBrowser: browser,
      wantNumber: o.number,
      env: o.test ? "test" : undefined,
      onUrl: (url) => host.out(browser ? `Opening your browser to log in. If it does not open, visit:\n  ${url}` : `Open this link on any device, approve, then paste the code it shows:\n  ${url}`),
      open: host.openUrl ?? openInBrowser,
      pasteCode: () => (host.prompt ?? ask)("Code: "),
      fetch: host.fetch,
    });
    identity = cred.identity ?? null;
    if (!identity) throw new Error("The login is not bound to an agent. Pick or create one in the browser and try again.");
    saveCredentialFile(path, { oauth: cred });
  }
  await host.mutateConfig((draft) => {
    const channels = (draft.channels ??= {});
    const section = (channels[CHANNEL_ID] ??= {});
    section.enabled = true;
    section.identity = identity;
    if (baseUrl !== DEFAULT_BASE_URL) section.baseUrl = baseUrl;
    if (o.dmPolicy) section.dmPolicy = o.dmPolicy;
    if (!section.dmPolicy) section.dmPolicy = "open";
    if (section.dmPolicy === "open" && !section.allowFrom) section.allowFrom = ["*"];
    const plugins = (draft.plugins ??= {});
    const entries = (plugins.entries ??= {});
    (entries["promptli-comms"] ??= {}).enabled = true;
  });
  host.out(`Connected @${identity}. Credentials saved to ${path} (mode 600).`);
  host.out("Restart the gateway to start answering: openclaw gateway restart");
  host.out("Then check everything: openclaw promptli doctor");
  return { identity };
}

export type StatusReport = {
  configured: boolean;
  credential: "api_key" | "browser_login" | "none";
  identity: string | null;
  email: string | null;
  number: string | null;
  channels: unknown;
  dmPolicy: string;
  voice: boolean;
  error?: string;
};

export function credentialKind(apiKey?: string | null): StatusReport["credential"] {
  if (apiKey || process.env.PROMPTLI_API_KEY) return "api_key";
  const data = readCredentialFile(credentialsPath());
  if (!data) return "none";
  return data.oauth ? "browser_login" : data.api_key ? "api_key" : "none";
}

export async function status(host: CliHost): Promise<StatusReport> {
  const account = resolveAccount(host.currentConfig());
  const identity = resolveIdentity(account);
  const report: StatusReport = {
    configured: Boolean(identity),
    credential: credentialKind(account.apiKey),
    identity,
    email: null,
    number: null,
    channels: null,
    dmPolicy: account.dmPolicy,
    voice: account.voice,
  };
  const auth = loadTokenSource({ apiKey: account.apiKey ?? undefined, fetch: host.fetch });
  if (!identity || !auth) return report;
  try {
    const me = makeClient(auth, { baseUrl: account.baseUrl, fetch: host.fetch }).identity(identity);
    const [ident, ch] = await Promise.all([me.get(), me.channelStatus()]);
    report.email = (ident as { email_address?: string | null }).email_address ?? null;
    report.number = (ch as { sms?: { number?: string | null } }).sms?.number ?? null;
    report.channels = ch;
  } catch (e) {
    report.error = (e as Error).message;
  }
  return report;
}

export type Check = { name: string; ok: boolean; detail: string; fix?: string; /** not fatal (e.g. no phone number yet) */ warn?: boolean };

export async function doctor(host: CliHost): Promise<Check[]> {
  const checks: Check[] = [];
  const cfg = host.currentConfig();
  const account = resolveAccount(cfg);
  const identity = resolveIdentity(account);
  const kind = credentialKind(account.apiKey);
  checks.push({ name: "credentials", ok: kind !== "none", detail: kind === "none" ? "not logged in" : kind.replace("_", " "), fix: "openclaw promptli setup" });
  checks.push({ name: "agent", ok: Boolean(identity), detail: identity ? `@${identity}` : "no agent identity", fix: "openclaw promptli setup" });
  const enabled = (cfg as { channels?: Record<string, { enabled?: boolean }> })?.channels?.[CHANNEL_ID]?.enabled !== false;
  checks.push({ name: "channel", ok: enabled, detail: enabled ? `channels.promptli enabled (dmPolicy ${account.dmPolicy})` : "channels.promptli.enabled is false", fix: "openclaw config set channels.promptli.enabled true" });
  const auth = loadTokenSource({ apiKey: account.apiKey ?? undefined, fetch: host.fetch });
  if (!auth || !identity) return checks;
  const f = host.fetch ?? fetch;
  try {
    const res = await f(account.baseUrl.replace(/\/$/, "") + "/v1/whoami", { headers: { Authorization: `Bearer ${await auth.token()}` } });
    const date = res.headers.get("date");
    const skew = date ? Math.abs(Date.now() - Date.parse(date)) / 1000 : 0;
    checks.push({ name: "api", ok: res.ok, detail: res.ok ? `reachable (${account.baseUrl})` : `HTTP ${res.status}`, fix: res.status === 401 ? "openclaw promptli setup" : "check your network" });
    checks.push({ name: "clock", ok: skew < 60, detail: `skew ${skew.toFixed(0)}s`, fix: "sync your system clock (NTP)" });
  } catch (e) {
    const err = e as AuthError;
    checks.push({ name: "api", ok: false, detail: err.message, fix: err.code === "login_expired" ? "openclaw promptli setup" : "check your network" });
    return checks;
  }
  try {
    const ch = (await makeClient(auth, { baseUrl: account.baseUrl, fetch: host.fetch }).identity(identity).channelStatus()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const name of ["email", "sms", "voice"]) {
      const c = ch[name];
      if (!c) continue;
      checks.push({ name, ok: Boolean(c.ready), warn: name !== "email", detail: String(c.address ?? c.number ?? c.status ?? (c.ready ? "ready" : "not ready")) });
    }
    for (const issue of ch.issues ?? []) checks.push({ name: "issue", ok: false, warn: true, detail: `${issue.code}: ${issue.message}` });
  } catch (e) {
    checks.push({ name: "channels", ok: false, detail: (e as Error).message });
  }
  // A throwaway instance id: never takes over the gateway's own Agent Link session.
  const link = new AgentLink({
    url: linkUrl(account.baseUrl),
    auth,
    instance: `doctor-${randomBytes(4).toString("hex")}`,
    identity,
    onEvent: () => undefined,
    wsFactory: host.wsFactory,
    connectTimeoutMs: 10_000,
  });
  try {
    await link.start();
    checks.push({ name: "agent_link", ok: true, detail: `connected (${linkUrl(account.baseUrl)})` });
  } catch (e) {
    checks.push({ name: "agent_link", ok: false, detail: (e as Error).message, fix: "check outbound WebSocket (wss://) access" });
  } finally {
    await link.close();
  }
  return checks;
}

export async function logout(host: CliHost): Promise<void> {
  const path = credentialsPath();
  const data = readCredentialFile(path);
  if (data?.oauth) await new OAuthToken(data.oauth as OAuthCredential, { fetch: host.fetch }).revoke();
  deleteCredentialFile(path);
  host.out("Logged out: the login is revoked and local credentials are deleted. The agent itself is kept.");
}

export function registerPromptliCli(program: Cmd, host: CliHost): void {
  const root = program.command("promptli").description("Promptli Comms: email, SMS and phone calls for this agent");
  const fail = (e: unknown) => {
    host.err(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  };
  root
    .command("setup")
    .description("Log in with your browser, pick or create the agent, and enable the channel")
    .option("--no-browser", "Headless/SSH: open the link elsewhere and paste the code")
    .option("--number", "Also offer a phone number for the agent")
    .option("--test", "Use test mode (no real email, SMS or calls)")
    .option("--api-key-stdin", "Read an identity-scoped key from stdin instead of logging in")
    .option("--dm-policy <policy>", "open | allowlist | pairing | disabled")
    .option("-y, --yes", "Accept the security warning")
    .action(async (opts: SetupOptions) => setup(host, opts).catch(fail));
  root
    .command("status")
    .description("Agent, address, number and channel state")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const s = await status(host);
        if (opts.json) return host.out(JSON.stringify(s, null, 2));
        if (!s.configured) return host.out("Not set up. Run: openclaw promptli setup");
        host.out(`Agent:   @${s.identity} (${s.credential.replace("_", " ")})`);
        host.out(`Email:   ${s.email ?? "-"}`);
        host.out(`Phone:   ${s.number ?? "- (add one with: openclaw promptli setup --number)"}`);
        host.out(`Access:  dmPolicy ${s.dmPolicy}; calls ${s.voice ? "on" : "off"}`);
        if (s.error) host.out(`Error:   ${s.error}`);
      } catch (e) {
        fail(e);
      }
    });
  root
    .command("doctor")
    .description("Check credentials, API, channels, Agent Link and clock")
    .action(async () => {
      try {
        const checks = await doctor(host);
        for (const c of checks) host.out(`${c.ok ? "ok  " : c.warn ? "warn" : "FAIL"} ${c.name.padEnd(11)} ${c.detail}${!c.ok && c.fix ? `  -> ${c.fix}` : ""}`);
        if (checks.some((c) => !c.ok && !c.warn)) process.exitCode = 1;
      } catch (e) {
        fail(e);
      }
    });
  root
    .command("logout")
    .description("Revoke this machine's login and delete local credentials")
    .action(async () => logout(host).catch(fail));
}
