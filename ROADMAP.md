# Roadmap

What could come next. None of it is promised; all of it is open to contributors. Comment on an issue or start a [discussion](https://github.com/nrzz/claude-mcp-check/discussions) before a large change.

- `check`: the SSE handshake. Today an SSE server is probed with a GET and the first event is read; the endpoint it announces is not used to send `initialize`, so an SSE server's tools are not listed.
- `check`: the `server/discover` request that Claude Code 2.1.299 sends first (protocol 2026-07-28), to say how long a server that ignores unknown methods costs on its first connect. Claude Code's changelog says such a server is remembered for 7 days.
- A stored login for a remote server, without reading it: say whether Claude Code holds an OAuth login for a URL (the file or the keychain entry exists), so that a 401 can be told from an expired login. Today `check` says "needs login" from the status code only.
- `managed-mcp.json`, `managedMcpServers` and `allowManagedMcpServersOnly` are read from the documentation and from files in a folder the tests name; the real binary was not put to them, because that needs the system folder. A CI job on Linux with `sudo` could write `/etc/claude-code/managed-mcp.json` and check `show` against `claude mcp list`.
