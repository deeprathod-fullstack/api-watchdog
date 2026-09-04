import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type AddressRejection,
  classifyAddress,
  isPubliclyRoutableAddress,
} from '../src/checks/ip-rules.js';

/**
 * A rejection-only suite would pass with a function that rejects everything, so
 * the allow cases matter as much as the deny cases.
 */
const ALLOWED: readonly string[] = [
  // Public DNS resolvers and well-known public hosts.
  '1.1.1.1',
  '8.8.8.8',
  '9.9.9.9',
  '93.184.216.34',
  '208.67.222.222',
  // Boundaries just outside denied ranges.
  '9.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '128.0.0.0',
  '169.253.255.255',
  '169.255.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  // Global unicast IPv6.
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2000::',
  '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '2a00:1450:4001:81b::200e',
];

const DENIED: readonly [string, AddressRejection][] = [
  // Loopback: our own process, and in development PostgreSQL and Redis.
  ['127.0.0.1', 'loopback'],
  ['127.0.0.0', 'loopback'],
  ['127.1.2.3', 'loopback'],
  ['127.255.255.255', 'loopback'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback'],

  // Unspecified / this-network.
  ['0.0.0.0', 'unspecified'],
  ['0.255.255.255', 'unspecified'],
  ['::', 'unspecified'],

  // RFC1918: the VPC.
  ['10.0.0.0', 'private'],
  ['10.255.255.255', 'private'],
  ['172.16.0.0', 'private'],
  ['172.20.10.5', 'private'],
  ['172.31.255.255', 'private'],
  ['192.168.0.1', 'private'],
  ['192.168.255.255', 'private'],

  // Cloud instance metadata — the highest-value target of all.
  ['169.254.169.254', 'link_local'],
  ['169.254.0.0', 'link_local'],
  ['169.254.255.255', 'link_local'],

  // Carrier-grade NAT, which is also Alibaba Cloud's metadata service.
  ['100.64.0.0', 'shared_address_space'],
  ['100.100.100.200', 'shared_address_space'],
  ['100.127.255.255', 'shared_address_space'],

  // Reserved and special-purpose IPv4.
  ['192.0.0.1', 'protocol_assignments'],
  ['192.0.2.1', 'documentation'],
  ['198.51.100.1', 'documentation'],
  ['203.0.113.1', 'documentation'],
  ['192.88.99.1', 'six_to_four_relay'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['240.0.0.0', 'reserved'],
  ['255.255.255.255', 'reserved'],

  // IPv6 non-global scopes.
  ['fe80::1', 'link_local'],
  ['febf:ffff::1', 'link_local'],
  ['fc00::1', 'unique_local'],
  ['fd12:3456:789a::1', 'unique_local'],
  ['ff02::1', 'multicast'],
  ['ff05::1:3', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['2001:db8:dead:beef::1', 'documentation'],
  ['100::1', 'discard_only'],

  // Embedded-IPv4 forms: the bypasses a text-matching validator misses.
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:10.0.0.1', 'private'],
  ['::ffff:169.254.169.254', 'link_local'],
  ['::ffff:192.168.1.1', 'private'],
  ['::ffff:8.8.8.8', 'ipv4_mapped'],
  // The mapped prefix carrying 0.0.0.0, so the IPv4 rules name the reason.
  ['::ffff:0:0', 'unspecified'],
  ['::127.0.0.1', 'ipv4_compatible'],
  ['::10.0.0.1', 'ipv4_compatible'],
  ['64:ff9b::7f00:1', 'nat64'],
  ['64:ff9b::a00:1', 'nat64'],
  ['64:ff9b::808:808', 'nat64'],
  ['64:ff9b:1::1', 'nat64'],
  ['2002:7f00:1::1', 'six_to_four'],
  ['2002:a00:1::1', 'six_to_four'],
  ['2001::1', 'teredo'],
  ['2001:0:53aa:64c:1c9:e2f6:7f00:1', 'teredo'],
  ['2001:10::1', 'orchid'],
  ['2001:20::1', 'orchid'],

  // Outside global unicast entirely.
  ['4000::1', 'not_global_unicast'],
  ['8000::1', 'not_global_unicast'],
  ['1000::1', 'not_global_unicast'],
];

/** Never parsed, never guessed at — anything unparseable is a rejection. */
const NOT_ADDRESSES: readonly string[] = [
  '',
  ' ',
  'localhost',
  'localhost.',
  'example.com',
  '127.0.0.1.nip.io',
  // Shorthand and numeric IPv4 forms. Node's URL parser normalises these to
  // dotted-quad before a hostname reaches this module; passed in raw they are
  // not addresses, and the default-deny answer is the safe one either way.
  '127.1',
  '2130706433',
  '0x7f000001',
  '017700000001',
  '10.0.1',
  // Malformed.
  '1.2.3.4.5',
  '256.1.1.1',
  '1.2.3',
  '-1.0.0.0',
  '1.2.3.4:80',
  '[::1]',
  ' 127.0.0.1',
  '127.0.0.1 ',
  '127.0.0.1\n',
  '::ffff:127.0.0.1%eth0',
  'fe80::1%eth0',
  '::g',
  '12345::1',
  '1:2:3:4:5:6:7:8:9',
  '::1::2',
];

describe('classifyAddress — allowed', () => {
  it.each(ALLOWED)('allows the public address %s', (address) => {
    expect(classifyAddress(address)).toEqual({
      allowed: true,
      family: address.includes(':') ? 6 : 4,
    });
  });
});

describe('classifyAddress — denied', () => {
  it.each(DENIED)('rejects %s as %s', (address, reason) => {
    expect(classifyAddress(address)).toEqual({ allowed: false, reason });
  });
});

describe('classifyAddress — not addresses', () => {
  it.each(NOT_ADDRESSES)('refuses to interpret %j', (value) => {
    expect(classifyAddress(value)).toEqual({
      allowed: false,
      reason: 'not_an_ip_address',
    });
  });
});

describe('policy shape', () => {
  it('agrees with the convenience predicate', () => {
    for (const address of ALLOWED) {
      expect(isPubliclyRoutableAddress(address)).toBe(true);
    }
    for (const [address] of DENIED) {
      expect(isPubliclyRoutableAddress(address)).toBe(false);
    }
  });

  it('is default deny across the whole IPv4 space', () => {
    // Every first octet that is not covered by an allowed range must be
    // rejected, so a range we forgot to deny cannot silently become reachable.
    const deniedFirstOctets = [0, 10, 127, 224, 239, 240, 255];

    for (const octet of deniedFirstOctets) {
      expect(isPubliclyRoutableAddress(`${String(octet)}.1.1.1`)).toBe(false);
    }
  });

  it('reads no configuration of any kind', () => {
    // The guarantee is structural: with no `process.env` access there is no
    // flag, in any environment, that can make this module permit a private
    // address. A test rather than a comment, because this is the property that
    // stops a bad deploy from becoming a live SSRF.
    const source = readFileSync(
      new URL('../src/checks/ip-rules.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('process.env');
    expect(source).not.toContain('loadConfig');
  });
});
