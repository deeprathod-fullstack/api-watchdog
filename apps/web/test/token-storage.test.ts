import { beforeEach, describe, expect, it } from 'vitest';

import {
  createMemoryTokenStorage,
  createTokenStorage,
} from '../src/lib/token-storage.js';

describe('token storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips and clears a token', () => {
    const storage = createTokenStorage();

    expect(storage.get()).toBeNull();

    storage.set('token-abc');
    expect(storage.get()).toBe('token-abc');

    storage.clear();
    expect(storage.get()).toBeNull();
  });

  it('degrades to no session when the browser blocks storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('access denied');
      },
      setItem: () => {
        throw new Error('access denied');
      },
      removeItem: () => {
        throw new Error('access denied');
      },
    } as unknown as Storage;

    const storage = createTokenStorage(blocked);

    expect(() => {
      storage.set('token-abc');
    }).not.toThrow();
    expect(storage.get()).toBeNull();
    expect(() => {
      storage.clear();
    }).not.toThrow();
  });

  it('keeps the in-memory implementation interchangeable', () => {
    const storage = createMemoryTokenStorage();

    storage.set('token-abc');
    expect(storage.get()).toBe('token-abc');
    expect(localStorage.length).toBe(0);
  });
});
