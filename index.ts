// Promptli Comms for OpenClaw: email, SMS and phone calls as an OpenClaw channel, plus promptli_* agent tools
// and the `openclaw promptli` CLI. See README.md.

import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { promptliPlugin } from "./src/channel.js";
import { registerPromptliCli, type CliHost } from "./src/cli.js";
import { makeClient } from "./src/client.js";
import { resolveAccount } from "./src/config.js";
import { getRunningAccount, resolveAuth, resolveIdentity } from "./src/runtime.js";
import { errorResult, promptliTools, type ToolDeps, type ToolSpec } from "./src/tools.js";

export const PLUGIN_ID = "promptli-comms";

/** Deps for tools: the live channel account if running, else a client from the saved login. */
export function toolDeps(cfg: unknown): ToolDeps | null {
  const live = getRunningAccount();
  if (live) return { client: live.client, identity: live.identity, onSend: live.gateway.markSent, calls: live.calls };
  const account = resolveAccount(cfg);
  const identity = resolveIdentity(account);
  const auth = resolveAuth(account);
  if (!identity || !auth) return null;
  return { client: makeClient(auth, { baseUrl: account.baseUrl }), identity, onSend: () => undefined };
}

/** Every tool name, for the manifest's contracts.tools (checked by a test). */
export const TOOL_NAMES = promptliTools({ client: null as never, identity: "", onSend: () => undefined }).map((t) => t.name);

export function registerTools(api: Pick<OpenClawPluginApi, "registerTool" | "config">): void {
  const specs: ToolSpec[] = promptliTools({ client: null as never, identity: "", onSend: () => undefined });
  for (const spec of specs) {
    api.registerTool(
      {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters as never,
        async execute(_toolCallId: string, params: unknown) {
          const deps = toolDeps(api.config);
          if (!deps) return jsonResult({ ok: false, error: "not_configured", message: "Promptli is not set up. Ask the owner to run `openclaw promptli setup`." });
          const tool = promptliTools(deps).find((t) => t.name === spec.name)!;
          try {
            return jsonResult(await tool.handler((params ?? {}) as Record<string, unknown>));
          } catch (e) {
            return jsonResult(errorResult(e));
          }
        },
      } as never,
      spec.optional ? { optional: true } : undefined,
    );
  }
}

export function cliHost(api: OpenClawPluginApi): CliHost {
  return {
    currentConfig: () => api.runtime?.config?.current?.() ?? api.config,
    mutateConfig: async (mutate) => {
      await api.runtime.config.mutateConfigFile({ afterWrite: { mode: "auto" }, mutate: (draft) => mutate(draft as never) });
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

export default defineChannelPluginEntry({
  id: PLUGIN_ID,
  name: "Promptli Comms",
  description: "Email, SMS and phone calls for your OpenClaw agent over Promptli Agent Link (no webhooks or tunnels).",
  plugin: promptliPlugin,
  registerCliMetadata(api) {
    api.registerCli(({ program }) => registerPromptliCli(program as never, cliHost(api)), {
      descriptors: [{ name: "promptli", description: "Promptli Comms: set up, status, doctor, logout", hasSubcommands: true }],
    });
  },
  registerFull(api) {
    registerTools(api);
  },
});
