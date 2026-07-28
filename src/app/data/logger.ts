import { isDevMode } from '@angular/core';

/**
 * Thin console wrapper that stays silent in production builds. Use this instead of
 * calling `console.*` directly so diagnostic output never reaches end users.
 */
export const logger = {
  log: (...args: unknown[]): void => {
    if (isDevMode()) { console.log(...args); }
  },
  warn: (...args: unknown[]): void => {
    if (isDevMode()) { console.warn(...args); }
  },
  error: (...args: unknown[]): void => {
    if (isDevMode()) { console.error(...args); }
  },
};
