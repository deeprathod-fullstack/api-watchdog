import { z } from 'zod';

import { MAX_PASSWORD_BYTES } from './password.js';

/**
 * Password policy: length only.
 *
 * Composition rules ("one uppercase, one symbol") are dropped deliberately —
 * they push people towards `Password1!` and are known to reduce real-world
 * password strength. Length is what actually buys entropy. The upper bound is
 * bcrypt's, measured in bytes because a multi-byte character costs more than
 * one byte of the 72 available.
 */
const passwordSchema = z
  .string()
  .min(12, 'must be at least 12 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
    message: `must be at most ${MAX_PASSWORD_BYTES} bytes`,
  });

/**
 * Emails are stored and compared lowercase.
 *
 * The `users` table has a unique index on `lower(email)`, so normalising here
 * keeps the application's idea of identity identical to the database's — no
 * pair of accounts differing only in case, which is a login-confusion and
 * takeover hazard.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address'))
  .pipe(z.string().max(254, 'must be at most 254 characters'));

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1, 'is required').max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  // No policy check on login: the stored password predates any policy change,
  // and telling a caller their guess was "too short to be valid" is one more
  // bit than they should get.
  password: z.string().min(1, 'is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
