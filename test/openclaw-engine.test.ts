import { describe, expect, it } from "vitest";
import { resolveAccount } from "../src/config.js";
import type { TurnChunk } from "../src/engine.js";
import { OpenClawEngine, type ChannelRuntimeLike } from "../src/openclaw-engine.js";

type RunScript = (plan: any) => Promise<void>;

function fakeRuntime(script: RunScript, allowed = true, decision?: string) {
  const seen: any = { resolveStable: [] as any[], contexts: [] as any[], routes: [] as any[] };
  const rt: ChannelRuntimeLike = {
    routing: {
      resolveAgentRoute: (p) => {
        seen.routes.push(p);
        return { agentId: "main", sessionKey: `agent:main:promptli:direct:${p.peer.id}` };
      },
    },
    commands: { shouldComputeCommandAuthorized: () => false },
    pairing: { readAllowFromStore: async () => [], upsertPairingRequest: async () => ({ code: "ABC123", created: true }) },
    inbound: {
      ingress: {
        resolveStable: async (p) => {
          seen.resolveStable.push(p);
          return { senderAccess: { allowed, ...(decision ? { decision } : {}) } };
        },
      },
      buildContext: (p) => {
        seen.contexts.push(p);
        return { ctx: true, ...p };
      },
      run: async (p: any) => {
        const input = p.adapter.ingest(p.raw);
        const plan = await p.adapter.resolveTurn(input);
        seen.plan = plan;
        await script(plan);
      },
    },
  };
  return { rt, seen };
}

async function collect(it: AsyncIterable<TurnChunk>) {
  const out: TurnChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const cfg = { channels: { promptli: { identity: "glow", dmPolicy: "open", allowFrom: ["*"] } } };
const peer = { channel: "sms" as const, contactKey: "contact:ct_1", address: "+15551230000", name: "Jane" };

describe("OpenClaw engine", () => {
  it("checks access, routes per contact, streams partials and returns the delivered text", async () => {
    const { rt, seen } = fakeRuntime(async (plan) => {
      await plan.replyOptions.onPartialReply({ delta: "Hel" });
      await plan.replyOptions.onPartialReply({ text: "Hello" }); // cumulative snapshot
      await plan.replyOptions.onToolStart({ name: "promptli_lookup_contact" });
      expect(await plan.delivery.deliver({ text: "Hello there" }, { kind: "final" })).toEqual({ visibleReplySent: true });
    });
    const engine = new OpenClawEngine({ cfg, account: resolveAccount(cfg), rt });
    const chunks = await collect(engine.runTurn({ peer, prompt: "<framed>", raw: "hi", kind: "channel", signal: new AbortController().signal }));
    expect(chunks).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "tool", name: "promptli_lookup_contact" },
      { type: "done", text: "Hello there" },
    ]);
    expect(seen.resolveStable).toHaveLength(2); // before and after the route is known
    expect(seen.resolveStable[0]).toMatchObject({ channelId: "promptli", dmPolicy: "open", allowFrom: ["*"], subject: { stableId: "+15551230000" } });
    expect(seen.routes[0]).toMatchObject({ channel: "promptli", peer: { kind: "direct", id: "contact:ct_1" } });
    const ctx = seen.contexts[0];
    expect(ctx).toMatchObject({ channel: "promptli", from: "promptli:+15551230000", reply: { to: "sms:+15551230000" }, message: { rawBody: "hi", bodyForAgent: "<framed>" } });
    expect(seen.plan.route.sessionKey).toBe("agent:main:promptli:direct:contact:ct_1");
  });

  it("NO_REPLY is not a visible reply", async () => {
    const { rt } = fakeRuntime(async (plan) => {
      expect(await plan.delivery.deliver({ text: "NO_REPLY" })).toEqual({ visibleReplySent: false });
    });
    const engine = new OpenClawEngine({ cfg, account: resolveAccount(cfg), rt });
    expect(await collect(engine.runTurn({ peer, prompt: "p", kind: "channel", signal: new AbortController().signal }))).toEqual([{ type: "done", text: "NO_REPLY" }]);
  });

  it("a stranger under pairing gets a challenge over the same medium and no agent turn", async () => {
    let ran = false;
    const { rt } = fakeRuntime(async () => void (ran = true), false, "pairing");
    const replies: string[] = [];
    const engine = new OpenClawEngine({
      cfg,
      account: resolveAccount({ channels: { promptli: { identity: "glow", dmPolicy: "pairing" } } }),
      rt,
      sendPairingReply: async (_p, t) => void replies.push(t),
      issuePairingChallenge: async (p) => p.sendPairingReply(`code for ${p.senderId}`),
    });
    const chunks = await collect(engine.runTurn({ peer, prompt: "p", kind: "channel", signal: new AbortController().signal }));
    expect(ran).toBe(false);
    expect(replies).toEqual(["code for +15551230000"]);
    expect(chunks).toEqual([{ type: "done", text: "NO_REPLY" }]);
  });

  it("voice turns skip sender checks (Promptli admitted the call) and pass the abort signal", async () => {
    const ac = new AbortController();
    const { rt, seen } = fakeRuntime(async (plan) => {
      expect(plan.replyOptions.abortSignal).toBe(ac.signal);
    });
    const engine = new OpenClawEngine({ cfg, account: resolveAccount(cfg), rt });
    await collect(engine.runTurn({ peer: { ...peer, channel: "voice" }, prompt: "p", kind: "voice", signal: ac.signal }));
    expect(seen.resolveStable).toHaveLength(0);
    expect(seen.contexts[0].channelIngress).toBe("unsupported");
  });

  it("a failed run becomes an error chunk", async () => {
    const { rt } = fakeRuntime(async () => {
      throw new Error("agent crashed");
    });
    const engine = new OpenClawEngine({ cfg, account: resolveAccount(cfg), rt });
    const chunks = await collect(engine.runTurn({ peer, prompt: "p", kind: "channel", signal: new AbortController().signal }));
    expect(chunks.at(-1)).toEqual({ type: "error", message: "agent crashed" });
  });
});
