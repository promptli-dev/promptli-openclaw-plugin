// Packaging checks (run after `npm run build`): manifest, package.json and built files agree.
import { existsSync, readFileSync } from "node:fs";

const fail = (m) => {
  console.error(`check-package: ${m}`);
  process.exit(1);
};
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const man = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));
if (man.version !== pkg.version) fail(`manifest version ${man.version} != package.json ${pkg.version}`);
if (!man.id || !man.configSchema) fail("manifest needs id and configSchema");
if (!man.channels?.includes(pkg.openclaw.channel.id)) fail("manifest channels must include openclaw.channel.id");
for (const f of [...pkg.openclaw.extensions, pkg.openclaw.setupEntry, "./dist/secret-contract-api.js"]) if (!existsSync(f)) fail(`missing built file ${f}`);
for (const dir of man.skills ?? []) if (!existsSync(`${dir}/promptli-comms/SKILL.md`)) fail(`missing skill in ${dir}`);
const mod = await import(new URL("../dist/index.js", import.meta.url));
const names = mod.TOOL_NAMES;
const declared = man.contracts.tools;
if (JSON.stringify([...names].sort()) !== JSON.stringify([...declared].sort())) fail(`contracts.tools out of sync with code: ${names}`);
for (const t of declared) if (!man.toolMetadata?.[t]) fail(`toolMetadata missing ${t}`);
if (typeof mod.default !== "object" && typeof mod.default !== "function") fail("default export missing");
console.log(`check-package: ok (${declared.length} tools, entry ${pkg.openclaw.extensions[0]})`);
