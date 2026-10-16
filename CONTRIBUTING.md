# Contributing to claude-mcp-check

Thanks for helping. claude-mcp-check is a CLI and a Claude Code plugin with one user-only skill, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-mcp-check/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-mcp-check/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-mcp-check/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output. For a wrong state, a wrong winner or a wrong cause, add the few lines of configuration that cause it and what `claude mcp list` and `claude mcp get <name>` say for the same server; that pair is the test case.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-mcp-check
cd claude-mcp-check
npm test
```

- `node bin/claude-mcp-check.mjs show --project <a project>` shows the servers of a project, `lint` the problems in them, `check` starts them.
- `E2E_CLAUDE=claude node --test test/e2e-claude.test.mjs` also puts the tool's claims about Claude Code to the real binary (see below).
- Point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at a temporary folder whenever you run the tool, the tests or `claude` by hand; the tests do it for themselves. `~/.claude.json` is the file Claude Code keeps rewriting; never test against yours.

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/claude-mcp-check.mjs` | the CLI entry |
| `src/cli.mjs` | the options, the help, the exit codes |
| `src/context.mjs`, `src/settings.mjs`, `src/paths.mjs` | reading everything once: the settings files, `~/.claude.json`, the `.mcp.json` files, the plugins; where each lives |
| `src/servers.mjs`, `src/validate.mjs` | every definition of a server and the file, key and line it is in; which entries Claude Code skips |
| `src/state.mjs`, `src/policy.mjs` | the winner of a name, approval, the project's switch, the allow and deny lists, names that share a tool prefix |
| `src/expand.mjs`, `src/launch.mjs`, `src/redact.mjs` | `${VAR}`; the command, the lookup, the environment; what is never printed |
| `src/stdio.mjs`, `src/http.mjs`, `src/protocol.mjs` | the only code that starts a program (`stdio.mjs`) or opens a connection (`http.mjs`), and the handshake |
| `src/check.mjs`, `src/why.mjs`, `src/measure.mjs` | `check`, the causes of `why`, the size of the tools |
| `src/lint.mjs`, `src/report.mjs` | the findings; the text, markdown and JSON reports |
| `src/toggle.mjs`, `src/jsonedit.mjs`, `src/write.mjs` | what `toggle` changes; editing JSON by its text; the only code that writes: backups, atomic writes, the lock, restore |
| `skills/check/`, `.claude-plugin/` | the user-only skill; the plugin manifest and icon |
| `test/*.test.mjs` | unit tests; `e2e-claude.test.mjs` runs against the real binary when `E2E_CLAUDE` is set |
| `test/fake-mcp-server.mjs` | a small MCP server (modes: ok, paged, banner, garbage, early-exit, sleep, slow, silent, init-error, big, ...) |
| `test/validation-table.mjs`, `test/lint-table.mjs` | the entries Claude Code skips, and the configurations that lint is held to |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged. Only `src/stdio.mjs` may start a process, only `src/http.mjs` may open a connection, and only `src/write.mjs` may write a file; a test fails otherwise.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, and the real-binary checks on Linux and macOS; a change that only works on one of them is not done.
3. **The binary is right.** The states, the winner of a name, the expansion and the lint say what Claude Code does because the real binary was put to it. When one is wrong, add the case to the table (`test/validation-table.mjs`, `test/lint-table.mjs`) or to `test/e2e-claude.test.mjs` with what `claude mcp list` and `claude mcp get` say, run `E2E_CLAUDE=... node --test test/e2e-claude.test.mjs`, fix the code, and say so in the README's "What was verified". Do not change an expectation to make a test pass without running it against the binary.
4. **Token cost is a feature.** The tool runs outside Claude; the one skill is user-only and its report is capped. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
5. **Settings files are the user's.** Whatever writes one backs it up first, next to it; changes only the list it is there for; leaves a file that is not valid JSON alone; offers `--dry-run`; and can be undone with `restore`.
6. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it, in the same command, whenever you run the tool, `claude` or anything else that reads them. `test/helpers.mjs` points every way the tool finds a config folder at a throwaway one the moment it loads. Every server a test starts is ended; a test that starts one checks that.
7. **Nothing secret in the output.** Environment values and header values are never printed; arguments and URLs go through `src/redact.mjs`. A new report needs a test that a secret in the configuration is not in it.
8. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## The real-binary checks

`test/e2e-claude.test.mjs` starts a fake Messages API on 127.0.0.1 and runs the real Claude Code binary against it, with a throwaway `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`. It puts the claims of the README to it: which definition wins, what `claude mcp list` and `get` say in each state, what the first request of a run carries, how `${VAR}` and a command are read, what `toggle` writes and that the binary honours it, and what `/mcp-check:check` hands the model. No model is reached and nothing leaves your machine. The binary is started asynchronously with its standard input ignored (a synchronous start blocks the fake server, and `-p` waits for input on an open stdin).

```bash
E2E_CLAUDE=/path/to/claude node --test test/e2e-claude.test.mjs
node test/everything.mjs run   # check against npx -y @modelcontextprotocol/server-everything (needs the network)
```

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Warn about a literal key in .mcp.json").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `src/version.mjs`, `package.json` and `.claude-plugin/plugin.json` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
