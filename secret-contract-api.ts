// Secret contract for `openclaw secrets audit` / SecretRef resolution: channels.promptli(.accounts.*).apiKey.
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "promptli",
  label: "Promptli Comms",
  accountFields: ["apiKey"],
  channelFields: ["apiKey"],
  mode: "account-inheritance",
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
