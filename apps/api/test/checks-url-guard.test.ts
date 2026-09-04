import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { guardUrl, type UrlRejection } from '../src/checks/url-guard.js';

/** Assert a URL passes and return the guarded target. */
function guarded(url: string) {
  const result = guardUrl(url);

  if (!result.ok) {
    throw new Error(`expected ${url} to pass, got ${result.reason}`);
  }

  return result.target;
}

function rejection(url: string): UrlRejection {
  const result = guardUrl(url);

  if (result.ok) throw new Error(`expected ${url} to be rejected`);

  return result.reason;
}

describe('accepted URLs', () => {
  it.each([
    'http://example.com',
    'https://example.com',
    'https://example.com/',
    // An explicit port is fine when it is the scheme's own port.
    'https://example.com:443/',
    'http://example.com:80/',
    'https://sub.domain.example.co.uk/health',
    'https://example.com/path?query=1#fragment',
    // A hostname with no dot is fine: whether it is reachable is the address
    // rules' business, not a name-shape question.
    'https://intranet/health',
    // Public IP literals are legitimate monitoring targets.
    'https://1.1.1.1/',
    'http://93.184.216.34/status',
    'https://[2606:4700:4700::1111]/',
  ])('accepts %s', (url) => {
    expect(guardUrl(url).ok).toBe(true);
  });

  it('preserves path and query casing exactly', () => {
    const target = guarded('https://Example.COM/Status/Path?Check=TRUE&x=Y');

    // Scheme and host are case-insensitive, so lower-casing them is correct.
    expect(target.url).toBe('https://example.com/Status/Path?Check=TRUE&x=Y');
    expect(target.hostname).toBe('example.com');
  });

  it('does not alter percent-encoding or a trailing slash-less path', () => {
    expect(guarded('https://example.com/a%2Fb/C').url).toBe(
      'https://example.com/a%2Fb/C',
    );
  });

  it('reports the effective port, filling in the scheme default', () => {
    expect(guarded('http://example.com/').port).toBe(80);
    expect(guarded('https://example.com/').port).toBe(443);
    expect(guarded('http://example.com:80/').port).toBe(80);
    expect(guarded('https://example.com:443/').port).toBe(443);
  });

  it('flags IP literals so the DNS stage can skip resolution', () => {
    // No lookup means no rebinding window at all for these.
    expect(guarded('https://1.1.1.1/').isIpLiteral).toBe(true);
    expect(guarded('https://[2606:4700:4700::1111]/').isIpLiteral).toBe(true);
    expect(guarded('https://example.com/').isIpLiteral).toBe(false);
  });

  it('unwraps IPv6 brackets for the address and DNS stages', () => {
    expect(guarded('https://[2606:4700:4700::1111]/').hostname).toBe(
      '2606:4700:4700::1111',
    );
  });
});

describe('scheme allowlist', () => {
  it.each([
    'file:///etc/passwd',
    'file://localhost/etc/shadow',
    'ftp://example.com/x',
    'gopher://example.com:70/x',
    'data:text/plain;base64,aGk=',
    'dict://example.com:2628/x',
    'ldap://example.com/x',
    'tftp://example.com/x',
    'jar:http://example.com!/',
    'blob:https://example.com/uuid',
    'ws://example.com/',
    'wss://example.com/',
    'redis://example.com:6379',
    'ssh://example.com',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    'HTTPX://example.com',
  ])('rejects the scheme in %s', (url) => {
    expect(rejection(url)).toBe('scheme_not_allowed');
  });

  it('accepts an uppercase http scheme, which is case-insensitive', () => {
    expect(guarded('HTTPS://example.com/Path').url).toBe(
      'https://example.com/Path',
    );
  });
});

describe('embedded credentials', () => {
  it.each([
    'http://user:password@example.com/',
    'http://user@example.com/',
    'https://:password@example.com/',
    // The classic parser-confusion payload: some parsers read the host as
    // `expected-host` and connect to the attacker's instead.
    'http://expected-host@1.1.1.1/',
  ])('rejects %s', (url) => {
    expect(rejection(url)).toBe('credentials_in_url');
  });
});

describe('port allowlist', () => {
  it.each([
    'http://example.com:22/',
    'http://example.com:25/',
    'http://example.com:3000/',
    'http://example.com:5432/',
    'http://example.com:6379/',
    'http://example.com:8080/',
    'http://example.com:9200/',
    'http://example.com:11211/',
    'https://1.1.1.1:8443/',
    'http://example.com:1/',
    'http://example.com:65535/',
  ])('rejects %s', (url) => {
    expect(rejection(url)).toBe('port_not_allowed');
  });

  it('requires each scheme to use its own port', () => {
    // Both are legal URLs and neither is ever a legitimate monitoring target,
    // so a scheme/port mismatch is refused rather than tolerated.
    expect(rejection('http://example.com:443')).toBe('port_not_allowed');
    expect(rejection('https://example.com:80')).toBe('port_not_allowed');
  });

  it('rejects a mismatched port on an IP literal too', () => {
    // The port rule runs before the address rules, so this holds even for a
    // literal that would otherwise be allowed.
    expect(rejection('http://1.1.1.1:443/')).toBe('port_not_allowed');
    expect(rejection('https://1.1.1.1:80/')).toBe('port_not_allowed');
  });
});

describe('IP literals are judged without DNS', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.0.0.1:80/admin',
    'https://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    // Instance metadata, the target that turns SSRF into a full compromise.
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://100.100.100.200/latest/meta-data/',
    'http://0.0.0.0/',
    'http://255.255.255.255/',
    'http://224.0.0.1/',
    // Obfuscated IPv4 forms. The URL parser normalises each of these to
    // 127.0.0.1, and the address rules then reject it.
    'http://2130706433/',
    'http://017700000001/',
    'http://0x7f000001/',
    'http://127.1/',
    'http://127.0.1/',
    // IPv6 loopback and non-global scopes.
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[ff02::1]/',
    'http://[2001:db8::1]/',
    // Embedded IPv4 inside IPv6.
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::1]/',
  ])('rejects %s', (url) => {
    expect(rejection(url)).toBe('address_not_allowed');
  });

  it('reports which address rule rejected the literal', () => {
    const result = guardUrl('http://169.254.169.254/latest/meta-data/');

    expect(result).toEqual({
      ok: false,
      reason: 'address_not_allowed',
      detail: 'link_local',
    });
  });

  it('does not reject hostnames that merely look internal', () => {
    // These are name-shaped, so the guard passes them on; whether they are
    // reachable is decided by the resolved address, which is the only check
    // that a trailing dot or a wildcard DNS service cannot dodge.
    for (const url of [
      'http://localhost/',
      'http://localhost./',
      'http://127.0.0.1.nip.io/',
      'http://metadata.google.internal/',
    ]) {
      const result = guardUrl(url);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.target.isIpLiteral).toBe(false);
    }
  });
});

describe('malformed input', () => {
  it.each([
    'not a url',
    '',
    '//example.com/',
    '/relative/path',
    'http://',
    'example.com',
  ])('rejects %j as unparseable or hostless', (url) => {
    expect(['unparseable', 'no_hostname']).toContain(rejection(url));
  });

  it('treats http:///path the way the URL parser does', () => {
    // Worth pinning: the WHATWG parser reads the first path segment of a
    // three-slash URL as the *hostname*, so this is `http://path/` — a
    // name-shaped host, not a hostless URL. It passes the static guard and is
    // then decided by whatever `path` resolves to, which is the correct
    // outcome; asserting it here means a future parser change cannot alter
    // the behaviour silently.
    const result = guardUrl('http:///path');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.hostname).toBe('path');
      expect(result.target.isIpLiteral).toBe(false);
    }
  });

  it('rejects a URL longer than the column allows', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;

    expect(rejection(long)).toBe('too_long');
  });
});

describe('policy shape', () => {
  it('reads no configuration of any kind', () => {
    const source = readFileSync(
      new URL('../src/checks/url-guard.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('process.env');
    expect(source).not.toContain('loadConfig');
  });

  it('makes no network call', () => {
    // Purity is the property under test: no DNS, no sockets, so nothing here
    // can be slow, flaky, or dependent on where the tests run.
    const source = readFileSync(
      new URL('../src/checks/url-guard.ts', import.meta.url),
      'utf8',
    );

    for (const forbidden of [
      'node:dns',
      'node:http',
      'node:https',
      'fetch(',
      '.request(',
      '.connect(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
