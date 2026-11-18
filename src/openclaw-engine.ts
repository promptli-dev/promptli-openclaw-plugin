// TurnEngine on OpenClaw's channel pipeline (PluginRuntime["channel"], the same path the bundled SMS channel
// uses): sender access (dmPolicy / allowFrom / pairing) → agent route → inbound.run with our delivery hooks.
//
// - Every person is an OpenClaw *direct* conversation on channel "promptli", keyed by Promptli's contact_key,
//   so the same person by email, text and phone lands in the same OpenClaw session.
// - Text is streamed through replyOptions.onPartialReply (voice speaks it as it arrives); onToolStart lets
//   voice play a filler; replyOptions.abortSignal stops the run on barge-in.
// - Final text is handed back to the Promptli gateway, which owns NO_REPLY handling, tool-delivery
//   suppression, SMS splitting and threaded email replies (deliver() itself sends nothing).

import type { Peer, TurnChunk, TurnEngine, TurnRequest } from "./engine.js";
import { CHANNEL_ID, type ResolvedPromptliAccount } from "./config.js";
import { isNoReply } from "./framing.js";
import type { Logger } from "./link.js";

/** The subset of PluginRuntime["channel"] we use (narrow so tests can fake it). */
export type ChannelRuntimeLike = {
  routing: { resolveAgentRoute(p: { cfg: unknown; channel: string; accountId: string; peer: { kind: "direct"; id: string } }): { agentId: string; sessionKey: string; accountId?: string } };
  commands: { shouldComputeCommandAuthorized(body: string, cfg: unknown): boolean };
  pairing: {
    readAllowFromStore(p: { channel: string; accountId: string }): Promise<string[]> | string[];
    upsertPairingRequest(p: Record<string, unknown>): Promise<unknown>;
  };
  inbound: {
    ingress: { resolveStable(p: Record<string, unknown>): Promise<IngressResult> };
    buildContext(p: Record<string, unknown>): unknown;
    run(p: Record<string, unknown>): Promise<unknown>;
  };
};

type IngressResult = {
  senderAccess: { allowed: boolean; decision?: string };
  commandAccess?: { requested?: boolean; authorized?: boolean };
};

type Payload = { text?: string; delta?: string; replace?: true };

export type OpenClawEngineOptions = {
  cfg: unknown;
  account: ResolvedPromptliAccount;
  rt: ChannelRuntimeLike;
  /** Pairing replies go back over Promptli (email or SMS). */
  sendPairingReply?: (peer: Peer, text: string) => Promise<void>;
  issuePairingChallenge?: (p: { senderId: string; senderIdLine: string; sendPairingReply: (t: string) => Promise<void> }) => Promise<void>;
  log?: Logger;
};

class Pipe<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export class OpenClawEngine implements TurnEngine {
  constructor(private readonly o: OpenClawEngineOptions) {}

  /** Sender access by OpenClaw's rules. Pairing sends the code back over the same medium. */
  async authorize(peer: Peer, body: string, binding?: Record<string, unknown>): Promise<IngressResult> {
    const { cfg, account, rt } = this.o;
    return rt.inbound.ingress.resolveStable({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      cfg,
      identity: { key: "address", entryIdPrefix: "promptli-entry" },
      readStoreAllowFrom: async () => await rt.pairing.readAllowFromStore({ channel: CHANNEL_ID, accountId: account.accountId }),
      subject: { stableId: peer.address },
      conversation: { kind: "direct", id: peer.contactKey },
      ...(binding ? { contextBinding: binding } : {}),
      event: { mayPair: peer.channel !== "voice" },
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      command: rt.commands.shouldComputeCommandAuthorized(body, cfg) ? { cfg, modeWhenAccessGroupsOff: "configured" } : undefined,
    });
  }

  async *runTurn(req: TurnRequest): AsyncIterable<TurnChunk> {
    const { cfg, account, rt, log } = this.o;
    const { peer } = req;
    const raw = req.raw ?? req.prompt;
    // Voice and post-call turns belong to a call Promptli already admitted; channel turns are checked here.
    const checkAccess = req.kind === "channel";
    let auth: IngressResult | null = null;
    if (checkAccess) {
      auth = await this.authorize(peer, raw);
      if (!auth.senderAccess.allowed) {
        if (auth.senderAccess.decision === "pairing" && this.o.issuePairingChallenge && this.o.sendPairingReply) {
          await this.o.issuePairingChallenge({
            senderId: peer.address,
            senderIdLine: `Your ${peer.channel === "email" ? "email address" : "phone number"}: ${peer.address}`,
            sendPairingReply: (t) => this.o.sendPairingReply!(peer, t),
          });
        } else log?.info(`promptli: ${peer.address} is not allowed (dmPolicy ${account.dmPolicy})`);
        yield { type: "done", text: "NO_REPLY" };
        return;
      }
    }
    const route = rt.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: "direct", id: peer.contactKey } });
    const messageId = peer.replyToId ?? `promptli-${req.kind}-${Date.now()}`;
    if (checkAccess) {
      auth = await this.authorize(peer, raw, { agentId: route.agentId, sessionKey: route.sessionKey, messageId, inboundEventKind: "user_request" });
      if (!auth.senderAccess.allowed) {
        yield { type: "done", text: "NO_REPLY" };
        return;
      }
    }

    const out = new Pipe<TurnChunk>();
    let streamed = "";
    let finalText = "";
    const onPartial = (p: Payload) => {
      if (p.delta !== undefined) {
        streamed += p.delta;
        out.push({ type: "delta", text: p.delta });
      } else if (typeof p.text === "string" && p.text.startsWith(streamed) && p.text.length > streamed.length) {
        const d = p.text.slice(streamed.length); // cumulative snapshot: forward only what is new
        streamed = p.text;
        out.push({ type: "delta", text: d });
      }
    };
    const label = peer.name ? `${peer.name} <${peer.address}>` : peer.address;
    const run = rt.inbound
      .run({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        raw: { peer, kind: req.kind },
        adapter: {
          ingest: () => ({ id: messageId, timestamp: Date.now(), rawText: raw, textForAgent: req.prompt, textForCommands: raw, raw: { peer } }),
          resolveTurn: async (input: { id: string; timestamp?: number; rawText: string; textForAgent?: string; textForCommands?: string }) => ({
            cfg,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            route: { agentId: route.agentId, sessionKey: route.sessionKey },
            ctxPayload: rt.inbound.buildContext({
              ...(auth ? { channelIngress: auth } : { channelIngress: "unsupported" }),
              channel: CHANNEL_ID,
              accountId: account.accountId,
              messageId: input.id,
              timestamp: input.timestamp,
              from: `${CHANNEL_ID}:${peer.address}`,
              sender: { id: peer.address, name: peer.name ?? peer.address },
              conversation: { kind: "direct", id: peer.contactKey, label },
              route: { agentId: route.agentId, accountId: account.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
              reply: { to: `${peer.channel === "email" ? "email" : "sms"}:${peer.address}` },
              message: { rawBody: input.rawText, commandBody: input.textForCommands, bodyForAgent: input.textForAgent },
              media: [],
              ...(auth?.commandAccess?.requested ? { access: { commands: { authorized: Boolean(auth.commandAccess.authorized) } } } : {}),
              extra: { PromptliMedium: peer.channel, PromptliContactKey: peer.contactKey, PromptliTurnKind: req.kind, ...(peer.replyToId ? { PromptliMessageId: peer.replyToId } : {}) },
            }),
            delivery: {
              deliver: async (payload: Payload) => {
                const text = payload.text ?? "";
                if (!text) return { visibleReplySent: false };
                finalText = finalText ? `${finalText}\n\n${text}` : text;
                return { visibleReplySent: !isNoReply(text) }; // the gateway sends it on the right medium
              },
              onError: (err: unknown) => log?.warn(`promptli: delivery error: ${String(err)}`),
            },
            replyOptions: {
              abortSignal: req.signal,
              onPartialReply: (p: Payload) => onPartial(p),
              onToolStart: (p: { name?: string }) => out.push({ type: "tool", name: String(p.name ?? "tool") }),
            },
          }),
        },
      })
      .then(
        () => {
          out.push({ type: "done", text: finalText || streamed });
          out.close();
        },
        (err: unknown) => {
          out.push({ type: "error", message: (err as Error)?.message ?? String(err) });
          out.close();
        },
      );
    try {
      yield* out;
    } finally {
      await run;
    }
  }
}
