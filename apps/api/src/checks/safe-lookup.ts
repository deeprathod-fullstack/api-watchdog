import dns from 'node:dns/promises';
import net from 'node:net';

import { type AddressRejection, classifyAddress } from './ip-rules.js';

/**
 * The DNS boundary of the SSRF gate.
 *
 * This module exists to close one specific bug, so it is worth naming it
 * precisely. The obvious implementation of "check before you fetch" is:
 *
 *   resolve the hostname -> validate the addresses -> make the request
 *
 * That is a **time-of-check-to-time-of-use** flaw, and it is defeated by DNS
 * rebinding. The request performs its *own* resolution, and between our check
 * and the socket's lookup the answer can change: an attacker serves a record
 * with a one-second TTL that returns a public address to our validating
 * resolver and `169.254.169.254` to the connection. We validated one address
 * and connected to another.
 *
 * The fix here has two halves:
 *
 * 1. {@link resolveSafely} resolves **once** and validates every answer.
 * 2. {@link pinnedLookup} turns that validated set into the `lookup` hook that
 *    Node's `http.request`/`net.connect` will use — a hook that performs no
 *    resolution at all. It can only hand back the addresses we already
 *    approved.
 *
 * So there is exactly one resolution per check, and the socket is structurally
 * incapable of reaching an address that was not validated. Not "unlikely to" —
 * incapable, because the code path that could resolve again does not exist.
 *
 * Like the other check modules, nothing here reads configuration or
 * environment variables: there is no permissive mode to turn on.
 */

/** One address from a DNS answer, in the shape Node's lookup hook uses. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * How a hostname is resolved. Injected so tests can drive every DNS outcome —
 * multi-address answers, mixed families, failures, and a rebinding attacker —
 * without needing a network or a controlled zone.
 */
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeResolution =
  | { ok: true; addresses: readonly ResolvedAddress[] }
  | {
      ok: false;
      reason: 'dns';
    }
  | {
      ok: false;
      reason: 'blocked_address';
      /** Which rule rejected it, for the stored failure classifier. */
      detail: AddressRejection;
      /** The offending address, to make a blocked check diagnosable. */
      address: string;
    };

/**
 * The real resolver.
 *
 * `all: true` because a hostname with several addresses must be validated in
 * full — see {@link resolveSafely}. `verbatim: true` keeps the resolver's own
 * ordering instead of re-sorting IPv4 ahead of IPv6; we validate every answer
 * regardless, so reordering would only hide which address the system would
 * actually have preferred.
 */
export const systemResolver: DnsResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });

  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

/**
 * Resolve a hostname and approve it only if **every** address is contactable.
 *
 * An IP literal skips DNS entirely and is classified directly: there is nothing
 * to resolve, so there is no rebinding window for those targets at all.
 *
 * The all-or-nothing rule is the important part. A host answering with one
 * public and one private address is either misconfigured or attacking us, and
 * "just use the good one" leaves the attacker choosing which address we get on
 * the next check — plus we do not control which one the operating system's
 * Happy Eyeballs logic would pick. The cost is that a legitimate split-horizon
 * host with a private AAAA record cannot be monitored, which is the right trade
 * for a service that fetches URLs strangers supply.
 */
export async function resolveSafely(
  hostname: string,
  resolve: DnsResolver = systemResolver,
): Promise<SafeResolution> {
  const literalFamily = net.isIP(hostname);

  if (literalFamily !== 0) {
    const verdict = classifyAddress(hostname);

    if (!verdict.allowed) {
      return {
        ok: false,
        reason: 'blocked_address',
        detail: verdict.reason,
        address: hostname,
      };
    }

    return {
      ok: true,
      addresses: [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }],
    };
  }

  let answers: ResolvedAddress[];
  try {
    answers = await resolve(hostname);
  } catch {
    // NXDOMAIN, SERVFAIL, a timeout in the resolver — all the same to us: we
    // have no address, so there is nothing to contact. The reason a lookup
    // failed is not worth leaking back to the caller in more detail.
    return { ok: false, reason: 'dns' };
  }

  if (answers.length === 0) {
    return { ok: false, reason: 'dns' };
  }

  for (const answer of answers) {
    const verdict = classifyAddress(answer.address);

    if (!verdict.allowed) {
      return {
        ok: false,
        reason: 'blocked_address',
        detail: verdict.reason,
        address: answer.address,
      };
    }
  }

  return { ok: true, addresses: answers };
}

/**
 * The callback shape Node's `lookup` option is called with.
 *
 * Matched to Node's own signature deliberately, so the hook can be handed to
 * `http.request` with no cast. A type assertion here would be the wrong tool:
 * if our shape and Node's ever diverge, the hook silently errors at runtime
 * and the socket falls back to ordinary, unvalidated resolution.
 */
type LookupCallback = (
  error: Error | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

interface LookupOptions {
  /**
   * Node passes either the number 4/6 or the strings 'IPv4'/'IPv6' here, so
   * both spellings must be understood. Treating an unrecognised value as "no
   * filter" would hand back an address of the wrong family; treating a
   * *recognised* one as unrecognised would skip the filter entirely.
   */
  readonly family?: number | 'IPv4' | 'IPv6';
  readonly all?: boolean;
  readonly hints?: number;
}

/** A `lookup` function accepted by `http.request` / `net.connect`. */
export type LookupHook = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/**
 * A resolver-style failure.
 *
 * Node returns early when the error argument is set, so the address and family
 * it is handed are never read; they are present only to satisfy the callback's
 * signature.
 */
function lookupError(message: string): Error {
  const error: Error & { code?: string } = new Error(message);
  error.code = 'ENOTFOUND';
  return error;
}

/** Accept both spellings Node uses for an address family. */
function normaliseFamily(
  family: number | 'IPv4' | 'IPv6' | undefined,
): 4 | 6 | undefined {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return undefined;
}

/**
 * Build the `lookup` hook a socket will use, pinned to already-validated
 * addresses.
 *
 * This function performs no DNS. That is the whole point: handed to
 * `http.request({ lookup })`, it makes the socket's own resolution step a
 * lookup into a frozen list, so a DNS answer that changes between validation
 * and connection cannot affect where we connect.
 *
 * It honours Node's two calling conventions, because getting this wrong would
 * mean the hook silently fails and the socket falls back to normal resolution:
 * with `all: true` Node expects the whole array (that is the default when it
 * runs Happy Eyeballs), and otherwise a single address plus its family.
 */
export function pinnedLookup(
  addresses: readonly ResolvedAddress[],
): LookupHook {
  const pinned = [...addresses];

  return (_hostname, options, callback) => {
    // Everything below runs inside Node's `emitLookup`, on the socket's stack.
    // An exception thrown here does not fail the request — it escapes as an
    // uncaught exception and takes the process down (verified against Node
    // v24). Converting any unexpected throw into a lookup error keeps a
    // surprise here to one failed check instead of a downed API. It cannot
    // widen what we connect to: the only thing this hands back is an error.
    try {
      const family = normaliseFamily(options.family);
      const wanted =
        family === undefined
          ? pinned
          : pinned.filter((entry) => entry.family === family);

      const first = wanted[0];

      if (!first) {
        // No validated address of the family the socket asked for. Reported
        // the way a resolver reports "nothing to connect to", never by
        // widening the set we approved.
        //
        // This branch is load-bearing beyond correctness: handing Node an
        // empty array instead makes it throw inside `node:net` and crash the
        // process, which a target with an IPv6-only validated set could
        // otherwise trigger remotely.
        callback(
          lookupError('no validated address for the requested family'),
          '',
          0,
        );
        return;
      }

      if (options.all === true) {
        callback(null, wanted);
        return;
      }

      callback(null, first.address, first.family);
    } catch {
      // The original error is deliberately discarded rather than forwarded:
      // nothing about our internals belongs on a socket error a caller may
      // classify or store.
      callback(lookupError('pinned lookup failed'), '', 0);
    }
  };
}
