// Regenerate openclaw.plugin.json#channelConfigs.promptli from the channel's zod schema (run after build).
// `node scripts/sync-manifest.mjs --check` fails when the manifest is out of date (CI).
import { readFileSync, writeFileSync } from "node:fs";

const { PromptliChannelConfigSchema } = await import(new URL("../dist/src/config.js", import.meta.url));
const path = new URL("../openclaw.plugin.json", import.meta.url);
const man = JSON.parse(readFileSync(path, "utf8"));
const { $schema: _drop, ...schema } = PromptliChannelConfigSchema.schema;
const next = {
  ...man,
  channelConfigs: {
    promptli: {
      label: "Promptli Comms",
      description: "Email, SMS and phone calls for the agent over Promptli Agent Link.",
      schema,
      uiHints: PromptliChannelConfigSchema.uiHints,
    },
  },
};
const text = JSON.stringify(next, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (text !== readFileSync(path, "utf8")) {
    console.error("openclaw.plugin.json#channelConfigs is out of date: run `npm run build && node scripts/sync-manifest.mjs`");
    process.exit(1);
  }
  console.log("sync-manifest: up to date");
} else writeFileSync(path, text);
