// Live calls over Agent Link (voice, "Mode C"): Promptli does telephony, speech-to-text, text-to-speech,
// turn-taking, fillers and barge-in; the OpenClaw agent produces every word. Port of
// promptli_gateway/voice.py + promptli/calls_live.py.
//
// Each final caller utterance becomes a `voice` turn in the same OpenClaw session the person uses for email
// and SMS. The reply is streamed back as `call.text` deltas (speech-filtered) so the caller hears the first
// words while the agent is still writing. A barge-in aborts the running turn; the next turn says what the
// caller actually heard. When the call ends, a `post_call` turn lets the agent do follow-ups with tools.

import type { TurnEngine, Peer } from "./engine.js";
import { frameCallDtmf, frameCallGuidance, frameCallStart, frameCallTurn, framePostCall, isNoReply, type Json } from "./framing.js";
import type { Logger } from "./link.js";
import { SpeechFilter, speakable } from "./speech.js";

export const SORRY = "Sorry, I ran into a problem there. Could you say that again?";

export class LiveCall {
  readonly callId: string;
  ended = false;
  stopReason: string | null = null;

  constructor(
    private readonly send: (frame: Json) => void,
    readonly incoming: Json,
  ) {
    this.callId = String(incoming.call_id);
  }

  get direction(): string {
    return String(this.incoming.direction ?? "inbound");
  }
  get remoteNumber(): string {
    return String((this.direction === "inbound" ? this.incoming.from : this.incoming.to) ?? "");
  }
  get contactKey(): string {
    return String(this.incoming.contact_key ?? `phone:${this.remoteNumber}`);
  }

  private frame(f: Json): void {
    if (this.ended) return;
    try {
      this.send({ ...f, call_id: this.callId });
    } catch {
      /* link dropped; Promptli ends the call */
    }
  }
  accept(): void {
    this.frame({ type: "call.accept" });
  }
  decline(): void {
    this.frame({ type: "call.decline" });
  }
  text(turnId: string, delta: string, done = false): void {
    this.frame({ type: "call.text", turn_id: turnId, delta, done });
  }
  say(text: string, turnId: string): void {
    this.text(turnId, text, true);
  }
  filler(phrase?: string): void {
    this.frame({ type: "call.filler", ...(phrase ? { phrase } : {}) });
  }
  hangup(say?: string): void {
    this.frame({ type: "call.hangup", ...(say ? { say } : {}) });
  }
  transfer(to: string, say?: string): void {
    this.frame({ type: "call.transfer", to, ...(say ? { say } : {}) });
  }
  dtmf(digits: string): void {
    this.frame({ type: "call.dtmf", digits });
  }
}

export interface LiveCalls {
  get(callId: string): LiveCall | undefined;
}

type CallRun = { call: LiveCall; push: (f: Json) => void };

/** Routes call.* frames to calls and runs each one against the engine. */
export class CallDriver implements LiveCalls {
  private calls = new Map<string, CallRun>();
  turnsCompleted = 0;

  constructor(
    private readonly engine: TurnEngine,
    private readonly opts: {
      send: (frame: Json) => void;
      identityName: () => string;
      enabled: () => boolean;
      postCallTurn?: boolean;
      log?: Logger;
    },
  ) {}

  get(callId: string): LiveCall | undefined {
    return this.calls.get(callId)?.call;
  }

  get active(): number {
    return this.calls.size;
  }

  /** The link dropped or the gateway is stopping: live frames will not resume, so end every call. */
  endAll(reason: string): void {
    for (const run of this.calls.values()) run.push({ type: "call.stop", call_id: run.call.callId, reason });
  }

  /** Returns true when the frame was a live-call frame (handled here). */
  handle(frame: Json): boolean {
    const kind = String(frame.type ?? "");
    if (!kind.startsWith("call.") || "seq" in frame) return false;
    const callId = String(frame.call_id ?? "");
    if (kind === "call.supervise") {
      // Hosted calls: the Promptli assistant talks. Steering from OpenClaw goes through the
      // promptli_call_add_fact / promptli_call_guidance tools, so we do not take the supervisor seat.
      new LiveCall(this.opts.send, frame).decline();
      return true;
    }
    if (kind === "call.incoming") {
      const call = new LiveCall(this.opts.send, frame);
      if (!this.opts.enabled()) {
        call.decline();
        return true;
      }
      const queue: Json[] = [];
      let wake: (() => void) | null = null;
      const push = (f: Json) => {
        queue.push(f);
        wake?.();
      };
      this.calls.set(callId, { call, push });
      const frames = async function* (): AsyncGenerator<Json> {
        for (;;) {
          while (queue.length) {
            const f = queue.shift()!;
            if (f.type === "call.stop") {
              call.stopReason = String(f.reason ?? "");
              return;
            }
            yield f;
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      };
      void this.run(call, frames()).finally(() => this.calls.delete(callId));
      return true;
    }
    this.calls.get(callId)?.push(frame);
    return true;
  }

  private peer(call: LiveCall): Peer {
    const name = call.incoming.contact?.name;
    return { channel: "voice", contactKey: call.contactKey, address: call.remoteNumber, ...(name ? { name: String(name) } : {}) };
  }

  private async run(call: LiveCall, frames: AsyncGenerator<Json>): Promise<void> {
    call.accept();
    const info: Json = { ...call.incoming };
    let header: string | null = null;
    let barge: Json | null = null;
    const guidance: string[] = [];
    const guidanceTurns = new Map<string, string>();
    const interrupted = new Set<string>();
    const cur: { turn: { abort: AbortController; done: Promise<void> } | null } = { turn: null };

    const stopRunning = async () => {
      const t = cur.turn;
      if (!t) return;
      t.abort.abort();
      await t.done.catch(() => undefined);
      cur.turn = null;
    };
    const startTurn = async (turnId: string, prompt: string) => {
      await stopRunning();
      if (header) {
        prompt = `${header}\n\n${prompt}`;
        header = null;
      }
      const abort = new AbortController();
      cur.turn = { abort, done: this.voiceTurn(call, turnId, prompt, abort.signal, interrupted) };
    };

    try {
      for await (const f of frames) {
        const kind = f.type;
        if (kind === "call.start") {
          const greet = Boolean(f.greet);
          info.opening = f.opening ?? info.opening;
          const start = frameCallStart(info, { greet, identityName: this.opts.identityName() });
          if (greet) await startTurn(String(f.turn_id ?? "t0"), start);
          else header = start;
        } else if (kind === "call.transcript" && f.is_final && f.turn_id) {
          let prompt = frameCallTurn(String(f.text ?? ""), barge);
          barge = null;
          if (guidance.length) {
            prompt = guidance.map(frameCallGuidance).join("\n") + "\n" + prompt;
            guidance.length = 0;
          }
          await startTurn(String(f.turn_id), prompt);
        } else if (kind === "call.guidance" && f.text) {
          if (f.turn_id) {
            guidanceTurns.set(String(f.turn_id), String(f.text));
            await startTurn(String(f.turn_id), frameCallGuidance(String(f.text)));
          } else guidance.push(String(f.text));
        } else if (kind === "call.barge_in") {
          barge = f;
          const cut = String(f.turn_id ?? "");
          interrupted.add(cut);
          if (guidanceTurns.has(cut) && !String(f.spoken_so_far ?? "").trim()) {
            guidance.push(guidanceTurns.get(cut)!);
            guidanceTurns.delete(cut);
          }
          cur.turn?.abort.abort();
        } else if (kind === "call.dtmf" && f.digits) {
          await startTurn(`d${call.callId.length}${f.digits}`, frameCallDtmf(String(f.digits)));
        }
      }
    } catch (e) {
      this.opts.log?.error(`promptli: call ${call.callId} failed: ${(e as Error).message}`);
    } finally {
      call.ended = true;
      await stopRunning();
    }
    if (this.opts.postCallTurn ?? true) await this.postCall(call, info);
  }

  private async voiceTurn(call: LiveCall, turnId: string, prompt: string, signal: AbortSignal, cutOff: Set<string>): Promise<void> {
    const speech = new SpeechFilter();
    let sent = false;
    let fillerSent = false;
    let final = "";
    try {
      for await (const chunk of this.engine.runTurn({ peer: this.peer(call), prompt, kind: "voice", signal })) {
        if (signal.aborted) return;
        if (chunk.type === "delta") {
          const spoken = speech.feed(chunk.text);
          if (spoken.trim() || (sent && spoken)) {
            call.text(turnId, spoken);
            sent = true;
          }
        } else if (chunk.type === "tool") {
          if (!sent && !fillerSent) {
            call.filler();
            fillerSent = true;
          }
        } else if (chunk.type === "done") {
          final = chunk.text;
        } else {
          if (cutOff.has(turnId)) return;
          this.opts.log?.warn(`promptli: voice turn error on ${call.callId}: ${chunk.message}`);
          if (!sent) call.say(SORRY, turnId);
          return;
        }
      }
      if (signal.aborted) return;
      const tail = speech.flush();
      if (!sent && final && !isNoReply(final)) {
        call.say(speakable(final), turnId);
        return;
      }
      call.text(turnId, tail, true);
      this.turnsCompleted += 1;
    } catch (e) {
      if (signal.aborted) return;
      this.opts.log?.error(`promptli: voice turn failed on ${call.callId}: ${(e as Error).message}`);
      if (!sent && !cutOff.has(turnId)) call.say(SORRY, turnId);
    }
  }

  private async postCall(call: LiveCall, info: Json): Promise<void> {
    try {
      const signal = new AbortController().signal;
      for await (const _ of this.engine.runTurn({ peer: this.peer(call), prompt: framePostCall(info, call.stopReason), kind: "post_call", signal })) {
        /* the agent acts through tools; its text is not sent anywhere */
      }
    } catch (e) {
      this.opts.log?.error(`promptli: post-call turn failed for ${call.callId}: ${(e as Error).message}`);
    }
  }
}
