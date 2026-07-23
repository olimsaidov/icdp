type PerformanceClock = Pick<Performance, "now"> & Partial<Pick<Performance, "timeOrigin">>;

/**
 * Best browser-JavaScript approximation of CDP's process-wide MonotonicTime.
 *
 * `performance.now()` alone restarts for every document. Adding the immutable
 * time origin keeps Page and Network timestamps ordered across iframe
 * navigations while retaining the clock's sub-millisecond precision.
 */
export function cdpMonotonicTime(clock: PerformanceClock, relativeTimeMs = clock.now()): number {
  const origin = Number(clock.timeOrigin);
  const timestampMs = (Number.isFinite(origin) ? origin : 0) + relativeTimeMs;
  return Math.max(Number.EPSILON, timestampMs / 1000);
}
