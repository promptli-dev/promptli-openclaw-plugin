import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTarget, promptliPlugin } from "../src/channel.js";
import { PromptliConfigSchema, resolveAccount } from "../src/config.js";

describe("channel", () => {
  it("parses targets", () => {
    expect(parseTarget("email:Jane@Example.com")).toEqual({ medium: "email", address: "jane@example.com" });
    expect(parseTarget("promptli:sms:+1 (555) 123-0000")).toEqual({ medium: "sms", address: "+15551230000" });
    expect(parseTarget("+919876543210")).toEqual({ medium: "sms", address: "+919876543210" });
    expect(parseTarget("bob@x.io")).toEqual({ medium: "email", address: "bob@x.io" });
    expect(parseTarget("5551234")).toBeNull(); // not E.164
    expect(parseTarget("email:nope")).toBeNull();
  });

  it("is a direct-chat channel with the promptli id and outbound adapter", () => {
    expect(promptliPlugin.id).toBe("promptli");
    expect(promptliPlugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(typeof promptliPlugin.outbound?.sendText).toBe("function");
    expect(typeof promptliPlugin.gateway?.startAccount).toBe("function");
    const r = promptliPlugin.outbound!.resolveTarget!({ to: "sms:+15551230000" } as never);
    expect(r).toEqual({ ok: true, to: "sms:+15551230000" });
  });

  it("resolves accounts with safe defaults and per-account overrides", () => {
    const a = resolveAccount({ channels: { promptli: { identity: "glow" } } });
    expect(a).toMatchObject({ accountId: "default", identity: "glow", dmPolicy: "open", allowFrom: ["*"], autoReply: true, voice: true });
    const b = resolveAccount({ channels: { promptli: { dmPolicy: "allowlist", allowFrom: ["Jane@X.com", "+1 555 123 0000"], accounts: { work: { identity: "acme", voice: false } } } } }, "work");
    expect(b).toMatchObject({ identity: "acme", voice: false, dmPolicy: "allowlist", allowFrom: ["jane@x.com", "+15551230000"] });
  });

  it("config schema: open needs allowFrom *", () => {
    expect(PromptliConfigSchema.safeParse({ identity: "glow", dmPolicy: "open", allowFrom: ["*"] }).success).toBe(true);
    expect(PromptliConfigSchema.safeParse({ identity: "glow", dmPolicy: "open", allowFrom: ["a@b.com"] }).success).toBe(false);
    expect(PromptliConfigSchema.safeParse({ identity: "glow", bogus: 1 }).success).toBe(false);
  });

  it("does not start without setup", async () => {
    process.env.PROMPTLI_HOME = mkdtempSync(join(tmpdir(), "promptli-home-"));
    const warnings: string[] = [];
    await promptliPlugin.gateway!.startAccount!({
      cfg: {},
      account: resolveAccount({}),
      abortSignal: new AbortController().signal,
      log: { warn: (m: string) => warnings.push(m), info: () => undefined, error: () => undefined },
    } as never);
    expect(warnings[0]).toContain("openclaw promptli setup");
  });
});
