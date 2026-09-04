import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { signAccessToken } from '../src/auth/token.js';
import { buildTestApp, testConfig, testPool } from './helpers.js';

/**
 * Integration tests against the real PostgreSQL from docker-compose
 * (`npm run db:migrate` must have been applied).
 *
 * The parts most worth testing here live in the database — the unique index
 * that produces the 409, the case-insensitive login lookup — so a fake
 * repository would test nothing that can actually break in production.
 */
const config = testConfig();
const db = testPool(config);
const app = buildTestApp(config, db);

/** Emails are unique per run, so repeated runs never collide. */
const suffix = randomUUID();
const email = `alice-${suffix}@example.test`;
const otherEmail = `bob-${suffix}@example.test`;
const password = 'correct horse battery staple';

const publicUserSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  createdAt: z.iso.datetime(),
});

const authResponseSchema = z.strictObject({
  user: publicUserSchema,
  token: z.string().min(1),
});

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

beforeAll(async () => {
  await db.query('SELECT 1');
});

afterAll(async () => {
  await db.query('DELETE FROM users WHERE email = ANY($1)', [
    [email, otherEmail],
  ]);
  await db.end();
});

describe('POST /api/auth/register', () => {
  it('creates the account, returns it with a token, and never leaks the hash', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Alice', email, password });

    expect(response.status).toBe(201);

    const body = authResponseSchema.parse(response.body);
    expect(body.user.email).toBe(email);

    // The strict schema above already fails on an extra property; this asserts
    // the specific one that must never appear, whatever else changes.
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('rejects a duplicate email with 409, including a different casing', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Alice Again', email: email.toUpperCase(), password });

    expect(response.status).toBe(409);
    expect(errorSchema.parse(response.body).error.code).toBe('email_taken');
  });

  it('rejects an invalid payload at the boundary without echoing the password', async () => {
    const cases = [
      { name: 'Bob', email: 'not-an-email', password },
      { name: 'Bob', email: otherEmail, password: 'short' },
      { name: '', email: otherEmail, password },
      { email: otherEmail, password },
      { name: 'Bob', email: otherEmail, password, role: 'admin' },
    ];

    for (const payload of cases) {
      const response = await request(app)
        .post('/api/auth/register')
        .send(payload);

      expect(response.status).toBe(400);
      expect(errorSchema.parse(response.body).error.code).toBe(
        'validation_failed',
      );
      expect(JSON.stringify(response.body)).not.toContain('short');
      expect(JSON.stringify(response.body)).not.toContain(password);
    }
  });
});

describe('POST /api/auth/login', () => {
  it('accepts the right credentials and is case-insensitive on email', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: email.toUpperCase(), password });

    expect(response.status).toBe(200);
    expect(authResponseSchema.parse(response.body).user.email).toBe(email);
  });

  it('answers identically for a wrong password and an unknown account', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'not the right password' });

    const unknownAccount = await request(app)
      .post('/api/auth/login')
      .send({ email: `nobody-${suffix}@example.test`, password });

    for (const response of [wrongPassword, unknownAccount]) {
      expect(response.status).toBe(401);
    }

    // Identical bodies: any difference here is an account-existence oracle for
    // credential stuffing.
    expect(unknownAccount.body).toEqual(wrongPassword.body);
    expect(errorSchema.parse(wrongPassword.body).error.code).toBe(
      'invalid_credentials',
    );
  });
});

describe('GET /api/auth/me', () => {
  async function login(): Promise<string> {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password });

    return authResponseSchema.parse(response.body).token;
  }

  it('returns the caller identity for a valid token', async () => {
    const token = await login();

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    const body = z
      .strictObject({ user: publicUserSchema })
      .parse(response.body);
    expect(body.user.email).toBe(email);
  });

  it('rejects every malformed or missing credential with the same 401', async () => {
    const token = await login();

    const headers = [
      undefined,
      token,
      `Basic ${token}`,
      'Bearer',
      `Bearer ${token} extra`,
      'Bearer not-a-token',
    ];

    for (const header of headers) {
      const call = request(app).get('/api/auth/me');
      if (header !== undefined) void call.set('Authorization', header);

      const response = await call;

      expect(response.status).toBe(401);
      expect(errorSchema.parse(response.body).error.code).toBe(
        'unauthenticated',
      );
    }
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ sub: randomUUID() }, 'x'.repeat(40), {
      algorithm: 'HS256',
      expiresIn: 3600,
    });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ sub: randomUUID() }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: -60,
    });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
  });

  it('rejects a validly signed token for a user that no longer exists', async () => {
    // This is why the middleware reads the database instead of trusting the
    // signature alone: the token is genuine, the account is not.
    const token = signAccessToken(randomUUID(), config);

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(errorSchema.parse(response.body).error.code).toBe('unauthenticated');
  });
});
