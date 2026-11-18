import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway.js";
import { LinkState } from "../src/state.js";
import { promptliTools } from "../src/tools.js";
import { emailEvent, FakeEngine, fakeApi, textEvent } from "./helpers.js";

function make(script: ConstructorParameters<typeof FakeEngine>[0], extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) {
  const api = fakeApi();
  const engine = new FakeEngine(script);
  const acks: number[] = [];
  const state = new LinkState(null);
  const gw = new Gateway({ client: api.client, identity: "glow", engine, state, ack: (s) => void acks.push(s), batchWindowMs: 5, ...extra });
  gw.identityAddress = "glow@agents.promptli.com";
  gw.identityNumber = "+15550001111";
  return { gw, api, engine, acks, state };
}

describe("gateway", () => {
  it("answers an email with a threaded reply and acks", async () => {
    const { gw, api, engine, acks } = make(() => [{ type: "delta", text: "Hello " }, { type: "done", text: "Hello Jane" }]);
    await gw.handleEvent(emailEvent(1));
    await gw.drain();
    expect(engine.requests[0]!.peer).toMatchObject({ channel: "email", contactKey: "email:jane@example.com", address: "jane@example.com", name: "Jane", replyToId: "msg_1" });
    expect(engine.requests[0]!.prompt).toContain('<external_content channel="email">');
    const reply = api.calls.find((c) => c.path.endsWith("/reply"))!;
    expect(reply.path).toBe("/v1/identities/glow/mail/messages/msg_1/reply");
    expect(reply.body).toEqual({ text: "Hello Jane" });
    expect(reply.auth).toBe("Bearer psk_test_fake");
    expect(acks).toEqual([1]);
  });

  it("batches a burst of texts into one turn and replies as plain SMS", async () => {
    const { gw, api, engine } = make(() => [{ type: "done", text: "**Sure**, see you at 4" }]);
    await gw.handleEvent(textEvent(1, "+15551230000", "are you"));
    await gw.handleEvent(textEvent(2, "+15551230000", "free friday?"));
    await gw.drain();
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]!.raw).toBe("are you\nfree friday?");
    const sms = api.calls.filter((c) => c.path === "/v1/identities/glow/texts");
    expect(sms.map((c) => c.body)).toEqual([{ to: "+15551230000", body: "Sure, see you at 4" }]);
  });

  it("sends nothing for NO_REPLY", async () => {
    const { gw, api } = make(() => [{ type: "done", text: "NO_REPLY" }]);
    await gw.handleEvent(textEvent(1));
    await gw.drain();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("skips the auto-reply when the agent already replied with a tool", async () => {
    let gw!: Gateway;
    const ctx = make(async function* () {
      const tools = promptliTools({ client: ctx.api.client, identity: "glow", onSend: gw.markSent });
      await tools.find((t) => t.name === "promptli_send_text")!.handler({ to: ["+15551230000"], text: "On it" });
      yield { type: "done" as const, text: "Done" };
    });
    gw = ctx.gw;
    await gw.handleEvent(textEvent(1));
    await gw.drain();
    const sms = ctx.api.calls.filter((c) => c.path === "/v1/identities/glow/texts");
    expect(sms.map((c) => c.body.body)).toEqual(["On it"]);
  });

  it("dedupes replayed events and ignores loopback, keywords and live-call endings", async () => {
    const { gw, engine, acks } = make(() => [{ type: "done", text: "NO_REPLY" }]);
    await gw.handleEvent(textEvent(1));
    await gw.drain();
    await gw.handleEvent(textEvent(1)); // replay after reconnect
    await gw.handleEvent(emailEvent(2, "glow@agents.promptli.com")); // our own copy
    await gw.handleEvent({ id: "evt_3", seq: 3, type: "text.received", data: { keyword: "STOP", text: { from: "+1", body: "STOP" } } });
    await gw.handleEvent({ id: "evt_4", seq: 4, type: "call.ended", data: { call: { outcome: "completed" } } });
    await gw.drain();
    expect(engine.requests).toHaveLength(1);
    expect(acks.at(-1)).toBe(4);
  });

  it("acks only a low watermark while an earlier turn is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { gw, acks } = make(async function* (req) {
      if (req.peer.address === "slow@example.com") await gate;
      yield { type: "done" as const, text: "NO_REPLY" };
    });
    await gw.handleEvent(emailEvent(1, "slow@example.com"));
    await gw.handleEvent(emailEvent(2, "fast@example.com"));
    await new Promise((r) => setTimeout(r, 20));
    expect(acks).toEqual([]); // seq 1 still pending: never ack 2 past it
    release();
    await gw.drain();
    expect(acks.at(-1)).toBe(2);
  });

  it("routes a voicemail to a turn without an auto-reply", async () => {
    const { gw, api, engine } = make(() => [{ type: "done", text: "I'll call back" }]);
    await gw.handleEvent({ id: "evt_1", seq: 1, type: "call.ended", data: { contact_key: "phone:+1555", call: { id: "call_1", outcome: "voicemail", from: "+1555" }, transcript: [{ party: "caller", text: "call me" }] } });
    await gw.drain();
    expect(engine.requests[0]!.prompt).toContain("New voicemail");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a turn error sends nothing and is recorded", async () => {
    const { gw, api } = make(() => [{ type: "error", message: "model down" }]);
    await gw.handleEvent(textEvent(1));
    await gw.drain();
    expect(gw.lastError).toBe("model down");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("gateway: one person on several media", () => {
  it("an email then a text from the same contact keep their own medium (promptli-gateway 0.2.1 bug)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { gw, api, engine } = make(async function* (req) {
      if (req.peer.channel === "email") await gate; // the worker is busy with the email when the text lands
      yield { type: "done" as const, text: `re ${req.peer.channel}` };
    });
    const email = emailEvent(1, "jane@example.com");
    email.data.contact_key = "contact:ct_jane";
    const text = textEvent(2, "+15551230000", "also texting");
    (text.data as any).contact_key = "contact:ct_jane";
    await gw.handleEvent(email);
    await gw.handleEvent(text);
    release();
    await gw.drain();
    expect(engine.requests.map((r) => [r.peer.channel, r.peer.contactKey])).toEqual([
      ["email", "contact:ct_jane"],
      ["sms", "contact:ct_jane"],
    ]);
    expect(engine.requests[1]!.prompt).toContain('<external_content channel="sms">');
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/v1/identities/glow/mail/messages/msg_1/reply",
      "/v1/identities/glow/texts",
    ]);
  });
});
