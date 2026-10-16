// A check against a real third-party MCP server: `npx -y @modelcontextprotocol/server-everything`, the reference server of the
// protocol. It needs the network (npx downloads the package), so CI runs it as a step that may fail
// (.github/workflows/e2e.yml), and `npm test` does not run it: `node --test` starts this file without an argument and it does
// nothing. Run it by hand with `node test/everything.mjs run`. It prints which version of the server answered, which is what
// the README quotes.
import { tmpDir, world } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

if (process.argv[2] === "run") {
  const w = world("everything");
  const cache = tmpDir("cmc-npm-cache-");
  w.claudeJson({ mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: { npm_config_cache: cache } } } });
  let out = "";
  let err = "";
  const code = await main(["check", "everything", "--json", "--timeout", "180000"], {
    cwd: w.work, env: { ...w.env, npm_config_cache: cache }, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base,
    stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } },
  });
  if (code === 2) { console.error(err || out); process.exit(2); }
  const doc = JSON.parse(out);
  const s = doc.servers[0];
  const info = s.initialize && s.initialize.serverInfo;
  console.log(JSON.stringify({
    answered: s.ok,
    server: info ? `${info.name} ${info.version}` : null,
    protocolVersion: s.initialize ? s.initialize.protocolVersion : null,
    initializeMs: s.initialize ? s.initialize.ms : null,
    tools: s.counts ? s.counts.tools : null,
    resources: s.counts ? s.counts.resources : null,
    prompts: s.counts ? s.counts.prompts : null,
    toolSchemaChars: s.cost ? s.cost.toolSchemaChars : null,
    toolSchemaTokensEstimate: s.cost ? s.cost.toolSchemaTokensEstimate : null,
    instructionsChars: s.cost ? s.cost.instructionsChars : null,
    nonJsonLines: s.process ? s.process.nonJsonLines : null,
    stderrTail: s.ok ? undefined : s.process && s.process.stderr,
  }, null, 2));
  process.exit(s.ok ? 0 : 1);
}
