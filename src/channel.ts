// The "promptli" OpenClaw channel: email, SMS and phone calls for the agent over Promptli Agent Link.

import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { CHANNEL_ID, isConfigured, listAccountIds, normalizeAllowEntry, PromptliChannelConfigSchema, resolveAccount, type ResolvedPromptliAccount } from "./config.js";
import { stripMarkdown } from "./framing.js";
import { OpenClawEngine, type ChannelRuntimeLike } from "./openclaw-engine.js";
import { getRunningAccount, resolveAuth, resolveIdentity, startAccount } from "./runtime.js";
import { makeClient } from "./client.js";
import { secretTargetRegistryEntries, collectRuntimeConfigAssignments } from "../secret-contract-api.js";

export type Target = { medium: "email" | "sms"; address: string };

/** `email:jane@x.com`, `sms:+1555…`, `promptli:…`, or a bare address / number. */
export function parseTarget(raw: string): Target | null {
  let t = raw.trim().replace(/^promptli:/i, "");
  const m = /^(email|mail|sms|text|phone|tel):(.*)$/i.exec(t);
  let medium: Target["medium"] | null = null;
  if (m) {
    medium = /^(email|mail)$/i.test(m[1]!) ? "email" : "sms";
    t = m[2]!.trim();
  }
  if (!t) return null;
  if (!medium) medium = t.includes("@") ? "email" : "sms";
  if (medium === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? { medium, address: t.toLowerCase() } : null;
  const num = t.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(num) ? { medium, address: num } : null;
}

function subjectFrom(text: string): string {
  const first = stripMarkdown(text).split("\n").find((l) => l.trim()) ?? "Message";
  return first.length > 78 ? `${first.slice(0, 75)}...` : first;
}

/** Send to a person outside a conversation turn (cron, `openclaw message send`, the message tool). */
export async function sendOutbound(p: { cfg: unknown; accountId?: string | null; to: string; text: string; replyToId?: string | null }): Promise<{ messageId: string }> {
  const target = parseTarget(p.to);
  if (!target) throw new Error("Promptli target must be email:<address> or sms:<+E.164 number>.");
  const account = resolveAccount(p.cfg, p.accountId);
  const live = getRunningAccount(account.accountId);
  const identity = live?.identity ?? resolveIdentity(account);
  const auth = live ? null : resolveAuth(account);
  if (!identity || (!live && !auth)) throw new Error("Promptli is not set up: run `openclaw promptli setup`.");
  const client = live?.client ?? makeClient(auth!, { baseUrl: account.baseUrl });
  const me = client.identity(identity);
  if (target.medium === "email") {
    const m = p.replyToId?.startsWith("msg_")
      ? await me.reply(p.replyToId, { text: p.text })
      : await me.sendEmail({ to: [target.address], subject: subjectFrom(p.text), text: p.text });
    live?.gateway.markSent("email", target.address);
    return { messageId: String(m.id) };
  }
  const t = await client.request<{ id: string }>("POST", `/v1/identities/${encodeURIComponent(identity)}/texts`, { body: { to: target.address, body: stripMarkdown(p.text) } });
  live?.gateway.markSent("sms", target.address);
  return { messageId: String(t.id) };
}

const resolveDmPolicy = createScopedDmSecurityResolver<ResolvedPromptliAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (a) => a.dmPolicy,
  resolveAllowFrom: (a) => a.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "open",
  approveHint: "openclaw pairing approve promptli <code>",
  normalizeEntry: normalizeAllowEntry,
});

export const promptliPlugin: ChannelPlugin<ResolvedPromptliAccount> = createChatChannelPlugin<ResolvedPromptliAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Promptli Comms",
      selectionLabel: "Promptli Comms (email, SMS, phone)",
      detailLabel: "Email, SMS and phone calls",
      docsPath: "https://github.com/promptli-dev/promptli-openclaw-plugin#readme",
      docsLabel: "promptli",
      blurb: "Give the agent its own email address and phone number. No webhooks or tunnels.",
      order: 90,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: true,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: PromptliChannelConfigSchema,
    config: {
      listAccountIds: (cfg) => listAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      defaultAccountId: (cfg) => listAccountIds(cfg)[0]!,
      isConfigured: (account) => isConfigured(account) || Boolean(resolveIdentity(account)),
      unconfiguredReason: () => "Run `openclaw promptli setup` to log in and pick an agent.",
      resolveAllowFrom: ({ cfg, accountId }) => resolveAccount(cfg, accountId).allowFrom,
      formatAllowFrom: ({ allowFrom }) => allowFrom.map((e) => normalizeAllowEntry(String(e))),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: resolveIdentity(account) ?? "Promptli",
        configured: Boolean(resolveIdentity(account)),
        enabled: account.enabled,
      }),
    },
    messaging: {
      normalizeTarget: (raw: string) => {
        const t = parseTarget(raw);
        return t ? `${t.medium}:${t.address}` : undefined;
      },
      targetResolver: { looksLikeId: (raw: string) => parseTarget(raw) !== null, hint: "<email:jane@example.com | sms:+15551234567>" },
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const identity = resolveIdentity(account);
        const auth = resolveAuth(account);
        if (!identity || !auth) {
          ctx.log?.warn?.("promptli: not set up; run `openclaw promptli setup`");
          return;
        }
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("promptli: channel runtime is not available; not starting");
          return;
        }
        const rt = ctx.channelRuntime as unknown as ChannelRuntimeLike;
        const log = {
          info: (m: string) => ctx.log?.info?.(m),
          warn: (m: string) => ctx.log?.warn?.(m),
          error: (m: string) => ctx.log?.error?.(m),
          debug: (m: string) => ctx.log?.debug?.(m),
        };
        await startAccount({
          account,
          auth,
          identity,
          abortSignal: ctx.abortSignal,
          log,
          onStatus: (s) => ctx.setStatus({ ...ctx.getStatus(), accountId: account.accountId, running: true, connected: s.connected, lastError: s.lastError, lastInboundAt: s.lastInboundAt }),
          makeEngine: ({ sendPairingReply }) =>
            new OpenClawEngine({
              cfg: ctx.cfg,
              account,
              rt,
              log,
              sendPairingReply,
              issuePairingChallenge: async (p) => {
                const issue = createChannelPairingChallengeIssuer({
                  channel: CHANNEL_ID,
                  accountId: account.accountId,
                  upsertPairingRequest: async (input) => (await rt.pairing.upsertPairingRequest({ channel: CHANNEL_ID, accountId: account.accountId, ...input })) as never,
                });
                await issue({ ...p, onReplyError: (err: unknown) => log.warn(`promptli: pairing reply failed: ${String(err)}`) });
              },
            }),
        });
      },
    },
    secrets: { secretTargetRegistryEntries, collectRuntimeConfigAssignments },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### Promptli Comms (email, SMS, phone)",
        "Targets are email:<address> or sms:<+E.164>. SMS is plain text: keep it short, no markdown.",
        "Use the promptli_* tools to reply in an email thread, place or schedule calls, or read past conversations.",
      ],
    },
  },
  security: {
    resolveDmPolicy,
    collectWarnings: ({ account }) =>
      account.dmPolicy === "open" && account.allowFrom.includes("*")
        ? ['- Promptli: dmPolicy="open" lets anyone who has the agent\'s address or number message it. Keep the agent\'s tools tight.']
        : [],
  },
  pairing: {
    text: {
      idLabel: "emailOrPhone",
      message: "Your access to this agent has been approved.",
      normalizeAllowEntry: normalizeAllowEntry,
      notify: async ({ cfg, id, message, accountId }) => {
        await sendOutbound({ cfg, accountId, to: id, text: message });
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 1500,
    resolveTarget: ({ to }) => {
      const t = parseTarget(to ?? "");
      return t ? { ok: true, to: `${t.medium}:${t.address}` } : { ok: false, error: new Error("Promptli target must be email:<address> or sms:<+E.164 number>.") };
    },
    sendText: async (ctx) => {
      const r = await sendOutbound({ cfg: ctx.cfg, accountId: ctx.accountId, to: ctx.to, text: ctx.text, replyToId: ctx.replyToId ?? null });
      return { channel: CHANNEL_ID, messageId: r.messageId };
    },
  },
});
