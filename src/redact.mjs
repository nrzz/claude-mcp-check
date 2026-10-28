// Nothing this tool prints may be a secret. Environment values and header values are never printed at all (only their names).
// Arguments and URLs are printed as they are configured, except what looks like a credential: the value of a flag or a
// KEY=value whose name says token, key, secret, password or auth; the password of a URL; a query value of such a name; and
// text of the shape of an API key. A ${VAR} reference is a name and is shown (its default, which may be a literal, is not).

export const SECRET_NAME = /(token|secret|passw(or)?d|passwd|pwd|credential|bearer|cookie|authorization|auth(?![a-z])|key$|sig(nature)?$)/i;
export const KEY_SHAPE = /^(sk-[A-Za-z0-9_-]{16,}|sk_(live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*|glpat-[\w-]{15,}|npm_[A-Za-z0-9]{30,})$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
export const MASK = "***";

/** ${NAME:-default} becomes ${NAME:-…}: the name of a variable is not a secret, a default may be. */
export function hideDefaults(text) {
  return String(text).replace(REFERENCE, (m, name, dflt) => (dflt ? `\${${name}:-…}` : m));
}

const isReference = (v) => /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(v);

/**
 * Says whether a (name, value) pair looks like a credential. A ${VAR} reference (with or without a default) is never a credential,
 * and neither is a Bearer or Basic in front of one: what is judged is the literal text that is left when the references are taken
 * out, so that `abc123secret${X}` is hidden and flagged (its literal part is a secret) and `Bearer ${TOKEN}` is not.
 */
export function looksLikeCredential(name, value) {
  if (value === undefined || value === null) return false;
  const literal = String(value).replace(REFERENCE, "").replace(/^\s*(Bearer|Basic)\s*/i, "").trim();
  if (literal === "") return false;
  if (name && SECRET_NAME.test(String(name))) return true;
  return KEY_SHAPE.test(literal);
}

/** A URL with the password, the user name of a "user:password@" part and the secret-looking query values masked. */
export function redactUrl(text) {
  let out = String(text);
  // user:password@host
  out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s?#]*)@/i, (m, scheme, userinfo) => (userinfo.includes(":") ? `${scheme}${userinfo.split(":")[0]}:${looksLikeCredential("password", userinfo.slice(userinfo.indexOf(":") + 1)) ? MASK : hideDefaults(userinfo.slice(userinfo.indexOf(":") + 1))}@` : `${scheme}${isReference(userinfo) ? userinfo : MASK}@`));
  // ?a=b&token=c
  out = out.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, key, value) => (looksLikeCredential(key, value) ? `${sep}${key}=${MASK}` : `${sep}${key}=${hideDefaults(value)}`));
  return hideDefaults(out);
}

/** The arguments of a command with credentials masked. */
export function redactArgs(args) {
  const out = [];
  let hideNext = false;
  let prevFlag = null;
  for (const raw of args || []) {
    const a = String(raw);
    if (hideNext && !a.startsWith("-")) {
      out.push(looksLikeCredential(prevFlag, a) ? MASK : hideDefaults(a));
      hideNext = false;
      prevFlag = null;
      continue;
    }
    hideNext = false;
    prevFlag = null;
    const flag = /^(--?[A-Za-z0-9_.-]+)=(.*)$/s.exec(a);
    if (flag && looksLikeCredential(flag[1], flag[2])) { out.push(`${flag[1]}=${MASK}`); continue; }
    const pair = /^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/s.exec(a);
    if (pair && looksLikeCredential(pair[1], pair[2])) { out.push(`${pair[1]}=${MASK}`); continue; }
    if (/^--?[A-Za-z0-9_.-]+$/.test(a) && SECRET_NAME.test(a)) { out.push(a); hideNext = true; prevFlag = a; continue; }
    if (looksLikeCredential(null, a)) { out.push(MASK); continue; }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) { out.push(redactUrl(a)); continue; }
    out.push(hideDefaults(a));
  }
  return out;
}

/** The command: the first word as written, the rest of a command line (when the command holds spaces) as arguments. */
export function redactCommand(command) {
  const s = String(command);
  if (!/\s/.test(s)) return hideDefaults(s);
  const parts = s.match(/"[^"]*"|\S+/g) || [s];
  return [hideDefaults(parts[0]), ...redactArgs(parts.slice(1))].join(" ");
}

/** Free text (the end of a stderr, a message) with the things that look like credentials masked. */
export function redactText(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,})\b/g, MASK)
    .replace(/((?:token|secret|password|passwd|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\*\*\*)([^\s"',;]{6,})/gi, `$1${MASK}`);
}
