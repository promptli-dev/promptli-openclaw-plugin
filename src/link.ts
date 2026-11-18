// Agent Link client (spec/agent-link.md in promptli-comms): one outbound WebSocket that streams the
// identity's events and live-call frames. No public URL, webhook or tunnel is needed.
//
// - First frame is `hello` (cursor = last acked seq for this X-Link-Instance; replay starts after it).
// - `ping` → `pong`; `event` → onEvent; any other frame (call.*) → onFrame. Unknown types are ignored.
// - Reconnects with exponential backoff (1 s → 30 s, jitter). Close 4001 (auth) is fatal; 4002 = replaced.

import WebSocket from "ws";
import type { TokenSource } from "./auth.js";
import type { Json } from "./framing.js";

export const FATAL_CLOSE = 4001;
export const REPLACED_CLOSE = 4002;

export type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };

/** The subset of a `ws` WebSocket we use (tests pass a fake). */
export interface WsLike {
  on(ev: "open", cb: () => void): unknown;
  on(ev: "message", cb: (data: unknown) => void): unknown;
  on(ev: "close", cb: (code: number, reason: Buffer) => void): unknown;
  on(ev: "error", cb: (err: Error) => void): unknown;
  send(data: string): void;
  close(code?: number): void;
  readonly readyState: number;
}

export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

const defaultFactory: WsFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 15_000 }) as unknown as WsLike;

/** api.comms.promptli.com → wss://link.comms.promptli.com/v1/connect; localhost:8000 → ws://localhost:8100. */
export function linkUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, "");
  if (b.includes("://api.")) return b.replace("://api.", "://link.").replace(/^http/, "ws") + "/v1/connect";
  if (b.endsWith(":8000")) return b.replace(/^http/, "ws").slice(0, -":8000".length) + ":8100/v1/connect";
  return b.replace(/^http/, "ws") + "/v1/connect";
}

export type AgentLinkOptions = {
  url: string;
  auth: TokenSource;
  instance: string;
  identity?: string;
  capabilities?: string[];
  userAgent?: string;
  onEvent: (event: Json) => void | Promise<void>;
  onFrame?: (frame: Json) => void | Promise<void>;
  onState?: (state: "connected" | "disconnected" | "fatal", detail?: string) => void;
  log?: Logger;
  wsFactory?: WsFactory;
  backoff?: (attempt: number) => number; // ms
  connectTimeoutMs?: number;
};

export class AgentLink {
  hello: Json = {};
  private ws: WsLike | null = null;
  private closed = false;
  private attempt = 0;
  private reauthed = false;
  private timer: NodeJS.Timeout | null = null;
  private firstHello: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private chain: Promise<void> = Promise.resolve(); // frames are handled in order

  constructor(private readonly o: AgentLinkOptions) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && "session_id" in this.hello;
  }

  get url(): string {
    const params: string[] = [];
    if (this.o.identity) params.push(`identity=${encodeURIComponent(this.o.identity)}`);
    if (this.o.capabilities?.length) params.push(`capabilities=${this.o.capabilities.join(",")}`);
    return this.o.url + (params.length ? `?${params.join("&")}` : "");
  }

  /** Connect; resolves on the first `hello`, rejects on an auth error or timeout. Keeps reconnecting after. */
  start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => (this.firstHello = { resolve, reject }));
    const timeout = this.o.connectTimeoutMs ?? 15_000;
    const t = setTimeout(() => this.firstHello?.reject(new Error("Agent Link did not connect in time.")), timeout);
    t.unref?.();
    void this.connect();
    return ready.finally(() => clearTimeout(t));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
    this.ws = null;
    await this.chain.catch(() => undefined);
  }

  ack(seq: number): void {
    this.trySend({ type: "ack", seq });
  }

  /** Send a raw frame (call control). Throws when not connected. */
  send(frame: Json): void {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("Agent Link is not connected.");
    this.ws.send(JSON.stringify(frame));
  }

  private trySend(frame: Json): void {
    try {
      this.send(frame);
    } catch {
      /* acks are re-derived from the cursor on reconnect */
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let token: string;
    try {
      token = await this.o.auth.token();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "login_expired") return this.fatal(err.message);
      this.o.log?.warn(`promptli: could not get a token (${err.message}); retrying`);
      return this.scheduleReconnect();
    }
    if (this.closed) return;
    const ua = `promptli-openclaw/0.1${this.o.userAgent ? " " + this.o.userAgent : ""}`;
    const ws = (this.o.wsFactory ?? defaultFactory)(this.url, { Authorization: `Bearer ${token}`, "X-Link-Instance": this.o.instance, "User-Agent": ua });
    this.ws = ws;
    let gotHello = false;
    let authFailed: string | null = null;
    ws.on("message", (data) => {
      let frame: Json;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!gotHello) {
        if (frame.type === "error") {
          authFailed = String(frame.message ?? frame.code ?? "rejected");
          return;
        }
        if (frame.type === "hello") {
          gotHello = true;
          this.hello = frame;
          this.attempt = 0;
          this.reauthed = false;
          this.o.onState?.("connected");
          this.firstHello?.resolve();
          this.firstHello = null;
          return;
        }
      }
      if (frame.type === "ping") return this.trySend({ type: "pong" });
      if (frame.type === "error") return this.o.log?.warn(`promptli: agent link error ${frame.code ?? ""}`);
      this.chain = this.chain
        .then(() => (frame.type === "event" ? this.o.onEvent(frame.event) : this.o.onFrame?.(frame)))
        .catch((e) => this.o.log?.error(`promptli: frame handler failed: ${(e as Error).message}`));
    });
    ws.on("error", (err) => this.o.log?.debug?.(`promptli: agent link socket error: ${err.message}`));
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null;
      if (gotHello) this.o.onState?.("disconnected", String(code));
      if (this.closed) return;
      if (code === FATAL_CLOSE || authFailed) {
        if (this.o.auth.kind === "browser_login" && !this.reauthed) {
          this.reauthed = true; // an access token that expired or rotated in flight: refresh once
          this.o.auth.invalidate();
          return void this.connect();
        }
        return this.fatal(authFailed ?? "Agent Link rejected the credential.");
      }
      if (code === REPLACED_CLOSE) this.o.log?.warn("promptli: agent link replaced by another connection with the same instance id");
      this.scheduleReconnect();
    });
  }

  private fatal(message: string): void {
    this.closed = true;
    this.o.onState?.("fatal", message);
    this.firstHello?.reject(Object.assign(new Error(message), { code: "invalid_api_key" }));
    this.firstHello = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.attempt += 1;
    const delay = this.o.backoff ? this.o.backoff(this.attempt) : Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5)) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref?.();
  }
}
