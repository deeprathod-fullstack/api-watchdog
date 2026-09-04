import net from 'node:net';

import { type AddressRejection, classifyAddress } from './ip-rules.js';

/**
 * The static half of the SSRF gate: everything that can be decided about a URL
 * without touching the network.
 *
 * Pure, like {@link classifyAddress}, and for the same reason — this is
 * security logic, so it must be testable exhaustively and must have no
 * configuration path that could loosen it.
 *
 * What this module deliberately does **not** do is judge hostnames. There is no
 * "localhost" blocklist, because name-based filtering is trivially defeated:
 * `localhost.` (trailing dot), `127.0.0.1.nip.io`, or an attacker's own domain
 * with an A record pointing at `10.0.0.5` all get past it. A hostname is only
 * safe or unsafe once resolved, which happens in the DNS stage. What this
 * module does judge is the URL's *structure*, plus any address written directly
 * into it.
 */

/** Mirrors the `monitors.url` column's CHECK, so both agree on the ceiling. */
const MAX_URL_LENGTH = 2048;

/**
 * The scheme allowlist, and the only port each scheme may use.
 *
 * One port per scheme rather than a shared allowlist of both: `https://x:80`
 * and `http://x:443` are legal URLs but never legitimate monitoring targets,
 * and allowing a scheme/port mismatch widens the reachable surface for nothing.
 * A narrower rule is a smaller thing to reason about.
 */
const SCHEME_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

export type UrlRejection =
  | 'too_long'
  | 'unparseable'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'no_hostname'
  | 'address_not_allowed';

/** A URL that passed every static check. */
export interface GuardedUrl {
  /**
   * The URL to request.
   *
   * Scheme and hostname are lower-cased by the URL parser, which is correct —
   * both are case-insensitive. The path and query keep their casing exactly:
   * they are case-*sensitive*, and monitoring `/Status?Check=1` as
   * `/status?check=1` would be monitoring a different endpoint than the user
   * asked for.
   */
  readonly url: string;
  /** Hostname with any IPv6 brackets removed, ready for DNS or address rules. */
  readonly hostname: string;
  /** The effective port, with the scheme default filled in. */
  readonly port: number;
  /**
   * True when the hostname was an IP literal, which means it has already been
   * validated here and the DNS stage has nothing to resolve. No lookup means
   * no rebinding window.
   */
  readonly isIpLiteral: boolean;
}

export type UrlGuardResult =
  | { ok: true; target: GuardedUrl }
  | { ok: false; reason: UrlRejection; detail?: AddressRejection };

/** Strip the brackets the URL parser keeps around an IPv6 hostname. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Apply every network-free check to a URL.
 *
 * Order matters only for the quality of the error: each check is independent,
 * and the cheapest run first so a hostile input is discarded before it reaches
 * the parser.
 */
export function guardUrl(rawUrl: string): UrlGuardResult {
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  // An allowlist, never a denylist. `file:`, `gopher:`, `data:`, `ftp:` and
  // every scheme nobody has thought of yet all fail by not being on it.
  const schemePort = SCHEME_PORTS[parsed.protocol];
  if (schemePort === undefined) {
    return { ok: false, reason: 'scheme_not_allowed' };
  }

  // `http://user:pw@host/` would send someone's credentials to the target and
  // is also a parser-confusion trick: some parsers read the host as `user`.
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }

  if (parsed.hostname === '') {
    return { ok: false, reason: 'no_hostname' };
  }

  // The parser drops a port equal to the scheme default, so an empty string
  // means "the default", not "no port".
  const port = parsed.port === '' ? schemePort : Number(parsed.port);

  // Defence in depth rather than the main control: the address rules already
  // keep us out of private space, so an arbitrary port could only reach a
  // *public* host. Restricting it anyway removes "use this service to scan
  // port 22, 6379 or 9200 on someone else's public box" — and requiring the
  // scheme's own port also rejects `https://x:80` and `http://x:443`.
  if (port !== schemePort) {
    return { ok: false, reason: 'port_not_allowed' };
  }

  const hostname = unbracket(parsed.hostname);
  const isIpLiteral = net.isIP(hostname) !== 0;

  if (isIpLiteral) {
    const verdict = classifyAddress(hostname);

    if (!verdict.allowed) {
      return {
        ok: false,
        reason: 'address_not_allowed',
        detail: verdict.reason,
      };
    }
  }

  return {
    ok: true,
    target: { url: parsed.href, hostname, port, isIpLiteral },
  };
}
