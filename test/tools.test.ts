import { describe, expect, it } from "vitest";
import { callingHoursBlock, promptliTools } from "../src/tools.js";
import { fakeApi } from "./helpers.js";

function tools(now = new Date("2026-11-18T06:00:00Z")) {
  const api = fakeApi({
    "POST /v1/identities/glow/calls": () => ({ id: "call_9", status: "queued" }),
    "GET /v1/identities/glow/mail/search": () => ({ data: [{ id: "msg_1", subject: "Hi", text: "body", html: "<p>" }] }),
    "POST /v1/identities/glow/mail/messages/msg_1/reply-all": () => ({ id: "msg_2", status: "queued", to: ["A@x.com", "b@x.com"] }),
  });
  const marks: string[] = [];
  const list = promptliTools({ client: api.client, identity: "glow", onSend: (c, r) => void marks.push(`${c}:${r}`), now: () => now });
  const run = (name: string, args: Record<string, unknown>) => list.find((t) => t.name === name)!.handler(args);
  return { api, marks, run, list };
}

describe("tools", () => {
  it("every tool has a JSON schema and a promptli_ name", () => {
    for (const t of tools().list) {
      expect(t.name).toMatch(/^promptli_[a-z_]+$/);
      expect(t.parameters.type).toBe("object");
    }
  });

  it("send_email and send_text call the API and mark delivery", async () => {
    const { api, marks, run } = tools();
    expect(await run("promptli_send_email", { to: ["Jane@Example.com"], subject: "Hi", text: "Hello" })).toMatchObject({ ok: true });
    expect(await run("promptli_send_text", { to: ["+15551230000"], text: "yo" })).toMatchObject({ ok: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/identities/glow/mail/messages", "POST /v1/identities/glow/texts"]);
    expect(api.calls[1]!.body).toEqual({ to: "+15551230000", body: "yo" });
    expect(marks).toEqual(["email:jane@example.com", "sms:+15551230000"]);
  });

  it("reply_all marks every recipient; search strips bodies", async () => {
    const { marks, run } = tools();
    await run("promptli_reply_email", { message_id: "msg_1", text: "Thanks", reply_all: true });
    expect(marks).toEqual(["email:a@x.com", "email:b@x.com"]);
    const res = await run("promptli_search_email", { query: "invoice" });
    expect(res.messages).toEqual([{ id: "msg_1", subject: "Hi" }]);
  });

  it("place_call works inside calling hours", async () => {
    const { api, run } = tools(new Date("2026-11-18T06:00:00Z")); // 11:30 IST
    expect(await run("promptli_place_call", { to: "+919876543210", reason: "confirm", hosted: true })).toEqual({ ok: true, call_id: "call_9", status: "queued" });
    expect(api.calls[0]!.body).toMatchObject({ to: "+919876543210", reason: "confirm", mode: "hosted" });
  });

  it("refuses +91 calls outside 9 AM-9 PM IST (TRAI) without calling the API", async () => {
    const { api, run } = tools(new Date("2026-11-18T17:00:00Z")); // 22:30 IST
    expect(await run("promptli_place_call", { to: "+91 98765 43210", reason: "x" })).toMatchObject({ ok: false, error: "outside_calling_hours" });
    expect(api.calls).toHaveLength(0);
    expect(callingHoursBlock("+15551230000", new Date("2026-11-18T17:00:00Z"))).toBeNull();
    expect(callingHoursBlock("+919876543210", new Date("2026-11-18T03:29:00Z"))).not.toBeNull(); // 08:59 IST
    expect(callingHoursBlock("+919876543210", new Date("2026-11-18T03:30:00Z"))).toBeNull(); // 09:00 IST
  });

  it("live-call tools fail cleanly with no active call; API errors become results", async () => {
    const { run } = tools();
    expect(await run("promptli_end_call", { call_id: "nope" })).toEqual({ ok: false, error: "call_not_active" });
    const failing = promptliTools({
      client: { identity: () => ({ channelStatus: async () => Promise.reject(Object.assign(new Error("Opted out"), { code: "recipient_opted_out" })) }) } as any,
      identity: "glow",
      onSend: () => undefined,
    });
    expect(await failing.find((t) => t.name === "promptli_channel_status")!.handler({})).toMatchObject({ ok: false, error: "recipient_opted_out" });
  });
});
