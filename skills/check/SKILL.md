---
name: check
description: Check MCP servers.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-mcp-check.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-mcp-check.mjs *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-mcp-check.mjs" *) PowerShell(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-mcp-check.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-mcp-check.mjs" lint --project "${CLAUDE_PROJECT_DIR}" --markdown`

At most 10 lines: each problem with its file and line, and the fix. If there are no findings, say so in one line. For one server that does not start, the user can run `claude-mcp-check why <name>` in a terminal. Edit nothing until the user agrees.
