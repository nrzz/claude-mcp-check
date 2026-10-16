// The names Claude Code gives a server's tools: mcp__<server>__<tool>, where every character outside A-Z, a-z, 0-9, _ and -
// becomes _ (put to the binary: "my.server" and "my server" both became "my_server", "Ünï" became "_n_").

export const normalizeName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");
export const toolPrefix = (server) => `mcp__${normalizeName(server)}__`;
export const toolNameFor = (server, tool) => `${toolPrefix(server)}${normalizeName(tool)}`;

/** Claude Code leaves a tool out of a request when its full name is over this many characters (127 and 128 were sent, 129 was not). */
export const MAX_TOOL_NAME = 128;
