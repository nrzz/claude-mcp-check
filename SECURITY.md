# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-mcp-check/security/advisories/new](https://github.com/nrzz/claude-mcp-check/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/main/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool does, and does not do

It reads the files that tell Claude Code which MCP servers to load: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), the `.mcp.json` in the project folder and in every folder above it, the files named by `--mcp-config`, the settings files that apply (managed, user, project and local), the plugins' `installed_plugins.json` and their MCP files, and `managed-mcp.json` in the system folder. It has no telemetry or account and sends nothing to Anthropic or to anyone else.

**It starts programs and opens connections in two commands, `check` and `why`, and only the ones you configured.** A stdio server is started with the command, the arguments, the environment and the folder that Claude Code would use, asked the MCP handshake over its standard input and output, and ended (its standard input is closed, and the process tree is ended if it is still there 300 milliseconds later). An HTTP or SSE server gets a request at the URL you configured. That is the same as starting Claude Code, with one difference that matters: **a server from a `.mcp.json` that nobody approved is not started** (Claude Code asks first; `check` and `why` do not, unless you pass `--include-unapproved`), because a `.mcp.json` can come from a repository you cloned a minute ago and the command in it can be anything. Do not use `--include-unapproved` on a file you have not read.

`check` and `why` send no credential of their own and never read Claude Code's stored logins. The headers of a remote server's configuration are sent only with `--send-headers`, and `headersHelper`, which runs a program, is never run. No environment value, header value or token is printed: environment and header values are not shown at all (their names are), arguments and URLs are shown with the value of anything that looks like a credential hidden, and a server's own error text goes through the same hiding. A server can still print a secret in a way that nothing recognises: read the output before you paste it into an issue.

It writes only with `toggle` and `restore`: `<project>/.claude/settings.local.json` (the lists `enabledMcpjsonServers` and `disabledMcpjsonServers`) and `disabledMcpServers` of the project in `~/.claude.json`. Both are saved next to themselves first (`<file>.bak-mcp-check-<timestamp>`), changed by editing their text so that nothing else in them moves, and written through a temporary file and a rename. `~/.claude.json` is written under the lock directory that Claude Code takes around its own writes. A file that is not valid JSON is left alone. It never edits managed settings, `.mcp.json`, a plugin's files or the other settings files. `--dry-run` shows the change and writes nothing.

The lint and the states are a reading of what Claude Code did when it was put to the binary (the README's "What was verified" says which versions); they are not a guard. A server that passes `check` is not thereby safe to run, and a `.mcp.json` that lints clean can still name a program you should not trust. A wrong verdict is a bug and not a vulnerability: report it as an issue.
