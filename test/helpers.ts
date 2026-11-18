// Shared fakes: a recording fetch for the Promptli API, and a scripted TurnEngine. No network.
import { StaticToken } from "../src/auth.js";
import { makeClient } from "../src/client.js";
import type { TurnChunk, TurnEngine, TurnRequest } from "../src/engine.js";

export type Call = { method: string; path: string; query: Record<string, string>; body: any; auth: string | null };

export function fakeApi(routes: Record<string, (c: Call) => unknown> = {}) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const c: Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization"),
    };
    calls.push(c);
    const handler = routes[`${c.method} ${c.path}`];
    const body = handler ? handler(c) : { id: "obj_1", status: "queued" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = makeClient(new StaticToken("psk_test_fake"), { baseUrl: "http://api.test", fetch: f });
  return { client, calls, fetch: f };
}

export class FakeEngine implements TurnEngine {
  requests: TurnRequest[] = [];
  constructor(public script: (req: TurnRequest) => TurnChunk[] | AsyncIterable<TurnChunk>) {}
  async *runTurn(req: TurnRequest): AsyncIterable<TurnChunk> {
    this.requests.push(req);
    yield* this.script(req) as any;
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export function emailEvent(seq: number, from = "jane@example.com", text = "Hi there") {
  return {
    id: `evt_${seq}`,
    seq,
    type: "message.received",
    data: {
      contact_key: `email:${from}`,
      contacts: [{ name: "Jane" }],
      message: { id: `msg_${seq}`, thread_id: "th_1", from, subject: "Hello", text, folder: "inbox", to: ["agent@agents.promptli.com"] },
    },
  };
}

export function textEvent(seq: number, from = "+15551230000", body = "hey") {
  return { id: `evt_${seq}`, seq, type: "text.received", data: { contact_key: `sms:${from}`, text: { from, body } } };
}
