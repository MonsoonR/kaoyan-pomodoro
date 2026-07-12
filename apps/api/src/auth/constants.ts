export const SESSION_COOKIE_NAME = 'kaoyan_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOCK_FAILURES = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;
export const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: SESSION_MAX_AGE_SECONDS };
