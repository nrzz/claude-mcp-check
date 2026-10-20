# claude-mcp-check

[![test](https://github.com/nrzz/claude-mcp-check/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-mcp-check/actions/workflows/test.yml) [![e2e](https://github.com/nrzz/claude-mcp-check/actions/workflows/e2e.yml/badge.svg)](https://github.com/nrzz/claude-mcp-check/actions/workflows/e2e.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

MCP configuration is where Claude Code's issue tracker is busiest. On 16 October 2026, anthropics/claude-code had 534 open issues under area:mcp, 517 with "mcp" in the title, 81 with "mcp connect" and 61 with "mcp fail". The same shapes come back. A server is defined in several places (your `~/.claude.json`, a project's entry in it, a `.mcp.json`, a plugin) and nothing says which definition wins or whether a `.mcp.json` server was ever approved. A server shows "failed to connect" with no cause: a command that is not on the PATH, an `npx` that needs longer than `MCP_TIMEOUT`, a program that prints to stdout. Environment variables do not reach a server ([#11927](https://github.com/anthropics/claude-code/issues/11927), 31 reactions). A server cannot be switched off from the command line ([#10447](https://github.com/anthropics/claude-code/issues/10447), 55 reactions): `claude mcp` adds, removes, lists, gets, logs in and logs out, and `/mcp` toggles only inside a session. And the tool schemas of every server sit in the model's context, which no command outside a session shows.

claude-mcp-check shows every MCP server Claude Code would load for a project, from which file and with which definition winning, starts each one the way Claude Code would to see whether it answers the MCP handshake, what tools it offers and what their schemas cost in the model's context, explains a failure, lints the configuration, and switches a server on or off for a project. It is a plain Node program that runs outside Claude, so it costs no tokens.

## What you get

- `show`: every server Claude Code would load for the project. Each comes with the file, the key and the line of its definition, its scope, transport, command or URL (credentials hidden) and its state: active, pending approval, rejected, switched off for the project, blocked by an allow or deny list, skipped as invalid, or a duplicate. When a name is defined twice it says which definition wins and which are not used. The places it reads: `--mcp-config` files, the project's entry in `~/.claude.json`, the `.mcp.json` of the folder and of every folder above it, `~/.claude.json` itself, and the servers of enabled plugins.
- `check [name]`: starts each stdio server with the command, arguments, environment and folder Claude Code would use (`${VAR}` filled in the way the binary fills it in), performs the MCP handshake, lists tools, resources and prompts, times the answer to `initialize`, and sizes the tool schemas in characters and, as an estimate, in tokens. For an HTTP or SSE server it probes the URL and says from the status code whether a login is needed. Every process it starts is ended.
- `why <name>`: the cause that a server does not come up: not approved, switched off, blocked, an invalid definition, command not found, a `${VAR}` set nowhere, non-JSON on stdout, an exit before the handshake (with the exit code and the end of stderr), no answer within the timeout, needs login.
- `lint` finds:
  - a name defined in two scopes, and names that become the same tool prefix, so that one server's tools never reach the model;
  - a command that is not on the PATH, a `${VAR}` set nowhere (or set only where Claude Code does not look), a credential name that reads as empty in a remote server's headers;
  - a `.mcp.json` server nobody approved, a server both enabled and disabled, a list key that holds a plain string, an approval for a name that is not there;
  - a plain-http URL, an empty URL;
  - a file Claude Code ignores or rejects (a `.mcp.json` with a comment, `servers` or nothing where `mcpServers` belongs) and an entry it skips without a word.

  Each finding has the file and the line, what Claude Code does about it, and a fix.
- `toggle <name> --on|--off`: switches a server for the project. For a `.mcp.json` server it writes `enabledMcpjsonServers` or `disabledMcpjsonServers` in `.claude/settings.local.json`, the file `claude mcp reset-project-choices` clears; for any other server it writes `disabledMcpServers` of the project in `~/.claude.json`, the list behind "Disabled for this project" in `claude mcp list`. After a backup, with `--dry-run`, and `restore` puts the backup back.
- `--json` on every command, for scripts and for other tools.
- `/mcp-check:check`, a plugin skill that hands Claude the short form of the `lint` report (`lint --markdown`).

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: every command, `--json`, `--markdown` | 0 | It reads configuration files. `check` and `why` start only the servers you configured and connect only to the URLs you configured, and never to Anthropic. |
| The skill in the model's request | 0 | `/mcp-check:check` is user-only (`disable-model-invocation: true`) and its description is `Check MCP servers.`: 18 characters, about 5 tokens by characters / 4. With the plugin loaded, the request for a plain prompt had the same size as without it, the same tool list and no occurrence of `mcp-check`: 69,112 characters on 2.1.299 and 68,582 on 2.1.295, with and without the plugin; on Linux and macOS in CI the two sizes were equal as well, in all six jobs. `claude plugin details` projects `Always-on: ~9 tok` for the skill, and the capture does not bear that out. |
| `/mcp-check:check` | about 487 tokens once; about 1,057 at the cap | The model receives the lint report and a 247-character instruction that asks for a reply of at most 10 lines. For a project with 3 findings on Windows, with the paths of a temporary folder, that was 1,850 characters in the skill block and 97 in the command block: 1,947 in all, about 487 tokens by characters / 4. The report holds at most 12 findings, at most 300 characters to a line and at most 16 lines. A report at the cap (40 servers with long names, each with a command that is not there and an unset variable) was 4,226 characters (20 lines in the skill block), about 1,057 tokens. These are characters divided by 4, an estimate, not a count by Claude's tokenizer. The same findings in a terminal cost nothing: `claude-mcp-check lint`. |
| What the tool measures: your servers | the other side | The tool schemas of the MCP servers you run sit in the model's context. `check` says how many characters and, by characters / 4, how many tokens each server's tools take. That is what a request carries when the schemas load up front. Claude Code can defer them behind tool search (always with `ENABLE_TOOL_SEARCH=true`; its changelog says automatically once MCP tool descriptions pass 10% of the context window): then only the names and the server instructions load until the model asks for a tool. Which of the two holds for you was not measured ("Not verified"). |

## Install

**From a terminal**, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-mcp-check show --project .
```

```bash
npx -y github:nrzz/claude-mcp-check check --project .
```

Or from a clone:

```bash
git clone https://github.com/nrzz/claude-mcp-check
node claude-mcp-check/bin/claude-mcp-check.mjs show --project .
```

**As a Claude Code plugin**, in Claude Code:

```text
/plugin marketplace add nrzz/claude-code-toolkit
/plugin install mcp-check@claude-code-toolkit
```

Then type `/mcp-check:check`. It runs `lint --markdown` for the current project and asks Claude to answer in at most 10 lines: each problem with its file and line, and the fix. It also asks Claude to edit nothing until you agree. To try the plugin from a clone before it is in the marketplace: `claude --plugin-dir ./claude-mcp-check`.

## Use

The examples are real runs in a throwaway folder on Windows 11; the paths are shortened to `/home/me/shop`. The project has a user file, a local entry, a `.mcp.json` of seven servers and a settings file that approves some of them. The servers are small programs from `test/` (the fake server in different modes, behind a two-line script each), except `github`, a real URL that answers 401 to a request without a login.

```text
Usage: claude-mcp-check <command> [options]

Read (they change nothing):
  show     [--project <dir>] [--mcp-config <file>]...
           every MCP server Claude Code would load for the project: the file and the key each
           definition is in, scope, transport, command or URL, the approval of .mcp.json servers
           (approved, pending, rejected), whether the project switched it off or a policy blocks it,
           and which definition wins when a name is defined twice
  lint     [--project <dir>] [--mcp-config <file>]... [--markdown]
           a name defined in two scopes, a command that is not on the PATH, a ${VAR} that is set
           nowhere, a .mcp.json server nobody approved, a server both enabled and disabled, a list
           key that holds a plain string, a plain-http URL, an invalid entry or file, names that
           share a tool prefix. Exit 1 on an error or a warning. --markdown is the short report the
           /mcp-check:check skill hands to Claude (at most 12 findings, 16 lines); it always exits 0, because
           Claude Code drops a skill whose command fails

Start servers (they run the commands you configured, and connect to the URLs you configured):
  check    [name] [--project <dir>] [--mcp-config <file>]... [--timeout <ms>] [--send-headers]
           [--include-unapproved]
           start each stdio server with the command, arguments, environment and folder Claude Code
           would use, perform the MCP handshake, list its tools, resources and prompts, time the
           answer to initialize and size the tool schemas (characters, and characters / 4 as a token
           estimate); probe an HTTP or SSE URL and say from the status code whether it wants a login.
           A .mcp.json server nobody approved is not started unless --include-unapproved. Every
           child is ended before the command returns. Exit 1 when a server did not answer
  why      <name> [same options as check]
           the cause that a server does not come up: not approved, switched off, blocked by a list,
           an invalid definition, command not found, a ${VAR} set nowhere, non-JSON on stdout, an
           exit before the handshake (with the exit code and the end of stderr), no answer within
           the timeout, needs login. Exit 1 when there is one

Change (they write after a backup next to the file; --dry-run shows the change and writes nothing):
  toggle   <name> --on | --off [--project <dir>] [--dry-run]
           a .mcp.json server: disabledMcpjsonServers or enabledMcpjsonServers in the project's
           .claude/settings.local.json. Any other server: disabledMcpServers of the project in
           ~/.claude.json, the list behind "Disabled for this project" in claude mcp list
  restore  [--project <dir>] [--claude-json] [--list] [--dry-run]
           put the newest backup of .claude/settings.local.json back (of ~/.claude.json with
           --claude-json); --list names the backups. The file it replaces is saved first

Options for every command:
  --project <dir>   the folder Claude Code starts in (default: the folder you are in)
  --mcp-config <f>  also read the servers of this file, as claude --mcp-config does (repeat it for more files)
  --json            one JSON document on stdout
  -h, --help        this text
  -v, --version     the version

Exit codes: 0 ok; 1 findings, a failed server or a refusal; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), MCP_TIMEOUT (the default of --timeout),
and CLAUDE_MCP_CHECK_MANAGED_DIR (the folder to read managed-mcp.json and managed-settings.json from,
instead of the system folder; the tests use it).
It reads configuration files. Only check and why start programs or open connections, and only the
servers and URLs you configured. It writes only with toggle and restore, and it sends nothing to
Anthropic or anyone else.
```

Every command takes `--json` (one JSON document on stdout, see the end of this section). The exit codes are 0 for ok, 1 for findings, a server that did not answer or a refusal, and 2 for a usage error. The options a command does not take are refused by name. `--project <dir>` is the folder Claude Code starts in (default: the folder you are in); `--mcp-config <file>` adds the servers of a file, as `claude --mcp-config` does, and can be repeated.

### `show`

`show [--project <dir>] [--mcp-config <file>]...` reads everything once and prints where servers come from, highest precedence first, then each server with its state. Under a server: the file, the line and the key of the definition that is used; the other definitions of the name and why they are not used; the approval of a `.mcp.json` server and who gave it; what the project's switch or a list does; the names (never the values) of its `env` and `headers`; and each `${VAR}` that is set nowhere. A `.mcp.json` server nobody approved shows both answers: a session asks first, and `claude -p` loads it anyway.

```text
claude-mcp-check show
```

```text
claude-mcp-check 1.0.0  the MCP servers Claude Code would load
project   /home/me/shop
config    /home/me/.claude  (from CLAUDE_CONFIG_DIR); servers in ~/.claude/.claude.json
trust     this folder is trusted

Where servers come from, highest precedence first
  local         1 server    ~/.claude/.claude.json  projects["/home/me/shop"]
  project       7 servers   .mcp.json
  user          3 servers   ~/.claude/.claude.json  mcpServers

Servers (10; 7 active)
  scratch     local         stdio  active                      node servers/notes.mjs --scratch
      from ~/.claude/.claude.json:30  projects["/home/me/shop"].mcpServers.scratch
  indexer     project       stdio  active                      no-such-indexer --watch
      from .mcp.json:43  mcpServers.indexer
      approved by enabledMcpjsonServers in .claude/settings.local.json
  old-sync    project       stdio  rejected                    node servers/notes.mjs --old
      from .mcp.json:36  mcpServers["old-sync"]
      rejected by disabledMcpjsonServers in .claude/settings.local.json
  search      project       stdio  active                      node servers/search.mjs --key=${SEARCH_KEY}
      from .mcp.json:16  mcpServers.search
      approved by enabledMcpjsonServers in .claude/settings.local.json
      ${SEARCH_KEY} is set nowhere: Claude Code passes the text unchanged
  shop-db     project       stdio  active                      node servers/shop-db.mjs
      from .mcp.json:3  mcpServers["shop-db"]
      approved by enabledMcpjsonServers in .claude/settings.local.json
  slow-index  project       stdio  active                      node servers/slow-index.mjs
      from .mcp.json:23  mcpServers["slow-index"]
      approved by enabledMcpjsonServers in .claude/settings.local.json
  staging     project       stdio  pending approval            node servers/shop-db.mjs --staging
      from .mcp.json:9  mcpServers.staging
      not approved: a session asks first; claude -p loads it without asking
  docs        user          stdio  active                      node servers/notes.mjs --docs
      from ~/.claude/.claude.json:17  mcpServers.docs
      also defined in project (.mcp.json:29): not approved, so a session uses user; claude -p loads that one instead
  github      user          http   active                      https://api.githubcopilot.com/mcp/
      from ~/.claude/.claude.json:4  mcpServers.github
      headers Authorization  (values are never printed)
      ${GITHUB_TOKEN} is set nowhere: Claude Code passes the text unchanged
  notes       user          stdio  disabled for this project   node servers/notes.mjs
      from ~/.claude/.claude.json:11  mcpServers.notes
      disabledMcpServers lists it for this project (~/.claude/.claude.json); claude mcp list says "Disabled for this project"

Claude.ai connectors are fetched by Claude Code at start and are not listed here. Managed servers are read from the documented files only.
```

`docs` is defined in the project's `.mcp.json` and in your user file. The `.mcp.json` entry is not approved, so a session of Claude Code uses the user definition, and `claude -p` loads the project one (it loads unapproved servers without asking): `show` says both. `notes` is switched off for this project: it is in `disabledMcpServers` of the project's entry in `~/.claude.json`.

### `check`

`check [name] [--project <dir>] [--mcp-config <file>]... [--timeout <ms>] [--send-headers] [--include-unapproved]` starts what Claude Code would start. The timeout is `--timeout`, else `MCP_TIMEOUT` (what Claude Code waits), else 30,000 ms. A server that Claude Code would not start is listed and not started: a `.mcp.json` server nobody approved, one that is rejected or switched off, one that a list blocks, one that is invalid. A `.mcp.json` can come from a repository you cloned a minute ago, and running its commands is what the approval is for; `--include-unapproved` starts the unapproved ones anyway. `--send-headers` sends the headers of a remote server's configuration (never `headersHelper`, which would run a program); without it no header and no credential is sent, and a server that wants a login says so with its status code. Header values are never printed.

```text
claude-mcp-check check --timeout 1500
```

```text
claude-mcp-check 1.0.0  check
project   /home/me/shop
timeout   1,500 ms (--timeout)

scratch  (local, stdio)
    node servers/notes.mjs --scratch
    answered initialize in 88 ms (MCP 2025-11-25, notes 1.2.3)
    3 tools, 2 resources, 1 prompt
    tool schemas: 747 characters, about 187 tokens (characters / 4, an estimate); server instructions 34 characters, about 9 tokens

indexer  (project, stdio)
    no-such-indexer --watch
    not started: the command was not found
    run: claude-mcp-check why indexer

old-sync  (project, stdio)
    not started: rejected by disabledMcpjsonServers: Claude Code does not start it

search  (project, stdio)
    node servers/search.mjs --key=${SEARCH_KEY}
    ! ${SEARCH_KEY} is set nowhere: the server receives the text unchanged
    exited with code 3 after 72 ms, before answering initialize
    run: claude-mcp-check why search

shop-db  (project, stdio)
    node servers/shop-db.mjs
    answered initialize in 77 ms (MCP 2025-11-25, shop-db 1.2.3)
    3 tools, 2 resources, 1 prompt
    tool schemas: 747 characters, about 187 tokens (characters / 4, an estimate); server instructions 34 characters, about 9 tokens

slow-index  (project, stdio)
    node servers/slow-index.mjs
    no answer to initialize within 1,500 ms
    run: claude-mcp-check why slow-index

staging  (project, stdio)
    not started: not approved: Claude Code asks before it starts a .mcp.json server (use --include-unapproved to start it anyway)

docs  (user, stdio)
    node servers/notes.mjs --docs
    answered initialize in 54 ms (MCP 2025-11-25, notes 1.2.3)
    3 tools, 2 resources, 1 prompt
    tool schemas: 738 characters, about 185 tokens (characters / 4, an estimate); server instructions 34 characters, about 9 tokens

github  (user, http)
    https://api.githubcopilot.com/mcp/
    ! ${GITHUB_TOKEN} is set nowhere: the server receives the text unchanged
    HTTP 401: the server wants credentials (it sent a WWW-Authenticate header)
    the configuration sets a header (Authorization) that this probe did not send; use --send-headers to send them
    run: claude-mcp-check why github

notes  (user, stdio)
    not started: switched off for this project (disabledMcpServers): Claude Code does not start it

7 servers started, 3 answered, 4 failed, 3 not started.
9 tools in all; their schemas are 2,232 characters, about 558 tokens (characters / 4, an estimate).
A server that offers resources also makes Claude Code send 3 tools of its own (ListMcpResourcesTool, ReadMcpResourceDirTool, ReadMcpResourceTool), once for all servers: 2,080 characters, about 520 tokens, as measured on Claude Code 2.1.299.
Those schemas load up front unless Claude Code defers them behind tool search (always with ENABLE_TOOL_SEARCH=true; automatically once MCP tool descriptions pass a share of the context window, says Claude Code's changelog): then only the names load until the model asks for a tool.
```

The size of the tool schemas is the size of the JSON that Claude Code puts in its request: `{ name, description, input_schema }` for each tool, the name as `mcp__<server>__<tool>`, a description over 4,096 characters cut to 4,096 plus `… [truncated]`, a tool whose full name is over 128 characters left out. The figures matched the request of a `claude -p` run to the character ("What was verified" says how). A server that offers resources also makes Claude Code send three tools of its own, which the report says once.

### `why`

`why <name> [same options as check]` runs what `check` runs for one server and names the cause. A server that Claude Code would not start is explained without starting it, in this order: no such server; no definition Claude Code can use (every definition is invalid, or the only valid one is rejected); blocked by a list; not approved; switched off for the project; a plugin server that duplicates another server. For a server that is started the cause is one of these: a command that is not found (or not executable); a `${VAR}` set nowhere or set but empty (named as the cause when the server fails and the variable explains it, with what the server did as evidence); output on stdout that is not JSON-RPC; an exit before the handshake; no answer within the timeout; an error answer to `initialize`; a failing `tools/list`. For a URL: needs a login (401 or 403), wrong path, wrong transport, a failing server, nothing listening, a certificate that is not trusted. The exit code is 1 when there is a cause.

```text
claude-mcp-check why search --timeout 1500
```

```text
claude-mcp-check 1.0.0  why search

cause     variable-unset
what      ${SEARCH_KEY} is not set
from      project: .mcp.json:16
command   node servers/search.mjs --key=${SEARCH_KEY}

  ${SEARCH_KEY} in args[1] is set nowhere that Claude Code looks, so it passes the text unchanged to the server. It looks in the environment of the shell that starts Claude Code and in the env of your user settings.json. The env of a project or local settings file does reach the server's own environment, but is not used to fill in ${VAR}.
  What the server did: it exited with code 3 after 54 ms, before it answered initialize.
  stderr (last 2 lines):
    fake-mcp: fatal: the API_KEY variable is not set
        at loadConfig (server.js:12:9)
  Claude Code reports this as "CONNECTION_CLOSED: Connection closed".

fix       Set SEARCH_KEY before you start Claude Code, or put it in "env" in your user settings.json, or write a default: ${SEARCH_KEY:-value}.
```

```text
claude-mcp-check why slow-index --timeout 1500
```

```text
claude-mcp-check 1.0.0  why slow-index

cause     timeout
what      no answer to initialize within 1500 ms
from      project: .mcp.json:23
command   node servers/slow-index.mjs

  The process started and stayed alive without a single line of JSON-RPC. MCP_TIMEOUT is not set (Claude Code waits 30 seconds).

fix       A first start can be slow (npx downloads the package). Run it once in a terminal, then try again; raise MCP_TIMEOUT if it needs longer. Claude Code reports this as "connection timed out".
```

### `lint`

`lint [--project <dir>] [--mcp-config <file>]... [--markdown]` checks everything that `show` reads. The exit code is 1 when there is an error or a warning, 0 otherwise (a note does not count). A finding has one of three severities:

- an error: Claude Code drops something the file says (a whole file, a server);
- a warning: the configuration still applies, but something in it is probably not what you meant;
- a note: worth knowing, nothing is lost.

```text
claude-mcp-check lint
```

```text
claude-mcp-check 1.0.0  lint
project   /home/me/shop

.mcp.json
  warning unapproved            line 9  [staging]
      "staging" in .mcp.json is not approved
      effect: a session of Claude Code asks before it starts it; `claude mcp list` says "Pending approval"; `claude -p` loads it without asking
      fix: claude-mcp-check toggle staging --on
  warning variable-unset        line 16  [search]
      "search": ${SEARCH_KEY} is set nowhere (args[1])
      effect: Claude Code passes the text "${VAR}" unchanged (and says so under "MCP config diagnostics" in `claude mcp list`)
      fix: Set SEARCH_KEY before you start Claude Code, or in "env" of your user settings.json, or write ${SEARCH_KEY:-default}.
  warning command-not-found     line 43  [indexer]
      "indexer": the command "no-such-indexer" is not on the PATH (the PATH of the server's env, 64 folders)
      effect: the server cannot start; Claude Code reports only "CONNECTION_CLOSED: Connection closed"
      fix: Install it, or write its full path in `command`.
  note    rejected              line 36  [old-sync]
      "old-sync" is rejected by disabledMcpjsonServers (.claude/settings.local.json)
      effect: Claude Code does not load it (`claude -p` loaded no rejected server in any permission mode tried); `claude mcp list` leaves it out
      fix: claude-mcp-check toggle old-sync --on

~/.claude/.claude.json
  warning variable-unset        line 4  [github]
      "github": ${GITHUB_TOKEN} is set nowhere (headers.Authorization)
      effect: Claude Code passes the text "${VAR}" unchanged (and says so under "MCP config diagnostics" in `claude mcp list`)
      fix: Set GITHUB_TOKEN before you start Claude Code, or in "env" of your user settings.json, or write ${GITHUB_TOKEN:-default}.
  warning duplicate-name        line 17  [docs]
      "docs" is defined in project (.mcp.json:29) and user (~/.claude/.claude.json:17), with different commands or URLs
      effect: Claude Code uses the user definition whole (~/.claude/.claude.json) and ignores the project one; fields are not merged
      fix: Keep one: claude mcp remove docs -s project
  note    disabled-for-project  line 11  [notes]
      "notes" is switched off for this project (disabledMcpServers in ~/.claude/.claude.json)
      effect: Claude Code does not connect to it (`claude mcp list`: "Disabled for this project")
      fix: claude-mcp-check toggle notes --on

0 errors, 5 warnings, 2 notes; 10 servers
```

The ids are `invalid-json`, `not-object`, `wrong-top-key`, `no-mcpservers`, `servers-not-object`, `unreadable`, `settings-ignored`, `skipped-server`, `duplicate-name`, `name-collision`, `unapproved`, `rejected`, `enabled-and-disabled`, `unknown-server-name`, `disabled-for-project`, `blocked-by-policy`, `policy-entry`, `plugin-duplicate`, `command-not-found`, `variable-unset`, `credential-read-as-empty`, `plain-http`, `invalid-url`, `empty-url`, `list-is-string`, `list-is-not-a-list`, `mcp-json-above-project` and `literal-credential`. Three need a word. `settings-ignored` is a settings file that is not valid JSON and holds an approval or a list: Claude Code ignores the whole file, so the approval does nothing. `list-is-string` is `enabledMcpjsonServers` or `disabledMcpjsonServers` written as `"shared"` where `["shared"]` belongs: Claude Code before 2.1.299 ignores the whole settings file for it, and 2.1.299 and newer read one name as a list of one. `credential-read-as-empty` is a name such as `${NPM_TOKEN}` in the `url` or `headers` of a remote server: Claude Code reads a list of credential names as empty there, set or not.

With `--markdown` the report is the short form the skill hands to Claude. It holds the errors and warnings only, at most 12 of them, each line at most 300 characters. When there are more, a last line says ``- ... and N more (run `claude-mcp-check lint`)``. It exits 0 whatever it finds, because a skill whose command exits 1 never reaches the model (checked: "What was verified").

```text
claude-mcp-check lint --markdown
```

```text
## mcp-check lint: /home/me/shop
10 servers found, 7 active; 0 errors, 5 warnings, 2 notes.
- WARNING `unapproved` .mcp.json:9 [staging]: "staging" in .mcp.json is not approved Effect: a session of Claude Code asks before it starts it; `claude mcp list` says "Pending approval"; `claude -p` loads it without asking. Fix: claude-mcp-check toggle staging --on
- WARNING `variable-unset` .mcp.json:16 [search]: "search": ${SEARCH_KEY} is set nowhere (args[1]) Effect: Claude Code passes the text "${VAR}" unchanged (and says so under "MCP config diagnostics" in `claude mcp list`). Fix: Set SEARCH_KEY before you start Claude Code, or in "env" of your user set…
- WARNING `command-not-found` .mcp.json:43 [indexer]: "indexer": the command "no-such-indexer" is not on the PATH (the PATH of the server's env, 64 folders) Effect: the server cannot start; Claude Code reports only "CONNECTION_CLOSED: Connection closed". Fix: Install it, or write its full path in `…
- WARNING `variable-unset` ~/.claude/.claude.json:4 [github]: "github": ${GITHUB_TOKEN} is set nowhere (headers.Authorization) Effect: Claude Code passes the text "${VAR}" unchanged (and says so under "MCP config diagnostics" in `claude mcp list`). Fix: Set GITHUB_TOKEN before you start Claude Code…
- WARNING `duplicate-name` ~/.claude/.claude.json:17 [docs]: "docs" is defined in project (.mcp.json:29) and user (~/.claude/.claude.json:17), with different commands or URLs Effect: Claude Code uses the user definition whole (~/.claude/.claude.json) and ignores the project one; fields are not merg…
```

### `toggle`

`toggle <name> --on|--off [--project <dir>] [--dry-run]` changes one list, in the file that fits the server, after a backup next to it (`<file>.bak-mcp-check-<timestamp>`). The text of the file is edited and nothing else in it moves: indentation, line endings and the order of keys stay, and taking out what was put in gives back the same bytes. A file that is not valid JSON is left alone and the command exits 1. `--dry-run` says what it would do.

- A `.mcp.json` server: `--off` adds the name to `disabledMcpjsonServers` in `<project>/.claude/settings.local.json`; Claude Code then rejects it (`claude mcp list` leaves it out, `claude mcp get` says Rejected, and `claude -p` does not load it in any of the permission modes tried). `--on` takes the name out and, when nothing else approves the server, adds it to `enabledMcpjsonServers`. If another settings file still rejects it, `--on` refuses and names the file; it writes only the local one.
- Any other server (user, local or plugin scope): `--off` adds the name to `disabledMcpServers` of the project in `~/.claude.json`, `--on` takes it out. `claude mcp list` says "Disabled for this project".

`~/.claude.json` is the file Claude Code keeps rewriting, so `toggle` takes the lock directory that Claude Code takes around its own writes (`.claude.json.lock`), writes through a temporary file and a rename, and gives up after 5 seconds if another program holds the lock. A running session reads the change when it starts.

```text
$ claude-mcp-check toggle staging --on --dry-run
would add staging to enabledMcpjsonServers in .claude/settings.local.json

$ claude-mcp-check toggle staging --on
add staging to enabledMcpjsonServers in .claude/settings.local.json; the old file is saved as /home/me/shop/.claude/settings.local.json.bak-mcp-check-20261016-173000
Restart Claude Code for a running session to pick it up. claude-mcp-check restore puts the old file back.

$ claude-mcp-check toggle notes --on
remove notes from disabledMcpServers in ~/.claude/.claude.json (projects["/home/me/shop"]); the old file is saved as /home/me/.claude/.claude.json.bak-mcp-check-20261016-173000
Restart Claude Code for a running session to pick it up. claude-mcp-check restore puts the old file back.

$ claude-mcp-check restore --list
/home/me/shop/.claude/settings.local.json.bak-mcp-check-20261016-173000
```

### `restore`

`restore [--project <dir>] [--claude-json] [--list] [--dry-run]` puts the newest backup back (of `~/.claude.json` with `--claude-json`), after saving the file it replaces, so that a restore can be undone by another restore. `--list` names the backups.

### The JSON documents

Every command takes `--json` and then prints one JSON document and nothing else, also for a usage error (`{ "ok": false, "error": "..." }`, exit 2). Paths in a document are the paths of the system it ran on. The shapes below name the fields that are always there and mark the ones that are not with `?`.

```text
show    { project, projectKey, trusted, configDir, configSource, claudeJson: { path, exists, error },
          sources: [ { kind, file, display, exists, servers, note? } ],
          servers: [ { name, state, loads, headlessLoads, scope, kind, transport, file, display, line, keyPath,
                       command?, args?, envNames?, url?, headerNames?, approval, disabledBy, policy, toolPrefix, sharesPrefixWith,
                       headless, duplicateOf?, references: { missing, empty, readAsEmpty }, plugin?,
                       definitions: [ { scope, kind, role, file, display, line, keyPath, transport, command?, args?, url?, invalid?, approval? } ] } ],
          collisions, problems, counts }
check   { project, timeoutMs, timeoutSource, mcpTimeout, servers: [ { name, state, scope, transport, checked, skipped, ok,
                       command, url, references, process, http, initialize, counts, tools, resources, prompts, cost, notes } ],
          totals, resourceTools, note }
why     { name, found, cause, ok, summary, details, fix, warnings, state, scope, display, command, process, http }
lint    { project, configDir, claudeJson, findings: [ { id, severity, effect, server, file, display, line, message, does, fix } ], counts, servers }
toggle  { ok, refused, dryRun, name, on, kind, mechanism, stateBefore, changes: [ { file, display, key, op, item, changed, created, backup } ], notes }
restore { ok, refused, dryRun, file, from, savedCurrent }   (--list: { ok, file, backups })
```

- `state` is `active`, `pending`, `rejected`, `disabled`, `blocked`, `skipped` or `duplicate`. `loads` is what a session does, `headlessLoads` what `claude -p` does (they differ for `pending`).
- `process` in `check` is `{ started, spawnError, exit, timedOut, killed, stderr, nonJsonLines, nonJsonSamples }`; `http` is `{ status, outcome, detail, headerNames, sentHeaders, note }`; `cost` is `{ toolSchemaChars, toolSchemaTokensEstimate, toolsSent, toolsLeftOut, descriptionsCut, instructionsChars, instructionsTokensEstimate, perTool }`.
- `cause` in `why` is one of `not-found`, `invalid-config`, `blocked-by-policy`, `disabled`, `not-approved`, `duplicate`, `command-not-found`, `command-not-executable`, `variable-unset`, `variable-empty`, `non-json-stdout`, `early-exit`, `timeout`, `handshake-error`, `tools-list-failed`, `needs-login`, `endpoint-not-found`, `wrong-transport`, `server-error`, `unreachable`, `tls-error`, `redirect`, `not-mcp`, `not-probed`, `spawn-failed`, `ok`.

## How it works

It reads, on your machine only, the places below. The paths come from Claude Code's documentation; the ones that "What was verified" names were checked with the binary.

- **`~/.claude.json`**: at `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set, else `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows). A `~/.claude/.claude.json` is not read. It holds the **user** servers (`mcpServers`) and, under `projects["<key>"]`, the project's **local** servers (`mcpServers`), its trust (`hasTrustDialogAccepted`), and the servers the project switched off (`disabledMcpServers`). The key is the root of the git repository the folder is in, else the folder, with slashes (`C:/Users/me/shop`). The key is not the folder you are in when that is inside a repository, and a parent folder's entry is not used.
- **`.mcp.json`**, the **project** servers: the one in the folder and one in every folder above it, up to the root of the drive (the binary read one above the git repository too). The nearest wins a name.
- **`--mcp-config <file>`**: the servers of the files named on the command line, which win over every scope (as they do for a run of Claude Code).
- **Plugins**: `<config folder>/plugins/installed_plugins.json` lists the installs; a plugin counts when it is enabled (`enabledPlugins` in the settings files; the highest file that mentions it decides) and, for an install made for one project, when the project is that one. Its servers are in a `.mcp.json` at its root or in `mcpServers` of its `plugin.json` (an object, a path, or a list of those), and are named `plugin:<plugin>:<server>`; its tools are `mcp__plugin_<plugin>_<server>__<tool>`.
- **The settings files**, highest first: `managed-settings.json` and `managed-settings.d/*.json` in the system folder (`C:\Program Files\ClaudeCode` on Windows, `/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux), `<project>/.claude/settings.local.json` (on Linux and macOS in a git repository also the one at the root), `<project>/.claude/settings.json`, and `<config folder>/settings.json` (`$CLAUDE_CONFIG_DIR` or `~/.claude`). They hold the approvals (`enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers`), the lists `allowedMcpServers` and `deniedMcpServers`, the `env` blocks and `enabledPlugins`. A file that is not strict JSON is ignored, as Claude Code ignores it.
- **`managed-mcp.json`** and `managedMcpServers` of the managed settings, from the system folder. They are read as the documentation describes them and the binary was not put to them.

**Which definition wins.** `--mcp-config`, then local, then project (the nearest `.mcp.json` first), then user, then plugin. The whole entry of the winner is used; fields are not merged. An invalid definition is skipped and the next one is used. A `.mcp.json` definition that is rejected is skipped too, and one that is pending is skipped by a session and used by `claude -p`. After the winner is chosen, the project's switch (`disabledMcpServers`) and the allow and deny lists decide about the name. A name that a deny list names (or an allow list leaves out) vanishes from `claude mcp list`; a name the project switched off is listed as "Disabled for this project", with the definition that won. In neither case does the definition of another scope take over. A plugin's server with the same command or URL as another server is dropped as a duplicate. Names that become the same prefix (`my.server` and `my_server` are both `mcp__my_server__`) keep the tools of the server that connects first, and the tools of the others are dropped without a word, although they show as connected; which one connects first is down to timing, so the report names the group and does not pick a winner.

**Approval.** A `.mcp.json` server is approved by `enableAllProjectMcpServers: true` or by its name in `enabledMcpjsonServers`, from the user or managed settings in any folder, from the project and local settings only in a trusted folder (`projects["<key>"].hasTrustDialogAccepted` for exactly that key: not a parent's, not the folder inside a repository), or from the older place, the project's entry of `~/.claude.json`. A name in `disabledMcpjsonServers` of any file rejects it, and wins over every approval.

**`${VAR}`.** In `command`, `args`, `env`, `url` and `headers`: `${VAR}` is the value (an empty value stays empty); `${VAR:-text}` is the text when VAR is unset (the text ends at the first `}`); an unset variable without a default is left as `${VAR}` and Claude Code warns about it in `claude mcp list`. `$VAR`, `%VAR%`, `~` and `${VAR-text}` are not references, and there is no escape. The variables are the environment of the process with the `env` of the **user** settings file on top; the `env` of a project or local settings file is not used for `${VAR}`, although it does reach the server's own environment. In the `url` and `headers` of a remote server `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_CUSTOM_HEADERS` read as empty (the documentation adds `HTTPS_PROXY` and says the list is not complete). In a plugin's server `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are filled in; elsewhere `CLAUDE_PROJECT_DIR` is not available to `${VAR}`.

**Starting a server.** On Windows the command string is split on spaces and tabs (double quotes group; single quotes and backslashes do nothing special; no shell syntax), unless it is a file as a whole; the first word is the program and the rest go in front of `args`. On Linux and macOS it is not split: the whole string is the name of the program, so `"command": "npx -y some-server"` fails there with ENOENT (put the program in `command` and the rest in `args`; that works everywhere). The program is looked up in the PATH of the server's own environment (so a PATH in the server's `env` counts), relative to the project folder when it has a folder part, and on Windows with the extensions `.com .exe .bat .cmd` (the binary started `.cmd` and `.bat` files, as it must for `npx`; this tool starts them through `cmd.exe`). The server's environment is the process environment, the `env` of the user, project and local settings, `CLAUDE_PROJECT_DIR`, and the server's own `env`, which wins. Its folder is the project folder. The handshake is `initialize` (protocol 2025-11-25, no client capabilities), `notifications/initialized`, then `tools/list`, `resources/list` and `prompts/list` for what the server declares, following `nextCursor`. A line on stdout that is not JSON-RPC is noticed and set aside (Claude Code 2.1.295 and 2.1.299 did the same before the handshake). Afterwards stdin is closed and, if the process is still there 300 ms later, its tree is ended (Windows `taskkill /T`, elsewhere the process group), and a process that is still running when this tool exits is ended by an exit handler. Claude Code first sends a `server/discover` request (protocol 2026-07-28) and this tool does not.

**What `toggle` writes.** See the section above: one list, one file, after a backup.

### Privacy

It reads the files listed above, on your machine. To find the project key and the local settings file it looks for `.git` in the folders above the project, and it reads the `.mcp.json` of each of them. It writes only on `toggle` and `restore`, and only what is described above: a settings file or `~/.claude.json`, saved next to itself first. It has no network code except where a command's job is a connection: `check` and `why` connect to the URL of an HTTP or SSE server you configured, with no credential of its own, never reading a token, and sending the headers of the configuration only with `--send-headers`; they start the stdio servers you configured, which can do whatever those programs do. Nothing is sent to Anthropic or to anyone else, there is no telemetry and no account. A test fails if any file under `src/` or `bin/` imports anything but `node:` modules, if any file but `src/stdio.mjs` imports `node:child_process` or any file but `src/http.mjs` opens a connection, or if any file but `src/write.mjs` writes. No environment value and no header value is printed or put in a JSON document (their names are), arguments and URLs are printed with the value of anything that looks like a credential hidden, and a server's stderr and stdout go through the same hiding. The plugin's skill runs `lint` and puts its report in front of Claude when you invoke it. That report holds file paths, line numbers, server names and messages; it holds no environment value and no header value.

## What was verified, and how

Checked on 2026-10-16 on Windows 11 with Node 24.19.0, git 2.55.0 and Claude Code 2.1.295 and 2.1.299 (every real-binary check passed on both). CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18. It runs the real-binary checks on Linux and macOS against the npm release of Claude Code (2.1.301 on 16 October 2026). On commit 80e78c0 all 10 jobs of the unit tests (run 38937922840) and both jobs of the real-binary checks (run 38937922906) were green. The badges at the top show the latest runs.

- **252 automated tests** (`npm test`, Node's own runner, no dependencies, about 7 seconds). `node --test` also reports each of the six helper files under `test/` as a passing test, on every Node version CI runs (18 to 24); those are not counted here. Without a Claude Code binary 194 pass on Windows and 195 on Linux and macOS (the tests of file modes and of symbolic links are skipped on Windows, the one of `.cmd` files on the other systems). 56 are the real-binary checks below and run only when `E2E_CLAUDE` names a binary. The tests cover:
  - `${VAR}`: every rule of the expansion, with the patterns that the binary was given;
  - the validation of server entries (39 entries in a table, with the words of `claude mcp list`), the allow and deny lists (the matching of names, commands and URL patterns, with the examples of Claude Code's documentation);
  - the editing of JSON by its text: 9 layouts (LF, CRLF, tabs, four spaces, one line, a byte-order mark, no final newline, an empty object) for adding a name to a list and taking it out again, with the same bytes coming back;
  - the loader (the places, trust, approvals, the order of the settings files, `env` by scope), the winner of a name, the states, plugins found through `installed_plugins.json`, names that share a tool prefix;
  - the split of a command string, the lookup of a command (PATH, folders, extensions, what is not executable), the environment of a server;
  - the stdio probe against the fake server in 11 modes (answers, pages, tools only, a banner, garbage, an early exit with a code, a sleeper, a silent server, an error answer, a slow answer, one that ignores the closing of stdin and has a child of its own); every process it starts is ended, with its child; the HTTP probe against local servers (JSON and event-stream answers, every status code, headers sent only when asked, nothing secret in a result);
  - `check`, `why`, `lint` (a table of 38 configurations), `toggle`, `restore` and the code that writes (backups, atomic writes, the lock, a stale lock), and the command line (every usage error, every exit code, the reports, no secret in any of them);
  - the package files, the workflows and the README: its sections, commands and flags, the usage block, the toolkit list, the numbers it quotes; the skill; no carriage return in a tracked file.
- **56 checks against the real binary** (`test/e2e-claude.test.mjs`, run when `E2E_CLAUDE` names a Claude Code binary). Each starts a fake Messages API on 127.0.0.1, so no model is reached and no token is spent; the MCP servers are `test/fake-mcp-server.mjs`. Each has its own throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` and a project folder that Claude Code already trusts. All 56 passed on 2.1.295 and on 2.1.299 on Windows. In CI the same 56 checks ran on Linux and on macOS against Claude Code 2.1.301, the newest npm release that day, and, started by hand with the workflow's version input, against 2.1.299 and 2.1.295: in each of the six jobs 55 passed and 1 was skipped, the check of the PowerShell tool, which is Windows only. The findings below were the same everywhere unless a bullet says otherwise:
  - **Where servers come from and which wins.** A server in `$CLAUDE_CONFIG_DIR/.claude.json` (`mcpServers`), in the project's entry there, in a `.mcp.json`, in a file named by `--mcp-config` and in an installed plugin was loaded, and `show` named each one. The same name in 11 combinations of those places: the binary used the definition `show` says it uses (local over project over user, `--mcp-config` over all), and `lint` called a name in two scopes with different commands a warning, as `claude mcp list` does ("Conflicting scopes"). An invalid definition fell through to the valid one below it, a rejected one too, and a pending one was used by `claude -p` and not by a session. The project key was the root of the git repository, not the folder inside it and not a parent; `.mcp.json` files were read in the folder and in every folder above it, the nearest winning a name. Without `CLAUDE_CONFIG_DIR` the file is `~/.claude.json` and `~/.claude/.claude.json` is not read. A plugin's servers, found through `installed_plugins.json`, were named `plugin:<plugin>:<server>`; a project-scope install loaded in its project only; a disabled plugin loaded nowhere; with `enabledPlugins` in the user, project and local settings files, the highest file that mentions the plugin decided whether it loaded, in 7 combinations; five shapes of a plugin's MCP file (a wrapper, flat, inline, a path, a list of paths) were read by the binary and by the tool; a plugin server with the same command as a user server was dropped.
  - **States.** 13 servers in 6 states (active, pending, rejected, switched off, blocked and invalid; user, local and `.mcp.json` servers, and servers blocked by a name and by a command): `claude mcp list` and `claude mcp get` said what `show` says for each. 13 ways of approving or rejecting (the user, project and local settings files, trusted and not trusted folders, `enableAllProjectMcpServers`, the older place in `~/.claude.json`, a rejection winning over an approval, a settings file with a comment) were read by the binary as `show` reads them. `claude -p` loaded a pending `.mcp.json` server and never loaded a rejected one, in 7 ways of starting it (no flag, five `--permission-mode` values, `--dangerously-skip-permissions`). `claude mcp reset-project-choices` cleared `enabledMcpjsonServers`, `disabledMcpjsonServers` and `enableAllProjectMcpServers` in `.claude/settings.local.json` and in the project's entry of `~/.claude.json` and left the `settings.json` files of the project and of the user, and the `disabledMcpServers` list, alone. 12 allow and deny lists (by name, by the whole command, by URL pattern, an empty allowlist, a plain string where an entry belongs) and the same lists in the project and local files: the servers that the tool calls blocked were exactly the ones `claude mcp list` did not list. A name that a deny list names vanished whole, with no fallback to another scope; a name the project switched off was listed as "Disabled for this project" with the definition that won, and the definition of the other scope did not take over.
  - **What the model receives.** The first request of a `claude -p` run against the fake API carried the tools as `{ name, description, input_schema }`, sorted by name, named `mcp__<server>__<tool>`; the size that `check` reports was the size of the request, to the character, for the tools of one server (4 tools, 982 characters, about 246 tokens by characters / 4). A description of 6,000 characters was cut to 4,096 plus `… [truncated]` on 2.1.299 and to 2,048 plus the same text on 2.1.295 (the changelog moves the limit in 2.1.296); a tool whose full name was 128 characters was sent and one of 129 was not. The server's instructions arrived in the first user message, under "# MCP Server Instructions". A server that offers resources made Claude Code send three tools of its own (`ListMcpResourcesTool`, `ReadMcpResourceDirTool` and `ReadMcpResourceTool`, 2,080 characters together), a server with tools only did not. With `ENABLE_TOOL_SEARCH=true` the request carried no MCP tool at all (14 tools instead of 28 on Windows, 12 instead of 26 on Linux and macOS), and the server cost 278 characters of the request for a server with 3 tools, against 2,979 characters when its schemas load up front. The names that two servers share (`my.server`, `my_server`) became one prefix and the tools of one server only were sent: the one that connected first (with a first server that answered 1.5 s late the second one won).
  - **`${VAR}`.** 32 patterns in the command's arguments and in `env` (set, empty, unset, with a default, the shell forms that are not references, a nested default, a name in the other case, a name that starts with a digit, two references side by side) were expanded by the binary and by the tool to the same text, for a server in `~/.claude.json` and for one in a `.mcp.json`; the diagnostics of `claude mcp list` named the same missing variables. The user settings' `env` was used for expansion and the project and local files' `env` was not, although all three reached the server's own environment. In a remote server's `url` and `headers` 11 of 45 names read as empty (`ANTHROPIC_API_KEY`, `NPM_TOKEN` and nine more) and the rest, `GITHUB_TOKEN` and `OPENAI_API_KEY` among them, expanded: the binary and the tool's list agreed name by name on both versions. `check --send-headers` sent the headers that the binary sent, and `check` alone sent none.
  - **Starting a server.** 16 ways of writing a command on Windows, 12 on the other systems (an absolute path, a name on the PATH, a name nowhere, a command line in one string, one with its arguments in `args` too, tabs and double spaces, single quotes, a leading space, a relative path, a path that is not there, a file that is not executable, a PATH set only in the server's `env`, and on Windows a `.cmd` file, a `.bat` file, `./node.exe` and `sub/node.exe`): the binary started the server in exactly the cases the tool says, with the same arguments. Three of them depend on the system: a command line in one string, one with its arguments in `args` too, and one with tabs and double spaces between the words are split on Windows (2.1.295, 2.1.299) and are not split on Linux and macOS, where the binary failed with `ENOENT: no such file or directory, posix_spawn` for the whole string (2.1.295, 2.1.299 and 2.1.301); the tool does the same on each. The working folder, `CLAUDE_PROJECT_DIR` and the variables the server was told to show were the same under the binary and under `check`; the binary adds `CLAUDECODE`, `AI_AGENT` and a few `CLAUDE_CODE_*` session variables of its own, which `check` does not. The handshake of the binary was `server/discover`, then `initialize` (protocol 2025-11-25; roots and elicitation offered), the notification, and the three lists together; the tool sends `initialize` with no capabilities, the notification and the lists.
  - **Failures.** For 10 modes of the fake server, a command that is not there and a variable that is not set, `claude mcp list` said "Failed to connect" exactly when `check` said the server did not answer, and `why` named the cause: an early exit (the exit code 3 and the end of stderr), garbage on stdout (a timeout for the binary), a sleeper and a silent server (timeouts), an error answer to `initialize` (`-32603: cannot start: the database is down` in both), a command not found (`CONNECTION_CLOSED: Connection closed` on Windows, `ENOENT: Executable not found in $PATH` on Linux and macOS) and a variable not set (the server exits: `CONNECTION_CLOSED: Connection closed`). A banner line before the handshake did not stop it, in the binary or in the tool. Every process `check` started was gone when it returned. HTTP: a JSON answer and an event-stream answer connected in both; a 403 was "Needs authentication", a 401 started OAuth discovery and failed with a 404 for the fake server, a 404 was "MCP endpoint not found", a 405 and a 500 and a refused connection were failures; `check` classified each from the status.
  - **`lint`.** 28 of the 38 configurations of the lint table were put to `claude mcp list` in a throwaway folder, and `lint` found what each row expects. They include a `.mcp.json` that is not valid JSON, an empty object, a list, one with `servers` for `mcpServers` and one with `mcpServers` as a list, an entry that Claude Code skips, a `${VAR}` set nowhere (in the project's settings only, in the user's, and `CLAUDE_PROJECT_DIR` outside a plugin), a name in two scopes with the same command and with different ones, an approval that a comment in the settings file hides, a rejected server, a server both enabled and disabled, a `.mcp.json` above the project, and a deny list. An empty `.mcp.json` file (zero bytes) was no problem for 2.1.299 and `Failed to parse` for 2.1.295; `lint` says nothing about it.
  - **`toggle`.** `--off` then `--on` on a `.mcp.json` server changed only the one list and gave the file back byte for byte; the binary rejected the server after `--off` (`claude mcp get`: Rejected, not in `claude mcp list`, not loaded by `-p`) and connected it after `--on`; `--on` approved a server nobody had approved. For servers in `~/.claude.json` and for a plugin's server the list `disabledMcpServers` of the project was written, `claude mcp list` said "Disabled for this project", `-p` loaded none of the ones in `~/.claude.json`, and `--on` gave `~/.claude.json` back byte for byte (the file as Claude Code had left it). In a world that knew nothing of the project the entry the tool made was read by the binary. With a `claude -p` run in progress (a slow server held it open) the edit was in the file when the run ended, and so were the run's own entries, and the lock was gone.
  - **The skill.** `claude plugin validate` and `--strict` pass. With the plugin loaded, a plain prompt's request was the same size as without it (69,112 characters on 2.1.299 and 68,582 on 2.1.295, with and without the plugin; on Linux and macOS in CI the two sizes were equal as well, in all six jobs) and had the same tool list. `/mcp-check:check` reached the model with the lint report for the project in it and the instruction after it, also when the lint found problems; a skill whose command line exits 1 (the plain `lint` with a problem found) never reached the model, which is why the markdown report exits 0. The figures in "What it costs in tokens" are from that capture. The model could run the command from the skill's `allowed-tools` with no prompt in the default permission mode, with the Bash tool and, on Windows, the PowerShell tool. Claude Code runs the command line of a skill and pastes its output when the shell tool is allowed for it; otherwise it hands the model `[run this first, exactly as written, ...]` with the command filled in (seen with the PowerShell tool on Windows), and the skill's text reads right both ways. `claude plugin details` for the installed plugin: `Always-on: ~9 tok`, `check < 20` always-on and about 90 when used.
- **A real third-party server.** `npx -y @modelcontextprotocol/server-everything` (npm 1.0.0, the latest on 16 October 2026) answered `check` in a throwaway folder: server `mcp-servers/everything 1.0.0`, protocol 2025-11-25, 13 tools, 7 resources and 4 prompts, tool schemas of 5,161 characters (about 1,290 tokens by characters / 4) and instructions of 2,005 characters; `check` timed the answer to `initialize` at 8.4 seconds, starting from an empty npm cache. CI runs the same check in a step that may fail (it needs the network): it answered in all six jobs with the same figures (13 tools, 7 resources, 4 prompts, 5,161 characters of schemas, 2,005 of instructions), and `check` timed its answer to `initialize` at 3.0 to 3.9 s on Linux and 4.7 to 56.0 s on macOS, from an empty npm cache.
- **From GitHub.** `npx -y github:nrzz/claude-mcp-check show --project .` ran from the published repository with a throwaway npm cache and home folder. It printed the report for a folder with one server after 12 seconds on Windows 11 with Node 24.19.0, the download from GitHub and the start included.

## Not verified

- **OAuth flows.** Never exercised. `check` says "needs login" from a 401 or 403 and does nothing about it. What Claude Code prints for a real OAuth server's 401 (`Needs authentication` or an OAuth error) was not seen: the fake server has no OAuth discovery, and the binary answered a bare 401 with `Dynamic Client Registration rejected (HTTP 404)`; a 403 gave `Needs authentication`.
- **The desktop app and VS Code.** Not driven. The servers those apps register in-process, and the connectors the desktop app delivers, are not read. claude.ai connectors are fetched by Claude Code at start and are not listed.
- **Windows named pipes** as a transport: not tried.
- **Servers behind corporate proxies.** `check` uses no proxy; Claude Code does, and a remote server behind one was not tried. Only this was seen: a `HTTPS_PROXY` that is not a valid URL made `claude mcp list` exit 1 with `Invalid proxy URL in https_proxy`, before it read any server (2.1.295 and 2.1.299), and `check` does not look at the proxy variables.
- **Managed settings, and the git root.** Managed settings from a server, a macOS profile and the Windows registry are not read. The managed folders (`C:\Program Files\ClaudeCode`, `/Library/Application Support/ClaudeCode`, `/etc/claude-code`), `managed-mcp.json`, `managedMcpServers` and `allowManagedMcpServersOnly` are read as the documentation describes them, and the rule that on Linux and macOS the `.claude/settings.local.json` at the root of a git repository counts too is taken from claude-permission-doctor's loader. The real binary was not put to any of these: that needs a folder the checks do not write to.
- **Permission modes in a session.** `claude -p` was tried with the default, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` and `--dangerously-skip-permissions`. An interactive session in one of those modes was not driven, so whether it asks about a pending `.mcp.json` server there is not known.
- **The approval prompt of a session.** Not driven (it is interactive). What its choices write was not seen. `claude mcp reset-project-choices` clears the approval keys in `.claude/settings.local.json`, which is why `toggle` writes there; the prompt may write elsewhere. Claude Code also reads approvals from the project's own settings files and from the user's, and `show` follows what the binary did with each.
- **The `/mcp` panel.** Not driven (it is interactive). Which file it writes when you switch a server on or off there was not seen; `toggle` writes `disabledMcpServers` of the project in `~/.claude.json` because that is the list `claude mcp list` and `claude -p` honoured ("What was verified").
- **A running session.** Whether it picks up a changed settings file or `~/.claude.json` without a restart was not checked; every real-binary check starts a new `claude` process after the files are written. The lock that `toggle` takes is the one Claude Code was seen to take, for tens of milliseconds around its writes; a write that falls between two of its writes was exercised once with a session that was running (the edit survived), not proven for every timing.
- **Worktrees.** The project key of a git worktree is the main checkout, taken from claude-permission-doctor's loader; the binary was not put to it.
- **Where a plugin's root is.** `${CLAUDE_PLUGIN_ROOT}` is taken from `installPath` in `installed_plugins.json`. For a plugin installed from a marketplace that is a folder on disk, the binary expanded it to the plugin's own folder inside that marketplace, not to the cached copy that `installPath` names (2.1.295 and 2.1.299, one plugin, in a probe that is not part of the checks), so `check` starts such a server with another path than Claude Code does. A marketplace on GitHub was not tried.
- **`headersHelper`**: never run, and not read for the cost of a server.
- **WebSocket servers** are listed and not probed. SSE servers are probed with a GET and the first event is read; the SSE handshake is not completed, so their tools are not listed.
- **Tool search on Claude Code's own API host.** The fake API host leaves tool search off, so the requests carry the schemas up front, and `ENABLE_TOOL_SEARCH=true` showed that none are sent when it is on. Whether tool search is on for you (the changelog's automatic mode, at 10% of the context window) was not measured, and what the names of deferred tools cost was measured for one server only.
- **The `-p` wait for slow servers.** In a probe that is not part of the checks, a `claude -p` run did not wait long for a server: one that answered `initialize` after 1.5 s was in the first request, one that answered after 2.5 s or later was `pending` in the init event and its tools were not in the first request, with `MCP_TIMEOUT` unset and set to 8,000 alike (2.1.295 and 2.1.299). The cut-off between those two was not mapped, `check` does not report it, and a session was not tried.
- **Token counts.** Every token figure is characters / 4, an estimate, and not a count by Claude's tokenizer.
- **Other versions.** The local runs are Claude Code 2.1.295 and 2.1.299, the CI run the newest npm release (2.1.301 on 16 October 2026). CI runs the real-binary checks with the newest release every week, so a later release that reads MCP configuration differently shows up there as a red job. The behaviours that differ between 2.1.295 and 2.1.299 are named where they come up (a plain string in an approval list, the cut of a long description, an empty `.mcp.json`), and the ones that differ between Windows and Linux and macOS in "Starting a server" and "Failures".
- **Linux and macOS** are covered by CI only; nothing was run on either by hand.
- **The marketplace line.** `/plugin install mcp-check@claude-code-toolkit` has not been tried: the toolkit's marketplace lists the plugin only after the hub is updated. The plugin installs and validates from a local marketplace folder.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-mcp-check.mjs` | The command |
| `src/cli.mjs` | The options, the help and the exit codes |
| `src/context.mjs`, `src/settings.mjs`, `src/paths.mjs` | Reading everything once: settings files, `~/.claude.json`, `.mcp.json` files, plugins; where each lives |
| `src/servers.mjs`, `src/validate.mjs` | Every definition of a server with its file, key and line; which entries Claude Code skips |
| `src/state.mjs`, `src/policy.mjs` | The winner of a name, approval, the project's switch, the allow and deny lists, names that share a tool prefix |
| `src/expand.mjs`, `src/launch.mjs`, `src/redact.mjs` | `${VAR}`; the command, its lookup and the environment; what is never printed |
| `src/stdio.mjs`, `src/http.mjs`, `src/protocol.mjs` | The only code that starts a program or opens a connection, and the handshake |
| `src/check.mjs`, `src/why.mjs`, `src/measure.mjs` | `check`; the causes of `why`; the size of the tools |
| `src/lint.mjs`, `src/report.mjs` | The findings; the text, markdown and JSON reports |
| `src/toggle.mjs`, `src/jsonedit.mjs`, `src/write.mjs` | What `toggle` changes; editing JSON by its text; the only code that writes (backups, atomic writes, the lock, restore) |
| `src/version.mjs`, `src/names.mjs`, `src/jsonfile.mjs` | The version number, which `package.json` and `plugin.json` must agree with; tool names; reading JSON files |
| `skills/check/` | `/mcp-check:check`, the user-only skill |
| `.claude-plugin/` | The plugin manifest and its icon |
| `test/` | `npm test`; `fake-mcp-server.mjs` is the MCP server of the tests, `validation-table.mjs` and `lint-table.mjs` are the configurations the validation and the lint are held to, `e2e-claude.test.mjs` puts them and the rest to the binary, `everything.mjs` checks a real third-party server |

Related: [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor) shows the merged settings and lints them against the schema, [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor) explains why a permission prompt appeared and finds dead rules, and [claude-hook-bench](https://github.com/nrzz/claude-hook-bench) runs every hook with the JSON Claude Code sends.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-mcp-check/issues?q=is%3Aopen+label%3A%22good+first+issue%22). For a wrong state, a wrong winner or a wrong cause, send the few lines of configuration that cause it and what `claude mcp list` and `claude mcp get <name>` say; that pair becomes a row of a table. Questions go to [Discussions](https://github.com/nrzz/claude-mcp-check/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does
- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo
- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema
- [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor): what auto mode and its classifier decided, from your transcripts, plus a lint of the autoMode settings
- [claude-sandbox-doctor](https://github.com/nrzz/claude-sandbox-doctor): whether Claude Code's Bash sandbox works on this machine, and why a command ran inside it, outside it, or not at all
- [claude-windows-doctor](https://github.com/nrzz/claude-windows-doctor): which shell the Bash tool gets on Windows and why, every claude on PATH, and the setup problems behind common Windows issues

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
