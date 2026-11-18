# Promptli Comms for OpenClaw

Give your OpenClaw agent its own email address and phone number. People email, text or call your agent,
and OpenClaw answers with your agent's tools and memory. It can also send email and texts, and place
calls, itself.

```
person ──email/SMS/call──▶ Promptli Comms ──Agent Link (WebSocket)──▶ OpenClaw gateway ──▶ agent session
                                                                    channel "promptli"   (one per person)
```

- **A real OpenClaw channel.** `promptli` sits next to Telegram, WhatsApp and SMS. It follows OpenClaw's
  routing, sessions, `dmPolicy` / `allowFrom` and pairing. The core `message` tool, cron and
  `openclaw message send` can reach people at `email:<address>` or `sms:<+E.164>`.
- **No tunnels or webhooks.** The gateway keeps an outbound WebSocket to Promptli and picks up where it
  left off, so nothing is lost while your machine sleeps.
- **One conversation per person.** The same person by email, then by text, then on the phone lands in the
  same OpenClaw session. It's keyed by Promptli's contact.
- **Live phone calls.** Promptli handles telephony, speech-to-text, text-to-speech, turn-taking, fillers and
  barge-in. Your agent writes every word. Replies stream into the call as they're generated, and a
  barge-in stops the agent's run.
- **Tools.** 19 `promptli_*` agent tools cover email, SMS, calls, contacts and conversation history, plus a
  `promptli-comms` skill. `promptli_place_call` and `promptli_schedule_call` are *optional* tools: the agent
  can't use them until you allow them.

> **Security:** anyone who learns the agent's address or number can message it. By default
> (`dmPolicy: "open"`) everyone gets their own isolated conversation, and inbound content is marked as
> untrusted, but the agent can still be talked into using any tool it has. Keep the agent's tool policy
> tight, or set `channels.promptli.dmPolicy` to `"allowlist"` (only `allowFrom`) or `"pairing"`. With
> pairing, a stranger first gets a code, and you approve it with `openclaw pairing approve promptli <code>`.

## Install

Requires OpenClaw 2026.11.5 or newer and Node 24.16+ / 26.1+.

```bash
curl -fsSL https://comms.promptli.com/install/openclaw.sh | sh
openclaw promptli setup
openclaw gateway restart
```

Or by hand:

```bash
openclaw plugins install @promptli-npm/openclaw-plugin    # from npm
openclaw promptli setup
openclaw gateway restart
```

`setup` shows the security warning, then **logs you in with your browser**. There you pick an existing
agent or create one (add `--number` to get it a phone number). Nothing is copied or pasted.
- Over SSH, use `--no-browser`: open the link on any device and paste the code it shows.
- `--test` uses test mode: no real email, SMS or calls.
- `--api-key-stdin` reads an identity-scoped key from stdin instead of a login. It never goes on the
  command line.

The login refreshes itself and shows up under **API keys → Connected apps** in the Promptli console,
where you can revoke it. `openclaw promptli logout` revokes it from this machine. Credentials live in
`~/.promptli/openclaw/credentials` (mode 600), never in `openclaw.json`.

To allow phone calls placed by the agent, add the tools to your tool policy:

```json5
{ tools: { allow: ["promptli_place_call", "promptli_schedule_call"] } }
```

## Commands

| Command | What it does |
| --- | --- |
| `openclaw promptli setup` | Browser login, pick or create the agent, enable the channel (`--number`, `--test`, `--no-browser`, `--api-key-stdin`, `--dm-policy`) |
| `openclaw promptli status [--json]` | Agent, address, number, access policy |
| `openclaw promptli doctor` | Credentials, API, clock, email/SMS/voice readiness, Agent Link |
| `openclaw promptli logout` | Revoke this machine's login and delete local credentials (the agent is kept) |
| `openclaw message send --channel promptli --to sms:+15551234567 --message "…"` | Send from the agent (also `email:jane@example.com`) |
| `openclaw pairing approve promptli <code>` | Let a sender in when `dmPolicy` is `pairing` |

How replies work:
- The agent's final answer goes back on the medium the person used: a threaded email reply, or SMS
  without markdown (split at 1,500 characters).
- If the agent already replied with a tool, or answers `NO_REPLY`, nothing extra is sent.
- Texts from one person that arrive within `batchWindowMs` become one turn.
- Voicemails become a turn, so the agent can follow up. After every live call, a post-call turn lets it
  do what it promised.

## Configuration

`channels.promptli` in `openclaw.json` (written by `setup`; `accounts.<id>` overrides for several agents):

| Key | Default | Meaning |
| --- | --- | --- |
| `identity` | from the login | Promptli agent handle |
| `dmPolicy` | `"open"` | `open` (needs `allowFrom: ["*"]`), `allowlist`, `pairing`, `disabled` |
| `allowFrom` | `["*"]` | Email addresses and E.164 numbers |
| `autoReply` | `true` | Send the final answer back automatically |
| `batchWindowMs` | `1500` | Coalesce bursts of texts |
| `voice` | `true` | Answer live phone calls |
| `apiKey` | unset | Optional key or SecretRef (overrides the login; so does `PROMPTLI_API_KEY`) |
| `baseUrl` | `https://api.comms.promptli.com` | API base (Agent Link host is derived) |

## Phone calls and the rules we follow

- **The agent says it's an AI.** The call rules tell it to say so when asked, and to open calls it
  places as an AI assistant. It must never claim to be human.
- **TRAI calling hours.** `promptli_place_call` refuses to call Indian (+91) numbers outside 9 AM–9 PM IST.
  `promptli_schedule_call` refuses run times outside that window.
- **Call only people the owner asked you to call.** Call tools are optional and must be allowed explicitly.
- **Opt-outs.** STOP/START/HELP texts are handled by Promptli and never reach the agent. Sends to someone who
  opted out fail with `recipient_opted_out`.
- **Hosted calls.** On calls where the Promptli voice assistant talks, OpenClaw steers with
  `promptli_call_add_fact` and `promptli_call_guidance`. It does not take the live supervisor seat (see
  Limitations).

## Limitations

- **Streaming depends on the model provider.** Voice replies stream through OpenClaw's
  `onPartialReply`. With a provider or config that doesn't stream, each reply is spoken once it's
  finished, and Promptli's fillers cover the gap.
- **No live supervision of hosted calls.** The plugin declines Promptli's `call.supervise` seat. Steering
  works through the REST tools above.
- **Text only.** Inbound attachments and MMS are listed in the prompt but not downloaded, and outbound
  media isn't sent yet.
- **Voice needs a running gateway.** Calls ring through only while `openclaw gateway` is up and connected.
  Otherwise Promptli sends them to voicemail, which the agent handles when it reconnects.

## Development

```bash
npm ci
npm run check            # typecheck, unit tests (fake API, link and OpenClaw runtime), build, package checks
node scripts/sync-manifest.mjs --check
sh scripts/host-smoke.sh # installs the packed plugin into a throwaway OpenClaw home and inspects it
```

Install from a local checkout:

```bash
npm run build && npm pack && openclaw plugins install npm-pack:./promptli-npm-openclaw-plugin-0.1.0.tgz
```

Or run `PROMPTLI_OPENCLAW_SOURCE=$PWD sh install.sh`.

Layout:

| Path | What it is |
| --- | --- |
| `index.ts` | Plugin entry: `defineChannelPluginEntry`, tools, CLI |
| `setup-entry.ts` | Light entry used before the channel is configured |
| `secret-contract-api.ts` | SecretRef contract for `apiKey` |
| `src/channel.ts` | The `promptli` ChannelPlugin: config, security, pairing, outbound, gateway |
| `src/openclaw-engine.ts` | Inbound turns through OpenClaw's channel pipeline: access, route, `inbound.run`, streaming |
| `src/gateway.ts` | Event routing, per-person queues, dedupe and ack watermark, auto-reply |
| `src/voice.ts` | Live calls: streamed `call.text`, barge-in, fillers, post-call turn |
| `src/link.ts` | Agent Link WebSocket client (spec: `spec/agent-link.md` in [promptli-comms](https://github.com/promptli-dev/promptli-comms)) |
| `src/auth.ts` | Browser login (OAuth 2.1 + PKCE loopback) and self-refreshing credentials |
| `src/tools.ts` | `promptli_*` agent tools, on [`@promptli-npm/sdk`](https://www.npmjs.com/package/@promptli-npm/sdk) |
| `src/cli.ts` | `openclaw promptli …` |
| `skills/promptli-comms/` | Skill loaded while the plugin is enabled |

The gateway logic is a TypeScript port of `promptli-gateway` (Python) from the
[promptli-comms](https://github.com/promptli-dev/promptli-comms) repo, so the behaviour matches the
[Claude Code plugin](https://github.com/promptli-dev/claude-code-plugin).

## License

MIT
