#!/usr/bin/env node
// claude-mcp-check: every MCP server Claude Code would load, from which file, whether it starts, and what its tools cost.
// All the work lives in src/cli.mjs; run `claude-mcp-check --help` for the commands.
import { main } from "../src/cli.mjs";

// `claude-mcp-check show | head` closes the pipe early: that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
