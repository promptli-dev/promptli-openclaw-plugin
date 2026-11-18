// Credentials: an API key, or a browser login (OAuth 2.1 + PKCE, RFC 8252 loopback) that refreshes itself.
// Same file format as the Python SDK (`{"oauth": {...}}` or `{"api_key": "..."}`, mode 600), so
// `promptli` CLI tooling can read it too. Keys are never logged or printed.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, openSync, closeSync, fchmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.comms.promptli.com";
const REFRESH_SKEW_S = 60;

export type OAuthCredential = {
  client_id: string;
  refresh_token: string;
  base_url: string;
  access_token: string;
  expires_at: number; // unix seconds
  identity?: string | null;
  env?: string | null;
};

export interface TokenSource {
  readonly kind: "api_key" | "browser_login";
  token(): Promise<string>;
  /** The server refused the current token: refresh next time (no-op for keys). */
  invalidate(): void;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function promptliHome(): string {
  return process.env.PROMPTLI_HOME || join(homedir(), ".promptli");
}

/** ~/.promptli/openclaw/credentials */
export function credentialsPath(): string {
  return join(promptliHome(), "openclaw", "credentials");
}

export function saveCredentialFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(data));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path); // atomic: never a moment where the file is half-written or world-readable
}

export function readCredentialFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function deleteCredentialFile(path: string): void {
  if (existsSync(path)) rmSync(path);
}

export class StaticToken implements TokenSource {
  readonly kind = "api_key" as const;
  constructor(private readonly key: string) {}
  async token(): Promise<string> {
    return this.key;
  }
  invalidate(): void {}
}

type Fetch = typeof fetch;

export class OAuthToken implements TokenSource {
  readonly kind = "browser_login" as const;
  private inflight: Promise<void> | null = null;
  private rejected = "";

  constructor(
    public cred: OAuthCredential,
    private readonly opts: { save?: (c: OAuthCredential) => void; reload?: () => OAuthCredential | null; fetch?: Fetch } = {},
  ) {}

  async token(): Promise<string> {
    if (this.cred.access_token && Date.now() / 1000 < this.cred.expires_at - REFRESH_SKEW_S) return this.cred.access_token;
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    await this.inflight;
    return this.cred.access_token;
  }

  invalidate(): void {
    this.rejected = this.cred.access_token;
    this.cred.expires_at = 0;
  }

  private async refresh(): Promise<void> {
    // Another process (the promptli CLI, a second gateway) may have rotated the refresh token already.
    const disk = this.opts.reload?.();
    if (disk && disk.refresh_token !== this.cred.refresh_token) {
      this.cred = disk;
      if (disk.access_token && disk.access_token !== this.rejected && Date.now() / 1000 < disk.expires_at - REFRESH_SKEW_S) return;
    }
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.cred.base_url.replace(/\/$/, "") + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.cred.refresh_token, client_id: this.cred.client_id }),
      });
    } catch (e) {
      throw new AuthError("connection_error", `Couldn't reach Promptli to refresh the login: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.error === "invalid_grant") throw new AuthError("login_expired", "Your browser login was revoked or has expired. Run `openclaw promptli setup` again.");
      throw new AuthError(String(body.error ?? "token_refresh_failed"), String(body.error_description ?? `Token refresh failed (${res.status}).`));
    }
    this.cred = {
      ...this.cred,
      refresh_token: String(body.refresh_token),
      access_token: String(body.access_token),
      expires_at: Date.now() / 1000 + Number(body.expires_in ?? 3600),
    };
    this.opts.save?.(this.cred); // persist the rotated refresh token before anything else uses it
  }

  async revoke(): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    await f(this.cred.base_url.replace(/\/$/, "") + "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: this.cred.refresh_token }),
    }).catch(() => undefined);
  }
}

/** The credential to use: an explicit/env API key wins, else the stored key or browser login. */
export function loadTokenSource(opts: { apiKey?: string; path?: string; fetch?: Fetch } = {}): TokenSource | null {
  const key = opts.apiKey || process.env.PROMPTLI_API_KEY;
  if (key) return new StaticToken(key);
  const path = opts.path ?? credentialsPath();
  const data = readCredentialFile(path);
  if (!data) return null;
  const oauth = data.oauth as OAuthCredential | undefined;
  if (oauth && typeof oauth === "object") {
    return new OAuthToken(oauth, {
      fetch: opts.fetch,
      save: (c) => saveCredentialFile(path, { ...(readCredentialFile(path) ?? {}), oauth: c }),
      reload: () => (readCredentialFile(path)?.oauth as OAuthCredential | undefined) ?? null,
    });
  }
  return typeof data.api_key === "string" && data.api_key ? new StaticToken(data.api_key) : null;
}

// ---- browser login ---------------------------------------------------------------------------------------

const DONE_PAGE = (title: string, msg: string) =>
  `<!doctype html><meta charset=utf-8><title>Promptli</title><body style='font:16px system-ui;margin:15vh auto;max-width:28em;text-align:center'><h2>${title}</h2><p>${msg}</p></body>`;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64)).slice(0, 96);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export type BrowserLoginOptions = {
  baseUrl?: string;
  clientName: string;
  /** false over SSH: the console shows a one-time code after approval and `pasteCode` returns it. */
  openBrowser?: boolean;
  wantNumber?: boolean;
  env?: "live" | "test";
  onUrl: (url: string) => void;
  open?: (url: string) => void;
  pasteCode?: () => Promise<string>;
  timeoutMs?: number;
  fetch?: Fetch;
};

async function waitForCallback(): Promise<{ port: number; result: Promise<Record<string, string>>; close: () => void }> {
  let resolve!: (q: Record<string, string>) => void;
  const result = new Promise<Record<string, string>>((r) => (resolve = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const q = Object.fromEntries(url.searchParams);
    const ok = "code" in q;
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
      .end(ok ? DONE_PAGE("You're connected", "You can close this tab and go back to your terminal.") : DONE_PAGE("Login cancelled", "Nothing was connected. You can close this tab."));
    resolve(q);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, result, close: () => server.close() };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Log in with the browser; returns a credential bound to the agent the person picked or created. */
export async function browserLogin(o: BrowserLoginOptions): Promise<OAuthCredential> {
  const base = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const f = o.fetch ?? fetch;
  const getJson = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const meta = await getJson(await f(base + "/.well-known/oauth-authorization-server"));
  const authorizeEp = String(meta.authorization_endpoint);
  const tokenEp = String(meta.token_endpoint);
  const openBrowser = o.openBrowser ?? true;
  const listener = openBrowser ? await waitForCallback() : null;
  let redirectUri: string;
  if (listener) redirectUri = `http://127.0.0.1:${listener.port}/callback`;
  else {
    if (!o.pasteCode) throw new Error("pasteCode is required when openBrowser is false");
    redirectUri = `${new URL(authorizeEp).origin}/oauth/code`;
  }
  let clientId: string;
  let code: string;
  const { verifier, challenge } = pkce();
  try {
    const reg = await f(String(meta.registration_endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: o.clientName, redirect_uris: [redirectUri] }),
    });
    const regBody = await getJson(reg);
    if (!reg.ok) throw new AuthError("login_failed", String(regBody.error_description ?? "Could not register the login client."));
    clientId = String(regBody.client_id);
    const state = b64url(randomBytes(24));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "promptli",
    });
    if (o.wantNumber) params.set("promptli_number", "1");
    if (o.env) params.set("promptli_env", o.env);
    const url = `${authorizeEp}?${params}`;
    o.onUrl(url);
    if (listener) {
      try {
        o.open?.(url);
      } catch {
        /* the URL is printed anyway */
      }
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new AuthError("login_timeout", "Timed out waiting for the browser.")), o.timeoutMs ?? 300_000).unref());
      const q = await Promise.race([listener.result, timeout]);
      if (q.error) throw new AuthError("login_denied", "The login was not approved.");
      if (!sameString(q.state ?? "", state)) throw new AuthError("login_state_mismatch", "The login response didn't match this request.");
      code = String(q.code);
    } else {
      code = (await o.pasteCode!()).trim();
    }
  } finally {
    listener?.close();
  }
  const tok = await f(tokenEp, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  });
  const body = await getJson(tok);
  if (!tok.ok) throw new AuthError("login_failed", String(body.error_description ?? "The login code was invalid or expired."));
  const cred: OAuthCredential = {
    client_id: clientId,
    refresh_token: String(body.refresh_token),
    base_url: base,
    access_token: String(body.access_token),
    expires_at: Date.now() / 1000 + Number(body.expires_in ?? 3600),
  };
  const who = await getJson(await f(base + "/v1/whoami", { headers: { Authorization: `Bearer ${cred.access_token}` } }));
  cred.identity = who.identity?.handle ? String(who.identity.handle) : null;
  cred.env = who.env ? String(who.env) : null;
  return cred;
}
