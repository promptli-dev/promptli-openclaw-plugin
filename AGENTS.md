# AGENTS.md: promptli-openclaw-plugin

OpenClaw channel plugin for Promptli Comms (TypeScript, ESM, Node 24.16+/26.1+). Plugin id `promptli-comms`,
channel id `promptli`, npm `@promptli-npm/openclaw-plugin`.

- `index.ts`: `defineChannelPluginEntry` (channel + `promptli_*` tools + `openclaw promptli` CLI).
- `src/channel.ts`: ChannelPlugin via `createChatChannelPlugin` (config, dm security, pairing, outbound, gateway.startAccount).
- `src/openclaw-engine.ts`: inbound turns through `PluginRuntime["channel"]` (ingress.resolveStable → routing.resolveAgentRoute
  → inbound.run with replyOptions.onPartialReply / onToolStart / abortSignal). Same path as the bundled `extensions/sms`.
- `src/gateway.ts`, `src/voice.ts`, `src/framing.ts`, `src/speech.ts`: TypeScript port of `promptli-gateway` (promptli-comms repo).
  Keep behaviour in sync with it (framing text, NO_REPLY, ack watermark, tool-delivery marks, barge-in).
- `src/link.ts`: Agent Link client (`spec/agent-link.md`). `src/auth.ts`: browser login + refresh, same credential file format as the Python SDK.

Rules:
- Never print, log or commit API keys or tokens. Keys come from the browser login, `PROMPTLI_API_KEY`, stdin or a SecretRef; never argv.
- Calls: the agent must say it is an AI; `promptli_place_call` / `promptli_schedule_call` stay `optional` tools and keep the
  TRAI (+91, 9 AM–9 PM IST) guard. Tests use fakes only: never call, text or email real people.
- Every tool name must be in `openclaw.plugin.json#contracts.tools` and `toolMetadata` (`scripts/check-package.mjs` enforces it).
- `channelConfigs` in the manifest is generated: `npm run build && node scripts/sync-manifest.mjs`.
- Bump `version` in `package.json` and `openclaw.plugin.json` together; keep `openclaw.compat.pluginApi` / `build.openclawVersion`
  at the host version tested in CI.
- Checks: `npm run check && node scripts/sync-manifest.mjs --check && sh scripts/host-smoke.sh`.
