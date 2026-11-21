/**
 * Small retry helper for HWS SEE browser operations (direct R2 upload, server verification, model
 * download). Pure and injectable (sleep) so the policy is unit-tested. Only failures marked as
 * transient are retried; a validation error is never repeated.
 */

export class SeeTransientError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "SeeTransientError";
    this.status = status;
  }
}

/** Network failure (status 0), throttling or a server/storage outage — worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export type SeeRetryOptions = Readonly<{
  attempts: number;
  baseDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}>;

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: SeeRetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => error instanceof SeeTransientError);
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !shouldRetry(error)) break;
      options.onRetry?.(attempt, error);
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
