// The seam between the Promptli gateway (transport, routing, delivery, voice) and the agent runtime.
// src/openclaw-engine.ts implements it on top of OpenClaw's channel reply pipeline; tests use a fake.

export type TurnKind = "channel" | "voice" | "post_call";

export type TurnChunk =
  | { type: "delta"; text: string } // streamed text (voice needs these to speak early)
  | { type: "tool"; name: string } // the agent started a tool (voice plays a filler)
  | { type: "done"; text: string } // final answer
  | { type: "error"; message: string };

export type Peer = {
  /** OpenClaw channel id for this conversation: "promptli" (one channel, many media). */
  channel: "email" | "sms" | "voice";
  /** Stable per-person key from Promptli (e.g. `contact:ct_…`, `email:jane@x.com`, `sms:+1555…`). */
  contactKey: string;
  /** Address on that medium: email address or E.164 number. */
  address: string;
  name?: string;
  /** Promptli thread / message id the turn is about (email reply threading). */
  replyToId?: string;
};

export type TurnRequest = {
  peer: Peer;
  prompt: string;
  /** Raw text the person wrote (for OpenClaw's RawBody / command detection); prompt is the framed version. */
  raw?: string;
  kind: TurnKind;
  signal: AbortSignal;
};

export interface TurnEngine {
  runTurn(req: TurnRequest): AsyncIterable<TurnChunk>;
}
