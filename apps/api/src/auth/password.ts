import argon2 from 'argon2';

export interface PasswordOptions { memoryCost: number; timeCost: number; parallelism: number }
export const PRODUCTION_PASSWORD_OPTIONS: PasswordOptions = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };
export const TEST_PASSWORD_OPTIONS: PasswordOptions = { memoryCost: 8_192, timeCost: 1, parallelism: 1 };
export function hashPassword(password: string, options = PRODUCTION_PASSWORD_OPTIONS) {
  return argon2.hash(password, { type: argon2.argon2id, ...options });
}
export function verifyPassword(hash: string, password: string) { return argon2.verify(hash, password); }
