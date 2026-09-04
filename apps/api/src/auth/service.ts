import type pg from 'pg';

import { type Config } from '@api-watchdog/shared';

import { ConflictError, InvalidCredentialsError } from '../errors.js';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummy,
} from './password.js';
import {
  EmailAlreadyExistsError,
  findUserByEmail,
  insertUser,
  type User,
} from './repository.js';
import { type LoginInput, type RegisterInput } from './schemas.js';
import { signAccessToken } from './token.js';

/**
 * The only shape a user is ever serialised in.
 *
 * A single mapper means `password_hash` cannot leak through some future
 * endpoint that selected `*` and spread the row into a response.
 */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

/**
 * Create an account and log the caller straight in.
 *
 * Returning a token from register avoids an immediate second round trip whose
 * only outcome is the token we already could have issued.
 */
export async function registerUser(
  db: pg.Pool,
  config: Config,
  input: RegisterInput,
): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await insertUser(db, {
      name: input.name,
      email: input.email,
      passwordHash,
    });

    return {
      user: toPublicUser(user),
      token: signAccessToken(user.id, config),
    };
  } catch (error) {
    if (error instanceof EmailAlreadyExistsError) {
      // A distinct 409 does tell a caller which addresses are registered. It is
      // accepted for V1 because the alternative ("we have emailed you") needs
      // an email system that is out of scope; rate limiting is the mitigation,
      // and the tradeoff is recorded as a known limitation.
      throw new ConflictError('email_taken', 'Email is already registered');
    }
    throw error;
  }
}

/**
 * Verify credentials and issue a token.
 *
 * Both failure modes raise the same {@link InvalidCredentialsError}, and both
 * run a bcrypt comparison, so neither the message nor the timing reveals
 * whether the account exists.
 */
export async function loginUser(
  db: pg.Pool,
  config: Config,
  input: LoginInput,
): Promise<AuthResult> {
  const user = await findUserByEmail(db, input.email);

  if (!user) {
    await verifyPasswordAgainstDummy(input.password);
    throw new InvalidCredentialsError();
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw new InvalidCredentialsError();
  }

  return { user: toPublicUser(user), token: signAccessToken(user.id, config) };
}
