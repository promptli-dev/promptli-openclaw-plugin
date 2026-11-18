import { describe, expect, it } from "vitest";
import type { TurnChunk, TurnRequest } from "../src/engine.js";
import { CallDriver, SORRY } from "../src/voice.js";
import { FakeEngine, tick } from "./helpers.js";

function driver(script: (req: TurnRequest) => AsyncIterable<TurnChunk> | TurnChunk[], enabled = true) {
  const sent: any[] = [];
  const engine = new FakeEngine(script);
  const d = new CallDriver(engine, { send: (f) => void sent.push(f), identityName: () => "Glow", enabled: () => enabled });
  return { d, sent, engine };
}

const incoming = { type: "call.incoming", call_id: "call_1", direction: "inbound", from: "+15551230000", to: "+15550001111", contact_key: "contact:ct_1", contact: { name: "Jane" } };

describe("live calls", () => {
  it("accepts, greets with streamed speech-filtered text, answers turns, then runs a post-call turn", async () => {
    const { d, sent, engine } = driver((req) =>
      req.kind === "post_call" ? [{ type: "done", text: "NO_REPLY" }] : [{ type: "delta", text: "Hi **Jane**, " }, { type: "delta", text: "how can I help?" }, { type: "done", text: "Hi Jane, how can I help?" }],
    );
    expect(d.handle(incoming)).toBe(true);
    d.handle({ type: "call.start", call_id: "call_1", turn_id: "t0", greet: true });
    await tick(5);
    expect(sent[0]).toEqual({ type: "call.accept", call_id: "call_1" });
    const t0 = sent.filter((f) => f.turn_id === "t0");
    expect(t0.map((f) => f.delta).join("")).toBe("Hi Jane, how can I help?");
    expect(t0.at(-1).done).toBe(true);
    expect(engine.requests[0]!.prompt).toContain("Never claim to be human");
    expect(engine.requests[0]!.peer).toMatchObject({ channel: "voice", contactKey: "contact:ct_1", address: "+15551230000" });

    d.handle({ type: "call.transcript", call_id: "call_1", party: "caller", turn_id: "t1", text: "what time is it", is_final: true });
    await tick(5);
    expect(engine.requests[1]!.prompt).toContain('<external_content channel="call">');
    d.handle({ type: "call.stop", call_id: "call_1", reason: "hangup" });
    await tick(5);
    expect(engine.requests.at(-1)!.kind).toBe("post_call");
    expect(d.active).toBe(0);
  });

  it("plays a filler when a tool starts before any words", async () => {
    const { d, sent } = driver(() => [{ type: "tool", name: "promptli_lookup_contact" }, { type: "done", text: "Found it." }]);
    d.handle(incoming);
    d.handle({ type: "call.start", call_id: "call_1", turn_id: "t0", greet: true });
    await tick(5);
    expect(sent.some((f) => f.type === "call.filler")).toBe(true);
    expect(sent.find((f) => f.turn_id === "t0" && f.done)?.delta).toBe("Found it.");
  });

  it("barge-in aborts the running turn and tells the next turn what was heard", async () => {
    let aborted = false;
    const { d, engine } = driver(async function* (req) {
      if (req.prompt.includes("first")) {
        yield { type: "delta", text: "Let me tell you a long story" };
        await new Promise<void>((r) => req.signal.addEventListener("abort", () => r()));
        aborted = true;
        return;
      }
      yield { type: "done", text: "Okay." };
    });
    d.handle(incoming);
    d.handle({ type: "call.start", call_id: "call_1", greet: false });
    d.handle({ type: "call.transcript", call_id: "call_1", turn_id: "t1", text: "first", is_final: true });
    await tick(5);
    d.handle({ type: "call.barge_in", call_id: "call_1", turn_id: "t1", spoken_so_far: "Let me tell" });
    d.handle({ type: "call.transcript", call_id: "call_1", turn_id: "t2", text: "stop", is_final: true });
    await tick(5);
    expect(aborted).toBe(true);
    expect(engine.requests[1]!.prompt).toContain('They only heard: "Let me tell"');
    expect(engine.requests[0]!.prompt).toContain("Incoming call from Jane"); // call header rides on the first turn
  });

  it("says sorry when the agent fails before speaking", async () => {
    const { d, sent } = driver(() => [{ type: "error", message: "boom" }]);
    d.handle(incoming);
    d.handle({ type: "call.start", call_id: "call_1", turn_id: "t0", greet: true });
    await tick(5);
    expect(sent.find((f) => f.turn_id === "t0")).toMatchObject({ delta: SORRY, done: true });
  });

  it("declines calls when voice is off, and hosted supervisor seats", () => {
    const { d, sent } = driver(() => [], false);
    d.handle(incoming);
    d.handle({ type: "call.supervise", call_id: "call_2" });
    expect(sent).toEqual([{ type: "call.decline", call_id: "call_1" }, { type: "call.decline", call_id: "call_2" }]);
    expect(d.handle({ type: "call.ended", seq: 3 })).toBe(false); // persisted events are not live frames
  });

  it("end_call / transfer / dtmf tools reach the live call", async () => {
    const { d, sent } = driver(() => [{ type: "done", text: "NO_REPLY" }]);
    d.handle(incoming);
    const call = d.get("call_1")!;
    call.hangup("Bye!");
    call.transfer("+15559990000");
    call.dtmf("1#");
    expect(sent.slice(1)).toEqual([
      { type: "call.hangup", say: "Bye!", call_id: "call_1" },
      { type: "call.transfer", to: "+15559990000", call_id: "call_1" },
      { type: "call.dtmf", digits: "1#", call_id: "call_1" },
    ]);
    d.endAll("test");
    await tick(5);
  });
});
