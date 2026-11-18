import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { OAuthToken, StaticToken } from "../src/auth.js";
import { AgentLink, linkUrl, type WsLike } from "../src/link.js";
import { tick } from "./helpers.js";

class FakeWs extends EventEmitter implements WsLike {
  readyState = 1;
  sent: any[] = [];
  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {
    super();
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }
  server(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function setup(auth = new StaticToken("psk_test_x") as any, opts: Partial<ConstructorParameters<typeof AgentLink>[0]> = {}) {
  const sockets: FakeWs[] = [];
  const events: any[] = [];
  const frames: any[] = [];
  const states: string[] = [];
  const link = new AgentLink({
    url: "wss://link.test/v1/connect",
    auth,
    instance: "inst-1",
    identity: "glow",
    capabilities: ["channel_turns", "voice"],
    onEvent: (e) => void events.push(e),
    onFrame: (f) => void frames.push(f),
    onState: (s) => void states.push(s),
    wsFactory: (url, headers) => {
      const ws = new FakeWs(url, headers);
      sockets.push(ws);
      return ws;
    },
    backoff: () => 1,
    ...opts,
  });
  return { link, sockets, events, frames, states };
}

describe("agent link", () => {
  it("derives the link URL from the API base", () => {
    expect(linkUrl("https://api.comms.promptli.com")).toBe("wss://link.comms.promptli.com/v1/connect");
    expect(linkUrl("http://localhost:8000")).toBe("ws://localhost:8100/v1/connect");
  });

  it("connects with headers, answers pings, routes events and call frames, acks", async () => {
    const { link, sockets, events, frames } = setup();
    const started = link.start();
    await tick();
    const ws = sockets[0]!;
    expect(ws.url).toBe("wss://link.test/v1/connect?identity=glow&capabilities=channel_turns,voice");
    expect(ws.headers.Authorization).toBe("Bearer psk_test_x");
    expect(ws.headers["X-Link-Instance"]).toBe("inst-1");
    ws.server({ type: "hello", session_id: "s1", protocol: 1, cursor: 4 });
    await started;
    expect(link.connected).toBe(true);
    ws.server({ type: "ping" });
    ws.server({ type: "event", event: { id: "evt_5", seq: 5, type: "text.received" } });
    ws.server({ type: "call.incoming", call_id: "c1" });
    ws.server({ type: "some.future.frame" });
    await tick();
    expect(ws.sent).toContainEqual({ type: "pong" });
    expect(events.map((e) => e.id)).toEqual(["evt_5"]);
    expect(frames.map((f) => f.type)).toEqual(["call.incoming", "some.future.frame"]);
    link.ack(5);
    expect(ws.sent).toContainEqual({ type: "ack", seq: 5 });
    await link.close();
  });

  it("reconnects after a drop and after being replaced", async () => {
    const { link, sockets, states } = setup();
    const started = link.start();
    await tick();
    sockets[0]!.server({ type: "hello", session_id: "s1" });
    await started;
    sockets[0]!.close(1006);
    await tick(10);
    expect(sockets).toHaveLength(2);
    sockets[1]!.server({ type: "hello", session_id: "s2" });
    sockets[1]!.close(4002);
    await tick(10);
    expect(sockets).toHaveLength(3);
    expect(states).toEqual(["connected", "disconnected", "connected", "disconnected"]);
    await link.close();
  });

  it("an auth error is fatal for a key", async () => {
    const { link, sockets, states } = setup();
    const started = link.start();
    await tick();
    sockets[0]!.server({ type: "error", code: "invalid_api_key", message: "bad key" });
    sockets[0]!.close(4001);
    await expect(started).rejects.toThrow("bad key");
    await tick(10);
    expect(sockets).toHaveLength(1);
    expect(states).toEqual(["fatal"]);
  });

  it("a browser login refreshes once on an auth error, then connects", async () => {
    let refreshes = 0;
    const auth = new OAuthToken(
      { client_id: "c", refresh_token: "r0", base_url: "http://api.test", access_token: "old", expires_at: Date.now() / 1000 + 3600 },
      {
        fetch: (async () => {
          refreshes++;
          return new Response(JSON.stringify({ access_token: "new", refresh_token: "r1", expires_in: 3600 }));
        }) as any,
      },
    );
    const { link, sockets } = setup(auth);
    const started = link.start();
    await tick();
    expect(sockets[0]!.headers.Authorization).toBe("Bearer old");
    sockets[0]!.close(4001);
    await tick(10);
    expect(refreshes).toBe(1);
    expect(sockets[1]!.headers.Authorization).toBe("Bearer new");
    sockets[1]!.server({ type: "hello", session_id: "s" });
    await started;
    await link.close();
  });
});
