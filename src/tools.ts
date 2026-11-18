// Promptli tools for the OpenClaw agent: email, SMS, calls, contacts and conversations.
// Runtime-agnostic specs (JSON Schema parameters + async handler); index.ts registers them with OpenClaw.
// Port of promptli_gateway/tools/{comms,calls}.py, with tool names prefixed `promptli_`.

import type { Promptli } from "@promptli-npm/sdk";
import type { Json } from "./framing.js";
import type { LiveCalls } from "./voice.js";

export type ToolResult = Json & { ok: boolean };
export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  parameters: Json;
  handler: (args: Json) => Promise<ToolResult>;
  readOnly?: boolean;
  /** Places calls or sends to new people: OpenClaw registers these as optional (owner must allowlist). */
  optional?: boolean;
};

const STR = { type: "string" } as const;
const STR_LIST = { type: "array", items: { type: "string" } } as const;
const INT = { type: "integer" } as const;
const BOOL = { type: "boolean" } as const;

function obj(properties: Json, required: string[] = []): Json {
  return { type: "object", properties, required, additionalProperties: false };
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
}

export function errorResult(e: unknown): ToolResult {
  const err = e as { code?: string; message?: string; details?: unknown };
  return { ok: false, error: err.code ?? "tool_failed", message: err.message ?? String(e), ...(err.details ? { details: err.details } : {}) };
}

// ---- calling rules -------------------------------------------------------------------------------------

/** TRAI: calls to Indian numbers only 09:00–21:00 IST. Returns a reason when the call must not be placed. */
export function callingHoursBlock(to: string, now: Date = new Date()): string | null {
  if (!to.replace(/\s/g, "").startsWith("+91")) return null;
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes >= 9 * 60 && minutes < 21 * 60) return null;
  return "Calls to Indian (+91) numbers are only allowed 9 AM to 9 PM IST (TRAI). Schedule it with promptli_schedule_call instead, or send a text.";
}

export type ToolDeps = {
  client: Promptli;
  identity: string;
  /** Called after every successful send so the gateway skips its own auto-reply to that person. */
  onSend: (channel: "email" | "sms", recipient: string) => void;
  calls?: LiveCalls;
  now?: () => Date;
};

export function promptliTools(d: ToolDeps): ToolSpec[] {
  const me = () => d.client.identity(d.identity);
  const run =
    (fn: (a: Json) => Promise<ToolResult>) =>
    async (a: Json): Promise<ToolResult> => {
      try {
        return await fn(a ?? {});
      } catch (e) {
        return errorResult(e);
      }
    };
  const live = (a: Json) => d.calls?.get(String(a.call_id ?? ""));

  return [
    // ---- email ----
    {
      name: "promptli_send_email",
      label: "Send email",
      description: "Send a new email from your Promptli agent mailbox. To answer an email, use promptli_reply_email instead.",
      parameters: obj({ to: STR_LIST, subject: STR, text: STR, html: STR, cc: STR_LIST }, ["to", "subject", "text"]),
      handler: run(async (a) => {
        const to = list(a.to);
        const m = await me().sendEmail({ to, subject: String(a.subject ?? ""), text: a.text, html: a.html, cc: a.cc ? list(a.cc) : undefined });
        for (const r of to) d.onSend("email", r.toLowerCase());
        return { ok: true, message_id: m.id, status: m.status };
      }),
    },
    {
      name: "promptli_reply_email",
      label: "Reply to email",
      description: "Reply to an email in its thread. reply_all=true includes everyone on the thread.",
      parameters: obj({ message_id: STR, text: STR, html: STR, reply_all: BOOL }, ["message_id", "text"]),
      handler: run(async (a) => {
        const path = `/v1/identities/${encodeURIComponent(d.identity)}/mail/messages/${encodeURIComponent(String(a.message_id))}/${a.reply_all ? "reply-all" : "reply"}`;
        const m = await d.client.request<Json>("POST", path, { body: { text: a.text, ...(a.html ? { html: a.html } : {}) } });
        for (const r of list(m.to)) d.onSend("email", r.toLowerCase());
        return { ok: true, message_id: m.id, status: m.status };
      }),
    },
    {
      name: "promptli_read_email",
      label: "Read email",
      description: "Read one email (headers and text body) by message id.",
      parameters: obj({ message_id: STR }, ["message_id"]),
      readOnly: true,
      handler: run(async (a) => {
        const m = await d.client.request<Json>("GET", `/v1/identities/${encodeURIComponent(d.identity)}/mail/messages/${encodeURIComponent(String(a.message_id))}`);
        const { html: _html, ...rest } = m;
        return { ok: true, ...rest };
      }),
    },
    {
      name: "promptli_search_email",
      label: "Search email",
      description: "Full-text search the agent mailbox (sender, recipients, subject, body).",
      parameters: obj({ query: STR, limit: INT }, ["query"]),
      readOnly: true,
      handler: run(async (a) => {
        const res = await d.client.request<{ data: Json[] }>("GET", `/v1/identities/${encodeURIComponent(d.identity)}/mail/search`, { query: { q: String(a.query), limit: Number(a.limit ?? 10) } });
        return { ok: true, messages: (res.data ?? []).map(({ html: _h, text: _t, ...m }) => m) };
      }),
    },
    // ---- sms ----
    {
      name: "promptli_send_text",
      label: "Send SMS",
      description: "Send an SMS from the agent's phone number. Recipients are E.164 numbers like +15551234567 (several = a group text). Keep it short and plain.",
      parameters: obj({ to: STR_LIST, text: STR }, ["to", "text"]),
      handler: run(async (a) => {
        const to = list(a.to);
        const t = await d.client.request<Json>("POST", `/v1/identities/${encodeURIComponent(d.identity)}/texts`, { body: { to: to.length === 1 ? to[0] : to, body: String(a.text) } });
        for (const r of to) d.onSend("sms", r);
        return { ok: true, text_id: t.id, status: t.status };
      }),
    },
    // ---- people ----
    {
      name: "promptli_list_conversations",
      label: "List conversations",
      description: "People the agent talks to, most recent first, across email, SMS and calls.",
      parameters: obj({ limit: INT }),
      readOnly: true,
      handler: run(async (a) => ({ ok: true, conversations: await me().conversations(Number(a.limit ?? 20)) })),
    },
    {
      name: "promptli_get_conversation",
      label: "Get conversation",
      description: "Full timeline (email, SMS, calls) and contact card for one person, by contact_key from promptli_list_conversations.",
      parameters: obj({ contact_key: STR, limit: INT }, ["contact_key"]),
      readOnly: true,
      handler: run(async (a) => ({ ok: true, ...(await me().conversation(String(a.contact_key), Number(a.limit ?? 30))) })),
    },
    {
      name: "promptli_lookup_contact",
      label: "Look up contact",
      description: "Find a contact by email or phone number.",
      parameters: obj({ email: STR, phone: STR }),
      readOnly: true,
      handler: run(async (a) => ({ ok: true, contact: await d.client.contacts.lookup({ email: a.email, phone: a.phone }) })),
    },
    {
      name: "promptli_add_contact_memory",
      label: "Remember about contact",
      description: "Remember a fact about a contact (shared with every agent and with calls).",
      parameters: obj({ contact_id: STR, memory: STR }, ["contact_id", "memory"]),
      handler: run(async (a) => ({ ok: true, contact: await d.client.contacts.remember(String(a.contact_id), String(a.memory)) })),
    },
    {
      name: "promptli_channel_status",
      label: "Channel status",
      description: "Which channels (email, SMS, voice, Agent Link) are ready, and what blocks them.",
      parameters: obj({}),
      readOnly: true,
      handler: run(async () => ({ ok: true, ...(await me().channelStatus()) })),
    },
    // ---- calls ----
    {
      name: "promptli_place_call",
      label: "Place phone call",
      description:
        "Phone someone. You talk live when they answer (hosted=true: the Promptli voice assistant talks from a brief built from reason/context and you supervise). " +
        "`opening` is spoken first and must say you are an AI assistant; `voicemail_message` is left if a machine answers. Only call people the owner asked you to call.",
      parameters: obj({ to: STR, reason: STR, opening: STR, context: STR, voicemail_message: STR, hosted: BOOL }, ["to", "reason"]),
      optional: true,
      handler: run(async (a) => {
        const to = String(a.to);
        const blocked = callingHoursBlock(to, d.now?.());
        if (blocked) return { ok: false, error: "outside_calling_hours", message: blocked };
        const c = await me().placeCall(to, {
          reason: a.reason,
          opening: a.opening,
          context: a.context,
          voicemail_message: a.voicemail_message,
          ...(a.hosted ? { mode: "hosted" as const } : {}),
        });
        return { ok: true, call_id: c.id, status: c.status };
      }),
    },
    {
      name: "promptli_schedule_call",
      label: "Schedule phone call",
      description: "Place a call later. run_at is ISO 8601 with a timezone. For +91 numbers pick 9 AM-9 PM IST.",
      parameters: obj({ to: STR, run_at: STR, reason: STR, opening: STR, context: STR }, ["to", "run_at", "reason"]),
      optional: true,
      handler: run(async (a) => {
        const blocked = callingHoursBlock(String(a.to), new Date(String(a.run_at)));
        if (blocked) return { ok: false, error: "outside_calling_hours", message: blocked };
        const s = await me().scheduleCall(String(a.to), String(a.run_at), { reason: a.reason, opening: a.opening, context: a.context });
        return { ok: true, scheduled: s };
      }),
    },
    {
      name: "promptli_list_calls",
      label: "List calls",
      description: "Recent calls with status, outcome and duration.",
      parameters: obj({ limit: INT }),
      readOnly: true,
      handler: run(async (a) => ({ ok: true, calls: await me().calls(Number(a.limit ?? 10)) })),
    },
    {
      name: "promptli_get_call_transcript",
      label: "Call transcript",
      description: "The transcript of a call (caller and agent turns).",
      parameters: obj({ call_id: STR }, ["call_id"]),
      readOnly: true,
      handler: run(async (a) => {
        const t = (await d.client.calls.transcript(String(a.call_id))) as Json;
        return { ok: true, segments: (t.segments ?? []).map((s: Json) => ({ party: s.party, text: s.text })) };
      }),
    },
    // ---- live call control (only work during a call this gateway is running) ----
    {
      name: "promptli_end_call",
      label: "End call",
      description: "Hang up the live call, optionally saying a last line (a goodbye) first.",
      parameters: obj({ call_id: STR, say: STR }, ["call_id"]),
      handler: run(async (a) => {
        const c = live(a);
        if (!c) return { ok: false, error: "call_not_active" };
        c.hangup(a.say);
        return { ok: true };
      }),
    },
    {
      name: "promptli_transfer_call",
      label: "Transfer call",
      description: "Transfer the live call to another E.164 number, optionally saying something first.",
      parameters: obj({ call_id: STR, to: STR, say: STR }, ["call_id", "to"]),
      handler: run(async (a) => {
        const c = live(a);
        if (!c) return { ok: false, error: "call_not_active" };
        c.transfer(String(a.to), a.say);
        return { ok: true };
      }),
    },
    {
      name: "promptli_send_dtmf",
      label: "Press keypad keys",
      description: "Press keypad keys on the live call (navigate a phone menu), e.g. '1' or '1234#'.",
      parameters: obj({ call_id: STR, digits: STR }, ["call_id", "digits"]),
      handler: run(async (a) => {
        const c = live(a);
        if (!c) return { ok: false, error: "call_not_active" };
        c.dtmf(String(a.digits));
        return { ok: true };
      }),
    },
    // ---- steering hosted calls (the Promptli assistant talks) ----
    {
      name: "promptli_call_add_fact",
      label: "Add call fact",
      description: "Give the hosted voice assistant a fact it can rely on for the rest of the call.",
      parameters: obj({ call_id: STR, text: STR }, ["call_id", "text"]),
      handler: run(async (a) => ({ ok: true, version: (await d.client.calls.addFact(String(a.call_id), String(a.text))).version })),
    },
    {
      name: "promptli_call_guidance",
      label: "Guide call",
      description: "Private guidance for the voice assistant's next reply (the caller never hears it).",
      parameters: obj({ call_id: STR, text: STR }, ["call_id", "text"]),
      handler: run(async (a) => {
        await d.client.calls.guide(String(a.call_id), String(a.text));
        return { ok: true };
      }),
    },
  ];
}
