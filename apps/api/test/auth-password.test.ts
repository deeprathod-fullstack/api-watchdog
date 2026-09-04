import { describe, expect, it } from 'vitest';

import {
  BCRYPT_COST,
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummy,
} from '../src/auth/password.js';

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  it('never stores the plaintext, and salts every hash', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toContain(PASSWORD);
    // Two hashes of the same password differ: bcrypt embeds a random salt, so
    // identical passwords are not detectable by comparing hashes, and a
    // precomputed rainbow table is useless.
    expect(first).not.toBe(second);
  });

  it('records the configured work factor inside the hash', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash.startsWith(`$2b$${String(BCRYPT_COST)}$`)).toBe(true);
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword('not the password', hash)).resolves.toBe(false);
    // A one-character difference must fail: bcrypt compares the whole input,
    // it does not truncate below 72 bytes.
    await expect(verifyPassword(PASSWORD + 'x', hash)).resolves.toBe(false);
  });

  it('spends comparable time on the no-such-user path', async () => {
    const hash = await hashPassword(PASSWORD);

    const startReal = performance.now();
    await verifyPassword('wrong password guess', hash);
    const realMs = performance.now() - startReal;

    const startDummy = performance.now();
    await verifyPasswordAgainstDummy('wrong password guess');
    const dummyMs = performance.now() - startDummy;

    // Loose bound on purpose — this asserts the dummy comparison is real work
    // of the same order, not a precise timing guarantee, which a shared CI
    // machine could never provide.
    expect(dummyMs).toBeGreaterThan(realMs / 4);
  });
});
