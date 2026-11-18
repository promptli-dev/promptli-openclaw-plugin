// channels.promptli in openclaw.json. One account = one Promptli agent identity.
//
//   "channels": { "promptli": { "identity": "glow", "dmPolicy": "open", "allowFrom": ["*"] } }
//
// Credentials are not stored here: `openclaw promptli setup` keeps a browser login in
// ~/.promptli/openclaw/credentials (mode 600). PROMPTLI_API_KEY or `apiKey` (a SecretRef) override it.

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
  DmPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { DEFAULT_BASE_URL } from "./auth.js";

export const CHANNEL_ID = "promptli";

export const PromptliAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    /** Agent handle on Promptli Comms (set by `openclaw promptli setup`). */
    identity: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: buildSecretInputSchema().optional(),
    /** Stable Agent Link instance id; reconnects with the same id resume where they left off. */
    instanceId: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("open"),
    allowFrom: AllowFromListSchema,
    /** Send the agent's final answer back on the medium the person used. */
    autoReply: z.boolean().optional(),
    /** Texts from one person within this window become one turn. */
    batchWindowMs: z.number().int().min(0).max(30_000).optional(),
    /** Answer live phone calls (Agent Link voice). */
    voice: z.boolean().optional(),
  })
  .strict();

export const PromptliConfigSchema = buildMultiAccountChannelSchema(PromptliAccountConfigSchema, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireChannelOpenAllowFrom({ channel: CHANNEL_ID, policy: value.dmPolicy, allowFrom: value.allowFrom, ctx, requireOpenAllowFrom });
  },
});

export const PromptliChannelConfigSchema = buildChannelConfigSchema(PromptliConfigSchema, {
  uiHints: {
    "": { label: "Promptli Comms", help: "Email, SMS and phone calls for this agent over Promptli Agent Link (no webhooks or tunnels)." },
    identity: { label: "Agent handle", help: "Your Promptli agent identity. `openclaw promptli setup` fills it in." },
    apiKey: { label: "API key", help: "Optional identity-scoped key (psk_…). Leave empty to use the browser login from `openclaw promptli setup`." },
    dmPolicy: { label: "Who can reach the agent", help: '"open" (anyone with the address or number; needs allowFrom ["*"]), "allowlist", "pairing" or "disabled".' },
    allowFrom: { label: "Allow from", help: "Email addresses or E.164 numbers allowed to reach the agent, or * when dmPolicy is open." },
    voice: { label: "Answer calls", help: "Answer live phone calls with this agent (default on)." },
  },
});

export type ResolvedPromptliAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  identity: string | null;
  baseUrl: string;
  apiKey: string | null;
  instanceId: string | null;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: string[];
  autoReply: boolean;
  batchWindowMs: number;
  voice: boolean;
};

type Section = Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> };

export function channelSection(cfg: unknown): Section {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  return ((channels?.[CHANNEL_ID] as Section | undefined) ?? {}) as Section;
}

export function listAccountIds(cfg: unknown): string[] {
  const named = Object.keys(channelSection(cfg).accounts ?? {});
  return named.length ? named : [DEFAULT_ACCOUNT_ID];
}

export function normalizeAllowEntry(entry: string): string {
  const e = entry.trim();
  if (e === "*") return e;
  if (e.includes("@")) return e.toLowerCase();
  return e.replace(/[\s().-]/g, "");
}

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedPromptliAccount {
  const section = channelSection(cfg);
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const { accounts: _accounts, ...base } = section;
  const merged: Record<string, unknown> = { ...base, ...(section.accounts?.[id] ?? {}) };
  const dmPolicy = (merged.dmPolicy as ResolvedPromptliAccount["dmPolicy"] | undefined) ?? "open";
  const allowFrom = Array.isArray(merged.allowFrom) ? merged.allowFrom.map((x) => normalizeAllowEntry(String(x))) : dmPolicy === "open" ? ["*"] : [];
  return {
    accountId: id,
    ...(typeof merged.name === "string" ? { name: merged.name } : {}),
    enabled: merged.enabled !== false,
    identity: typeof merged.identity === "string" && merged.identity ? merged.identity : null,
    baseUrl: typeof merged.baseUrl === "string" && merged.baseUrl ? merged.baseUrl : process.env.PROMPTLI_BASE_URL || DEFAULT_BASE_URL,
    apiKey: typeof merged.apiKey === "string" && merged.apiKey ? merged.apiKey : null, // a SecretRef resolves to a string at runtime
    instanceId: typeof merged.instanceId === "string" ? merged.instanceId : null,
    dmPolicy,
    allowFrom,
    autoReply: merged.autoReply !== false,
    batchWindowMs: typeof merged.batchWindowMs === "number" ? merged.batchWindowMs : 1500,
    voice: merged.voice !== false,
  };
}

export function isConfigured(account: ResolvedPromptliAccount): boolean {
  return Boolean(account.identity);
}
