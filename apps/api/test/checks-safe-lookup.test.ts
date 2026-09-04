import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  type DnsResolver,
  pinnedLookup,
  resolveSafely,
  type ResolvedAddress,
  systemResolver,
} from '../src/checks/safe-lookup.js';

/** A resolver that always answers with the given addresses. */
function answering(...addresses: ResolvedAddress[]): DnsResolver {
  return vi.fn(() => Promise.resolve(addresses));
}

/** A resolver that fails, the way NXDOMAIN or SERVFAIL arrives. */
function failing(code: string): DnsResolver {
  return vi.fn(() => {
    const error: Error & { code?: string } = new Error(`getaddrinfo ${code}`);
    error.code = code;
    return Promise.reject(error);
  });
}

const PUBLIC_V4: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PUBLIC_V4_ALT: ResolvedAddress = { address: '1.1.1.1', family: 4 };
const PUBLIC_V6: ResolvedAddress = {
  address: '2606:4700:4700::1111',
  family: 6,
};
const METADATA: ResolvedAddress = { address: '169.254.169.254', family: 4 };
const LOOPBACK_V6: ResolvedAddress = { address: '::1', family: 6 };
const PRIVATE_V4: ResolvedAddress = { address: '10.0.0.5', family: 4 };

describe('resolveSafely — allowed answers', () => {
  it('allows a single public IPv4 answer', async () => {
    const result = await resolveSafely('example.com', answering(PUBLIC_V4));

    expect(result).toEqual({ ok: true, addresses: [PUBLIC_V4] });
  });

  it('allows a single public IPv6 answer', async () => {
    const result = await resolveSafely('example.com', answering(PUBLIC_V6));

    expect(result).toEqual({ ok: true, addresses: [PUBLIC_V6] });
  });

  it('allows several public addresses', async () => {
    const result = await resolveSafely(
      'example.com',
      answering(PUBLIC_V4, PUBLIC_V4_ALT),
    );

    expect(result).toEqual({
      ok: true,
      addresses: [PUBLIC_V4, PUBLIC_V4_ALT],
    });
  });

  it('allows A and AAAA answers together, in resolver order', async () => {
    // `verbatim: true` means we keep the resolver's ordering rather than
    // re-sorting families, so the pinned set reflects what the system would
    // actually have preferred.
    const result = await resolveSafely(
      'example.com',
      answering(PUBLIC_V6, PUBLIC_V4),
    );

    expect(result).toEqual({ ok: true, addresses: [PUBLIC_V6, PUBLIC_V4] });
  });
});

describe('resolveSafely — all-or-nothing rejection', () => {
  it('rejects the whole lookup when one answer of many is disallowed', async () => {
    // The headline rule: no cherry-picking the good address. A host answering
    // with both is either misconfigured or attacking us, and we do not control
    // which address the OS would pick.
    const result = await resolveSafely(
      'evil.example',
      answering(PUBLIC_V4, METADATA),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked_address',
      detail: 'link_local',
      address: '169.254.169.254',
    });
  });

  it('rejects when the disallowed answer comes first', async () => {
    const result = await resolveSafely(
      'evil.example',
      answering(METADATA, PUBLIC_V4),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked_address',
      detail: 'link_local',
      address: '169.254.169.254',
    });
  });

  it('rejects a mixed-family answer where only the AAAA is internal', async () => {
    // Resolving IPv4 only would have missed this entirely — the reason the
    // resolver is asked for every family.
    const result = await resolveSafely(
      'split-horizon.example',
      answering(PUBLIC_V4, LOOPBACK_V6),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked_address',
      detail: 'loopback',
      address: '::1',
    });
  });

  it('rejects when every answer is disallowed', async () => {
    const result = await resolveSafely(
      'internal.example',
      answering(PRIVATE_V4, METADATA, LOOPBACK_V6),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked_address',
      detail: 'private',
      address: '10.0.0.5',
    });
  });

  it('rejects a hostname that resolves to loopback however it is spelled', async () => {
    // The case name filtering cannot catch: a public hostname whose A record
    // simply points inside. This is why there is no "localhost" blocklist.
    const result = await resolveSafely(
      '127.0.0.1.nip.io',
      answering({ address: '127.0.0.1', family: 4 }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked_address',
      detail: 'loopback',
      address: '127.0.0.1',
    });
  });
});

describe('resolveSafely — resolution failures', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'SERVFAIL', 'ETIMEDOUT'])(
    'reports %s as a dns failure',
    async (code) => {
      const result = await resolveSafely('nope.example', failing(code));

      expect(result).toEqual({ ok: false, reason: 'dns' });
    },
  );

  it('treats an empty answer as a dns failure', async () => {
    const result = await resolveSafely('empty.example', answering());

    expect(result).toEqual({ ok: false, reason: 'dns' });
  });
});

describe('resolveSafely — IP literals bypass DNS', () => {
  it('classifies a public literal without resolving', async () => {
    const resolve = answering(METADATA);

    const result = await resolveSafely('93.184.216.34', resolve);

    expect(result).toEqual({ ok: true, addresses: [PUBLIC_V4] });
    // No lookup happened, so there is no rebinding window for a literal at all.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('classifies a public IPv6 literal without resolving', async () => {
    const resolve = answering(METADATA);

    const result = await resolveSafely('2606:4700:4700::1111', resolve);

    expect(result).toEqual({ ok: true, addresses: [PUBLIC_V6] });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.5',
    '::1',
    '::ffff:10.0.0.1',
  ])('rejects the disallowed literal %s without resolving', async (literal) => {
    const resolve = answering(PUBLIC_V4);

    const result = await resolveSafely(literal, resolve);

    expect(result.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('pinnedLookup — the socket cannot resolve again', () => {
  /** Invoke the hook the way Node does, and capture the callback arguments. */
  function invoke(
    hook: ReturnType<typeof pinnedLookup>,
    options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean },
  ) {
    return new Promise<{
      error: Error | null;
      value?: string | readonly { address: string; family: number }[];
      family?: number;
    }>((resolve) => {
      hook('example.com', options, (error, value, family) => {
        resolve({ error, value, family });
      });
    });
  }

  it('simulates a DNS rebinding attack and connects to the validated address', async () => {
    // The attacker's zone answers with a public address the first time and the
    // metadata service every time after — a one-second TTL record.
    let call = 0;
    const rebinding: DnsResolver = vi.fn(() => {
      call += 1;
      return Promise.resolve(call === 1 ? [PUBLIC_V4] : [METADATA]);
    });

    const resolution = await resolveSafely('rebind.example', rebinding);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // This is what the HTTP client will hand to `http.request({ lookup })`.
    const hook = pinnedLookup(resolution.addresses);

    // The socket "resolves" — several times, as a retry or Happy Eyeballs
    // would. Every answer is the address we validated, never the rebound one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const all = await invoke(hook, { all: true });
      expect(all.value).toEqual([PUBLIC_V4]);

      const single = await invoke(hook, {});
      expect(single.value).toBe('93.184.216.34');
      expect(single.family).toBe(4);
    }

    // And the decisive assertion: the resolver was consulted exactly once, so
    // the attacker's second answer was never asked for, let alone used.
    expect(rebinding).toHaveBeenCalledTimes(1);
    expect(call).toBe(1);
  });

  it('returns the whole set when Node asks for all addresses', async () => {
    const hook = pinnedLookup([PUBLIC_V6, PUBLIC_V4]);

    const result = await invoke(hook, { all: true });

    expect(result.error).toBeNull();
    expect(result.value).toEqual([PUBLIC_V6, PUBLIC_V4]);
  });

  it('returns one address and its family when Node asks for a single answer', async () => {
    const hook = pinnedLookup([PUBLIC_V6, PUBLIC_V4]);

    const result = await invoke(hook, {});

    expect(result.value).toBe('2606:4700:4700::1111');
    expect(result.family).toBe(6);
  });

  it('honours a family filter without widening the approved set', async () => {
    const hook = pinnedLookup([PUBLIC_V6, PUBLIC_V4]);

    expect((await invoke(hook, { family: 4, all: true })).value).toEqual([
      PUBLIC_V4,
    ]);
    expect((await invoke(hook, { family: 6, all: true })).value).toEqual([
      PUBLIC_V6,
    ]);
  });

  it('understands both spellings Node uses for a family', async () => {
    // Node passes 4/6 or 'IPv4'/'IPv6' depending on the call site. Ignoring the
    // string form would return an address of the wrong family to the socket.
    const hook = pinnedLookup([PUBLIC_V6, PUBLIC_V4]);

    expect((await invoke(hook, { family: 'IPv4', all: true })).value).toEqual([
      PUBLIC_V4,
    ]);
    expect((await invoke(hook, { family: 'IPv6', all: true })).value).toEqual([
      PUBLIC_V6,
    ]);
    expect((await invoke(hook, { family: 'IPv4' })).value).toBe(
      '93.184.216.34',
    );
  });

  it('fails rather than inventing an address when no family matches', async () => {
    const hook = pinnedLookup([PUBLIC_V4]);

    const result = await invoke(hook, { family: 6 });

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error & { code?: string }).code).toBe('ENOTFOUND');
    // No address is offered alongside the error, so nothing outside the
    // approved set can be picked up by a caller that ignores it.
    expect(result.value).toBe('');
  });

  it('converts an unexpected exception into a lookup error', async () => {
    // An exception thrown inside the hook escapes on the socket's stack and
    // crashes the process rather than failing the request, so the hook must
    // never let one out. A frozen array whose `filter` throws stands in for
    // any unforeseen internal fault.
    // The element's `family` getter throws when the family filter reads it,
    // which happens inside the hook rather than at construction.
    const poisoned = [
      {
        address: '93.184.216.34',
        get family(): 4 {
          throw new Error('unexpected internal fault');
        },
      },
    ] as unknown as ResolvedAddress[];

    const hookOverPoisoned = pinnedLookup(poisoned);

    // A healthy hook is unaffected...
    expect(
      (await invoke(pinnedLookup([PUBLIC_V4]), { all: true })).value,
    ).toEqual([PUBLIC_V4]);

    // ...and the faulty one reports an error instead of throwing.
    const result = await invoke(hookOverPoisoned, { family: 4, all: true });

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error & { code?: string }).code).toBe('ENOTFOUND');
    // The internal message is not forwarded onto the socket error.
    expect(result.error?.message).not.toContain('unexpected internal fault');
  });

  it('ignores the hostname it is given', async () => {
    // The hook is pinned to addresses, not to a name, so a redirect or a Host
    // header cannot steer it somewhere else.
    const hook = pinnedLookup([PUBLIC_V4]);

    const result = await new Promise<string | undefined>((resolve) => {
      hook('attacker.example', {}, (_error, value) => {
        resolve(typeof value === 'string' ? value : undefined);
      });
    });

    expect(result).toBe('93.184.216.34');
  });

  it('is unaffected by later mutation of the caller array', async () => {
    const addresses: ResolvedAddress[] = [PUBLIC_V4];
    const hook = pinnedLookup(addresses);

    addresses.push(METADATA);

    expect((await invoke(hook, { all: true })).value).toEqual([PUBLIC_V4]);
  });
});

describe('systemResolver against the real resolver', () => {
  it('resolves localhost and the policy rejects it', async () => {
    // The one test that exercises the real `dns.lookup`. It needs no network —
    // localhost comes from the hosts file — and it proves the whole boundary
    // works end to end: real resolution, real classification, refusal.
    const result = await resolveSafely('localhost', systemResolver);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('blocked_address');
    if (result.reason !== 'blocked_address') return;
    expect(['loopback', 'ipv4_mapped']).toContain(result.detail);
  });

  it('reports a hostname that cannot resolve as a dns failure', async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it can never resolve.
    const result = await resolveSafely(
      'this-host-does-not-exist.invalid',
      systemResolver,
    );

    expect(result).toEqual({ ok: false, reason: 'dns' });
  });
});

describe('module scope', () => {
  const source = readFileSync(
    new URL('../src/checks/safe-lookup.ts', import.meta.url),
    'utf8',
  );

  it('reads no configuration of any kind', () => {
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('loadConfig');
  });

  it('introduces no HTTP client, persistence, or route code', () => {
    // Phase B is the DNS boundary only. DNS is the one network module this
    // file may import; anything that could make a request or write a row
    // belongs to a later phase and a separate review.
    for (const forbidden of [
      'node:http',
      'node:https',
      'fetch(',
      'express',
      'pg',
      'INSERT',
      'check_results',
      'Router',
    ]) {
      expect(source).not.toContain(forbidden);
    }

    expect(source).toContain("from 'node:dns/promises'");
  });
});
