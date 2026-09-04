import net from 'node:net';

/**
 * Is this IP address one we are willing to send a request to?
 *
 * This module is the core of the SSRF defence, and it is deliberately a pure
 * function over a string: no DNS, no sockets, no configuration, no environment
 * variables. That is what makes it exhaustively testable, and it is why there
 * is no way — in any environment, by any flag — to make it permit a private
 * address. A bypass switch here would be one bad deploy away from a live SSRF,
 * so the switch does not exist.
 *
 * The policy is **default deny**. An address is allowed only if it falls in a
 * range we positively recognise as public unicast; anything unrecognised,
 * reserved, or unparseable is rejected. The alternative (deny a list of known
 * bad ranges, allow the rest) fails open on every range we forget, and there
 * are dozens.
 */

/** Why an address was rejected. Short, stable slugs, safe to store and log. */
export type AddressRejection =
  | 'not_an_ip_address'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'shared_address_space'
  | 'link_local'
  | 'unique_local'
  | 'multicast'
  | 'benchmarking'
  | 'documentation'
  | 'protocol_assignments'
  | 'reserved'
  | 'ipv4_compatible'
  | 'ipv4_mapped'
  | 'nat64'
  | 'discard_only'
  | 'six_to_four'
  | 'six_to_four_relay'
  | 'teredo'
  | 'orchid'
  | 'not_global_unicast';

export type AddressVerdict =
  | { allowed: true; family: 4 | 6 }
  | { allowed: false; reason: AddressRejection };

interface Range {
  /** Network address bytes: 4 for IPv4, 16 for IPv6. */
  readonly network: readonly number[];
  /** Prefix length in bits. */
  readonly prefix: number;
  readonly reason: AddressRejection;
}

/**
 * IPv4 ranges that are not public unicast (RFC 6890 and friends).
 *
 * Each one is a real SSRF target, not paranoia:
 * - `127/8` is our own process: the API itself, and in development PostgreSQL
 *   and Redis.
 * - `10/8`, `172.16/12`, `192.168/16` are the VPC — everything an attacker
 *   would like to port-scan.
 * - `169.254/16` is link-local, and contains `169.254.169.254`, the cloud
 *   instance metadata service. On IMDSv1 that endpoint hands out the
 *   instance's IAM credentials to anyone who asks. It is the single most
 *   valuable target on this list.
 * - `100.64/10` is carrier-grade NAT space, which is also where Alibaba Cloud
 *   puts its metadata service (`100.100.100.200`).
 * - `224/4` and `240/4` cover all multicast and reserved space up to
 *   `255.255.255.255`, so broadcast needs no special case.
 */
const IPV4_DENIED: readonly Range[] = [
  { network: [0, 0, 0, 0], prefix: 8, reason: 'unspecified' },
  { network: [10, 0, 0, 0], prefix: 8, reason: 'private' },
  { network: [100, 64, 0, 0], prefix: 10, reason: 'shared_address_space' },
  { network: [127, 0, 0, 0], prefix: 8, reason: 'loopback' },
  { network: [169, 254, 0, 0], prefix: 16, reason: 'link_local' },
  { network: [172, 16, 0, 0], prefix: 12, reason: 'private' },
  { network: [192, 0, 0, 0], prefix: 24, reason: 'protocol_assignments' },
  { network: [192, 0, 2, 0], prefix: 24, reason: 'documentation' },
  { network: [192, 88, 99, 0], prefix: 24, reason: 'six_to_four_relay' },
  { network: [192, 168, 0, 0], prefix: 16, reason: 'private' },
  { network: [198, 18, 0, 0], prefix: 15, reason: 'benchmarking' },
  { network: [198, 51, 100, 0], prefix: 24, reason: 'documentation' },
  { network: [203, 0, 113, 0], prefix: 24, reason: 'documentation' },
  { network: [224, 0, 0, 0], prefix: 4, reason: 'multicast' },
  { network: [240, 0, 0, 0], prefix: 4, reason: 'reserved' },
];

const hex = (...groups: number[]): number[] =>
  groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);

/**
 * IPv6 ranges denied even though some sit inside global unicast.
 *
 * The transition and translation prefixes matter more than they look: each one
 * embeds an IPv4 address inside an IPv6 address, so a validator that only
 * pattern-matches IPv6 text will happily allow `2002:7f00:0001::` (6to4 for
 * `127.0.0.1`) or `64:ff9b::a00:1` (NAT64 for `10.0.0.1`). Rather than decode
 * every embedding and re-run the IPv4 rules, we reject the prefixes outright —
 * they are deprecated or infrastructure-only, and nothing we are asked to
 * monitor should live behind one.
 */
const IPV6_DENIED: readonly Range[] = [
  { network: hex(0, 0, 0, 0, 0, 0, 0, 1), prefix: 128, reason: 'loopback' },
  { network: hex(0, 0, 0, 0, 0, 0, 0, 0), prefix: 128, reason: 'unspecified' },
  // ::/96 — deprecated "IPv4-compatible" addresses, another embedded-IPv4 form.
  {
    network: hex(0, 0, 0, 0, 0, 0, 0, 0),
    prefix: 96,
    reason: 'ipv4_compatible',
  },
  { network: hex(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), prefix: 96, reason: 'nat64' },
  { network: hex(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), prefix: 48, reason: 'nat64' },
  {
    network: hex(0x100, 0, 0, 0, 0, 0, 0, 0),
    prefix: 64,
    reason: 'discard_only',
  },
  { network: hex(0x2001, 0, 0, 0, 0, 0, 0, 0), prefix: 32, reason: 'teredo' },
  {
    network: hex(0x2001, 0x10, 0, 0, 0, 0, 0, 0),
    prefix: 28,
    reason: 'orchid',
  },
  {
    network: hex(0x2001, 0x20, 0, 0, 0, 0, 0, 0),
    prefix: 28,
    reason: 'orchid',
  },
  {
    network: hex(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0),
    prefix: 32,
    reason: 'documentation',
  },
  {
    network: hex(0x2002, 0, 0, 0, 0, 0, 0, 0),
    prefix: 16,
    reason: 'six_to_four',
  },
  {
    network: hex(0xfc00, 0, 0, 0, 0, 0, 0, 0),
    prefix: 7,
    reason: 'unique_local',
  },
  {
    network: hex(0xfe80, 0, 0, 0, 0, 0, 0, 0),
    prefix: 10,
    reason: 'link_local',
  },
  { network: hex(0xff00, 0, 0, 0, 0, 0, 0, 0), prefix: 8, reason: 'multicast' },
];

/**
 * Global unicast: the only IPv6 space we allow at all.
 *
 * `2000::/3` is what the IANA has actually delegated for public use. Requiring
 * membership here, rather than listing what to reject, is what makes the IPv6
 * policy default-deny: `fe80::`, `fc00::`, `ff02::`, `::1` and every
 * unallocated block fail by not being in it.
 */
const IPV6_GLOBAL_UNICAST: Range = {
  network: hex(0x2000, 0, 0, 0, 0, 0, 0, 0),
  prefix: 3,
  reason: 'not_global_unicast',
};

/** Does `bytes` fall inside the range? Compares whole bytes, then the remainder. */
function inRange(bytes: readonly number[], range: Range): boolean {
  const wholeBytes = Math.floor(range.prefix / 8);
  const remainingBits = range.prefix % 8;

  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== range.network[index]) return false;
  }

  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;

  return (
    ((bytes[wholeBytes] ?? 0) & mask) ===
    ((range.network[wholeBytes] ?? 0) & mask)
  );
}

/** Parse a canonical dotted-quad into four bytes. */
function parseIpv4(text: string): number[] | null {
  if (!net.isIPv4(text)) return null;

  return text.split('.').map(Number);
}

/**
 * Parse an IPv6 literal into sixteen bytes, including the `::ffff:1.2.3.4`
 * form, which carries an IPv4 address in its last four bytes.
 *
 * A zone index (`fe80::1%eth0`) is rejected rather than stripped: it only ever
 * refers to a link-local scope, which we deny anyway, and quietly discarding
 * part of an address is how parsers end up disagreeing with each other.
 */
function parseIpv6(text: string): number[] | null {
  if (!net.isIPv6(text) || text.includes('%')) return null;

  const doubleColon = text.indexOf('::');
  const [head, tail] =
    doubleColon === -1
      ? [text, '']
      : [text.slice(0, doubleColon), text.slice(doubleColon + 2)];

  const groups: number[] = [];

  /** Append one text segment, which may be a trailing IPv4 literal. */
  const pushSegments = (segment: string, into: number[]): boolean => {
    if (segment === '') return true;

    for (const part of segment.split(':')) {
      if (part.includes('.')) {
        const octets = parseIpv4(part);
        if (!octets) return false;
        into.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        into.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }

      into.push(Number.parseInt(part, 16));
    }

    return true;
  };

  const headGroups: number[] = [];
  const tailGroups: number[] = [];

  if (!pushSegments(head, headGroups)) return null;
  if (!pushSegments(tail, tailGroups)) return null;

  const zeros = 8 - headGroups.length - tailGroups.length;
  if (doubleColon === -1 ? zeros !== 0 : zeros < 0) return null;

  groups.push(...headGroups);
  for (let index = 0; index < zeros; index += 1) groups.push(0);
  groups.push(...tailGroups);

  if (groups.length !== 8) return null;

  return hex(...groups);
}

/** Is this the `::ffff:0:0/96` IPv4-mapped form? */
function mappedIpv4(bytes: readonly number[]): number[] | null {
  const prefix = bytes.slice(0, 12);
  const isMapped =
    prefix.slice(0, 10).every((byte) => byte === 0) &&
    prefix[10] === 0xff &&
    prefix[11] === 0xff;

  return isMapped ? bytes.slice(12, 16) : null;
}

function judgeIpv4(bytes: readonly number[]): AddressVerdict {
  for (const range of IPV4_DENIED) {
    if (inRange(bytes, range)) return { allowed: false, reason: range.reason };
  }

  return { allowed: true, family: 4 };
}

/**
 * Decide whether an IP address may be contacted.
 *
 * Accepts only canonical IPv4 and IPv6 literals. Anything else — a hostname,
 * an empty string, `127.1`, a bracketed address, whitespace — is
 * `not_an_ip_address`, which is a rejection: this function never guesses.
 * (Node's URL parser already normalises the decimal, octal and hex IPv4 forms
 * such as `2130706433` to dotted-quad before a URL's hostname reaches here.)
 */
export function classifyAddress(address: string): AddressVerdict {
  const ipv4 = parseIpv4(address);
  if (ipv4) return judgeIpv4(ipv4);

  const ipv6 = parseIpv6(address);
  if (!ipv6) return { allowed: false, reason: 'not_an_ip_address' };

  // An IPv4-mapped address is an IPv4 destination wearing an IPv6 coat: the
  // socket connects to the embedded IPv4 address, so the IPv4 rules are the
  // ones that matter. `::ffff:127.0.0.1` is the canonical bypass attempt.
  const mapped = mappedIpv4(ipv6);
  if (mapped) {
    const verdict = judgeIpv4(mapped);

    // A mapped address that would otherwise be allowed is still refused: we
    // have no reason to accept a public IPv4 host written in this form, and
    // accepting it would mean trusting two parsers to agree.
    return verdict.allowed
      ? { allowed: false, reason: 'ipv4_mapped' }
      : verdict;
  }

  for (const range of IPV6_DENIED) {
    if (inRange(ipv6, range)) return { allowed: false, reason: range.reason };
  }

  if (!inRange(ipv6, IPV6_GLOBAL_UNICAST)) {
    return { allowed: false, reason: 'not_global_unicast' };
  }

  return { allowed: true, family: 6 };
}

/** Convenience predicate for call sites that do not need the reason. */
export function isPubliclyRoutableAddress(address: string): boolean {
  return classifyAddress(address).allowed;
}
