import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { signAccessToken, verifyAccessToken } from '../src/auth/token.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const USER_ID = '11111111-1111-4111-8111-111111111111';

function decodePayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('malformed token');
  return JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('access tokens', () => {
  it('round-trips the user id', () => {
    const token = signAccessToken(USER_ID, config);

    expect(verifyAccessToken(token, config)).toBe(USER_ID);
  });

  it('carries only sub, iat and exp', () => {
    const payload = decodePayload(signAccessToken(USER_ID, config));

    // A JWT is signed, not encrypted: anything in here is readable by whoever
    // holds the token, so the payload stays minimal.
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(payload.sub).toBe(USER_ID);
  });

  it('expires 24 hours after issue', () => {
    const payload = decodePayload(signAccessToken(USER_ID, config));

    expect(Number(payload.exp) - Number(payload.iat)).toBe(24 * 60 * 60);
  });

  it('rejects a tampered payload', () => {
    const token = signAccessToken(USER_ID, config);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'someone-else', iat: 0, exp: 9_999_999_999 }),
    ).toString('base64url');

    const forged = `${String(header)}.${forgedPayload}.${String(signature)}`;

    expect(verifyAccessToken(forged, config)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const foreign = jwt.sign({ sub: USER_ID }, 'a'.repeat(40), {
      algorithm: 'HS256',
      expiresIn: 3600,
    });

    expect(verifyAccessToken(foreign, config)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: USER_ID }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: -60,
    });

    expect(verifyAccessToken(expired, config)).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', () => {
    // The classic JWT attack: claim there is no signature and hope the verifier
    // believes the token's own header. Ours pins HS256, so it cannot.
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: USER_ID, exp: 9_999_999_999 }),
    ).toString('base64url');

    expect(verifyAccessToken(`${header}.${payload}.`, config)).toBeNull();
  });

  it('rejects garbage instead of throwing', () => {
    for (const value of ['', 'not-a-token', 'a.b.c', '...']) {
      expect(verifyAccessToken(value, config)).toBeNull();
    }
  });
});
