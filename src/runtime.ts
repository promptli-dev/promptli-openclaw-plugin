// One running Promptli account inside the OpenClaw gateway: credentials → Agent Link → Gateway + CallDriver.
// Also a small registry so the agent tools can reach the live account (tool-delivery marks, live calls).

import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Promptli } from "@promptli-npm/sdk";
import { credentialsPath, loadTokenSource, promptliHome, readCredentialFile, saveCredentialFile, type TokenSource } from "./auth.js";
import { makeClient } from "./client.js";
import type { ResolvedPromptliAccount } from "./config.js";
import type { Peer, TurnEngine } from "./engine.js";
import { Gateway } from "./gateway.js";
import { AgentLink, linkUrl, type Logger, type WsFactory } from "./link.js";
import { LinkState } from "./state.js";
import { CallDriver } from "./voice.js";

export type AccountStatus = {
  connected: boolean;
  identity: string | null;
  email: string | null;
  number: string | null;
  lastError: string | null;
  lastInboundAt: number | null;
  turns: number;
  activeCalls: number;
};

export type RunningAccount = {
  accountId: string;
  identity: string;
  client: Promptli;
  gateway: Gateway;
  calls: CallDriver;
  link: AgentLink;
  status(): AccountStatus;
  stop(): Promise<void>;
};

const running = new Map<string, RunningAccount>();

export function getRunningAccount(accountId?: string): RunningAccount | undefined {
  if (accountId && running.has(accountId)) return running.get(accountId);
  return running.values().next().value;
}

/** The identity to use: config wins, else the one the browser login is bound to. */
export function resolveIdentity(account: ResolvedPromptliAccount): string | null {
  if (account.identity) return account.identity;
  const cred = readCredentialFile(credentialsPath())?.oauth as { identity?: string } | undefined;
  return cred?.identity ?? null;
}

export function resolveAuth(account: ResolvedPromptliAccount, fetchImpl?: typeof fetch): TokenSource | null {
  return loadTokenSource({ apiKey: account.apiKey ?? undefined, fetch: fetchImpl });
}

export function instanceId(account: ResolvedPromptliAccount): string {
  if (account.instanceId) return account.instanceId;
  // Stable per machine + account, so a restart resumes from the last acked event.
  const path = join(promptliHome(), "openclaw", `instance-${account.accountId}`);
  const existing = readCredentialFile(path)?.id;
  if (typeof existing === "string") return existing;
  const id = `${hostname().split(".")[0]}-openclaw-${randomBytes(4).toString("hex")}`;
  try {
    saveCredentialFile(path, { id }); // not a secret; reuses the atomic writer
  } catch {
    /* best effort: a fresh id only means no backlog replay after restart */
  }
  return id;
}

export type StartAccountOptions = {
  account: ResolvedPromptliAccount;
  auth: TokenSource;
  identity: string;
  makeEngine: (deps: { client: Promptli; sendPairingReply: (peer: Peer, text: string) => Promise<void> }) => TurnEngine;
  abortSignal: AbortSignal;
  log?: Logger;
  onStatus?: (s: AccountStatus) => void;
  fetch?: typeof fetch;
  wsFactory?: WsFactory;
  statePath?: string | null;
  instance?: string;
};

/** Start the account and resolve when it stops (abortSignal), like a channel's startAccount should. */
export async function startAccount(o: StartAccountOptions): Promise<void> {
  const { account, identity, log } = o;
  const client = makeClient(o.auth, { baseUrl: account.baseUrl, fetch: o.fetch });
  const me = client.identity(identity);
  const [ident, channels] = await Promise.all([me.get(), me.channelStatus()]);
  const state = new LinkState(o.statePath === undefined ? join(promptliHome(), "openclaw", `state-${account.accountId}.json`) : o.statePath);

  let link: AgentLink | null = null;
  const sendPairingReply = async (peer: Peer, text: string) => {
    if (peer.channel === "email") {
      if (peer.replyToId) await me.reply(peer.replyToId, { text });
      else await me.sendEmail({ to: [peer.address], subject: "Access request", text });
    } else await client.request("POST", `/v1/identities/${encodeURIComponent(identity)}/texts`, { body: { to: peer.address, body: text } });
  };
  const engine = o.makeEngine({ client, sendPairingReply });
  const gateway = new Gateway({
    client,
    identity,
    engine,
    state,
    ack: (seq) => link?.ack(seq),
    autoReply: account.autoReply,
    batchWindowMs: account.batchWindowMs,
    log,
  });
  gateway.identityAddress = (ident as { email_address?: string | null }).email_address ?? null;
  gateway.identityNumber = (channels as { sms?: { number?: string | null } }).sms?.number ?? null;
  const displayName = (ident as { display_name?: string | null }).display_name || identity;
  const calls = new CallDriver(engine, {
    send: (f) => link!.send(f),
    identityName: () => displayName,
    enabled: () => account.voice,
    log,
  });
  const status = (): AccountStatus => ({
    connected: link?.connected ?? false,
    identity,
    email: gateway.identityAddress,
    number: gateway.identityNumber,
    lastError: gateway.lastError,
    lastInboundAt: gateway.lastInboundAt,
    turns: gateway.turnsCompleted + calls.turnsCompleted,
    activeCalls: calls.active,
  });
  link = new AgentLink({
    url: linkUrl(account.baseUrl),
    auth: o.auth,
    instance: o.instance ?? instanceId(account),
    capabilities: account.voice ? ["channel_turns", "voice"] : ["channel_turns"],
    userAgent: "openclaw",
    onEvent: (ev) => gateway.handleEvent(ev),
    onFrame: (f) => void calls.handle(f),
    onState: (s, detail) => {
      if (s === "disconnected") calls.endAll("link_lost");
      if (s === "fatal") gateway.lastError = detail ?? "Agent Link rejected the credential";
      log?.info(`promptli: agent link ${s}${detail ? ` (${detail})` : ""}`);
      o.onStatus?.(status());
    },
    wsFactory: o.wsFactory,
    log,
  });
  const entry: RunningAccount = { accountId: account.accountId, identity, client, gateway, calls, link, status, stop: async () => link!.close() };
  running.set(account.accountId, entry);
  try {
    await link.start();
    log?.info(`promptli: connected as @${identity} (${gateway.identityAddress ?? "no email"}, ${gateway.identityNumber ?? "no number"})`);
    o.onStatus?.(status());
    await new Promise<void>((resolve) => {
      if (o.abortSignal.aborted) return resolve();
      o.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    calls.endAll("gateway_stopping");
    await link.close();
    await gateway.drain().catch(() => undefined);
    running.delete(account.accountId);
    o.onStatus?.(status());
  }
}
