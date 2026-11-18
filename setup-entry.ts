// Light entry OpenClaw loads while the channel is unconfigured or disabled (onboarding, `openclaw channels`).
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { promptliPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(promptliPlugin);
