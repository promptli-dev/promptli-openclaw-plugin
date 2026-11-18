// The gateway loop: Agent Link events → one OpenClaw conversation per person → reply on the same medium.
// Port of promptli_gateway/core.py.
//
// - Dedupe by event id and ack a *low watermark* of fully processed seqs, so a crash in the middle of a
//   turn never skips an event on restart.
// - One FIFO worker per contact; texts from one person within `batchWindowMs` become one turn.
// - If the agent already replied with a tool (promptli_send_email / _send_text / _reply_email) to that person
//   during the turn, the automatic reply is skipped.

import type { Promptli } from "@promptli-npm/sdk";
import type { Peer, TurnEngine } from "./engine.js";
import { frameEmail, frameTexts, frameVoicemail, isNoReply, splitSms, stripMarkdown, type Json } from "./framing.js";
import type { Logger } from "./link.js";
import type { LinkState } from "./state.js";

export type GatewayOptions = {
  client: Promptli;
  identity: string;
  engine: TurnEngine;
  state: LinkState;
  ack: (seq: number) => void;
  autoReply?: boolean;
  batchWindowMs?: number;
  /** Return false to drop an inbound sender (OpenClaw allowFrom / dmPolicy). */
  allowSender?: (peer: Peer) => boolean;
  log?: Logger;
};

type Job = { peer: Peer; medium: "email" | "sms" | "voicemail" };

export class Gateway {
  identityAddress: string | null = null;
  identityNumber: string | null = null;
  turnsCompleted = 0;
  lastInboundAt: number | null = null;
  lastError: string | null = null;
  // One FIFO per person (one OpenClaw session), but every item keeps its own medium: an email followed by a
  // text from the same person must not be framed or answered as the first item's medium.
  private queues = new Map<string, { items: { job: Job; event: Json }[]; running: boolean }>();
  private pending = new Set<number>();
  private maxSeen = 0;
  private sentMarks = new Map<string, number>();
  private idle: Promise<void>[] = [];

  constructor(private readonly o: GatewayOptions) {}

  markSent = (channel: "email" | "sms", recipient: string): void => {
    this.sentMarks.set(`${channel}:${recipient}`, Date.now());
  };

  /** Resolves when every queued turn has finished (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.idle.length) await Promise.allSettled(this.idle.splice(0));
  }

  // ---- intake ------------------------------------------------------------------------------------------
  async handleEvent(event: Json): Promise<void> {
    if (event?.seq === undefined || !event.id) return;
    const seq = Number(event.seq);
    this.maxSeen = Math.max(this.maxSeen, seq);
    if (this.o.state.seen(event.id)) return this.advance();
    const job = this.route(event);
    if (!job || (this.o.allowSender && !this.o.allowSender(job.peer))) {
      if (job) this.o.log?.info(`promptli: dropped ${job.medium} from ${job.peer.address} (not allowed by channels.promptli.allowFrom)`);
      this.o.state.markProcessed(event.id);
      return this.advance();
    }
    this.lastInboundAt = Date.now();
    this.pending.add(seq);
    const key = job.peer.contactKey;
    let q = this.queues.get(key);
    if (!q) {
      q = { items: [], running: false };
      this.queues.set(key, q);
    }
    q.items.push({ job, event });
    if (!q.running) {
      q.running = true;
      this.idle.push(this.worker(key));
    }
  }

  route(event: Json): Job | null {
    const data = event.data ?? {};
    if (event.type === "message.received") {
      const m = data.message ?? {};
      if (m.folder && m.folder !== "inbox") return null;
      const from = String(m.from ?? "").toLowerCase();
      if (!from || (this.identityAddress && from === this.identityAddress.toLowerCase())) return null; // our own loopback copy
      const name = data.contacts?.[0]?.name;
      return {
        medium: "email",
        peer: { channel: "email", contactKey: data.contact_key ?? `email:${from}`, address: from, replyToId: m.id, ...(name ? { name } : {}) },
      };
    }
    if (event.type === "text.received") {
      if (data.keyword) return null; // STOP/START/HELP are handled by the platform
      const conv = data.conversation ?? {};
      const from = String(data.text?.from ?? "");
      const key = conv.is_group ? `sms-group:${conv.id}` : (data.contact_key ?? `sms:${from}`);
      const name = data.contacts?.[0]?.name;
      return { medium: "sms", peer: { channel: "sms", contactKey: key, address: from, ...(name ? { name } : {}) } };
    }
    if (event.type === "call.ended") {
      const call = data.call ?? {};
      if (call.outcome !== "voicemail") return null; // live calls already ran as voice turns
      return { medium: "voicemail", peer: { channel: "voice", contactKey: data.contact_key ?? `phone:${call.from}`, address: String(call.from ?? "") } };
    }
    return null;
  }

  private advance(): void {
    const watermark = this.pending.size ? Math.min(...this.pending) - 1 : this.maxSeen;
    if (this.o.state.setCursor(watermark)) this.o.ack(watermark);
  }

  // ---- per-contact worker --------------------------------------------------------------------------------
  private async worker(key: string): Promise<void> {
    const q = this.queues.get(key)!;
    try {
      while (q.items.length) {
        const job = q.items[0]!.job;
        if (job.medium === "sms") await sleep(this.o.batchWindowMs ?? 1500);
        // Texts batch with the texts right behind them; anything else is a turn of its own.
        let n = 1;
        if (job.medium === "sms") while (n < q.items.length && q.items[n]!.job.medium === "sms") n++;
        const batch = q.items.splice(0, n).map((i) => i.event);
        try {
          await this.runTurn(job, batch);
        } catch (e) {
          this.lastError = (e as Error).message;
          this.o.log?.error(`promptli: turn failed for ${key}: ${(e as Error).message}`);
        } finally {
          for (const ev of batch) {
            this.o.state.markProcessed(ev.id);
            this.pending.delete(Number(ev.seq));
          }
          this.advance();
        }
      }
    } finally {
      q.running = false;
      if (q.items.length) {
        q.running = true;
        this.idle.push(this.worker(key));
      } else this.queues.delete(key);
    }
  }

  private async runTurn(job: Job, batch: Json[]): Promise<void> {
    let prompt: string;
    let raw: string;
    let peer = job.peer;
    if (job.medium === "voicemail") {
      prompt = frameVoicemail(batch[0]!);
      raw = "(voicemail)";
    } else if (job.medium === "email") {
      const m = batch[0]!.data.message;
      prompt = frameEmail(batch[0]!, this.identityAddress);
      raw = String(m.text ?? m.subject ?? "");
      peer = { ...peer, replyToId: m.id };
    } else {
      prompt = frameTexts(batch, this.identityNumber);
      raw = batch.map((e) => String(e.data.text.body ?? "")).join("\n");
    }
    const started = Date.now();
    let final = "";
    const parts: string[] = [];
    for await (const chunk of this.o.engine.runTurn({ peer, prompt, raw, kind: "channel", signal: new AbortController().signal })) {
      if (chunk.type === "delta") parts.push(chunk.text);
      else if (chunk.type === "done") final = chunk.text || parts.join("");
      else if (chunk.type === "error") {
        this.lastError = chunk.message;
        this.o.log?.warn(`promptli: turn error for ${peer.contactKey}: ${chunk.message}`);
        return;
      }
    }
    this.turnsCompleted += 1;
    if (job.medium === "voicemail" || this.o.autoReply === false || isNoReply(final)) return;
    if ((this.sentMarks.get(`${job.medium}:${peer.address}`) ?? 0) >= started) return; // already replied with a tool
    try {
      await this.deliver(job.medium, batch, final);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      this.lastError = `${err.code ?? "error"}: ${err.message}`;
      this.o.log?.warn(`promptli: auto-reply failed (${err.code ?? "error"}): ${err.message}`);
    }
  }

  /** Send the agent's final answer back on the medium the person used. */
  async deliver(medium: "email" | "sms", batch: Json[], text: string): Promise<void> {
    const me = this.o.client.identity(this.o.identity);
    if (medium === "email") {
      await me.reply(batch[batch.length - 1]!.data.message.id, { text: text.trim() });
      return;
    }
    const data = batch[batch.length - 1]!.data;
    const conv = data.conversation ?? {};
    const recipients: string[] = conv.is_group ? (conv.remotes ?? []) : [data.text.from];
    const to = recipients.length === 1 ? recipients[0] : recipients;
    for (const part of splitSms(stripMarkdown(text))) {
      await this.o.client.request("POST", `/v1/identities/${encodeURIComponent(this.o.identity)}/texts`, { body: { to, body: part } });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
