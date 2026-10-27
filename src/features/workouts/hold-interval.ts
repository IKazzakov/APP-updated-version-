/** Integer milliseconds entirely inside the observed valid camera interval. */
export function quantizeHoldInterval(
  wallOrigin: number,
  timestamp: number,
  elapsedMs: number,
  previousEnd = 0,
  remainingMs = 1000,
): { occurredAt: number; durationMs: number } | null {
  if (
    ![wallOrigin, timestamp, elapsedMs, previousEnd, remainingMs].every(Number.isFinite) ||
    elapsedMs <= 0 ||
    elapsedMs > 1000 ||
    remainingMs < 1
  )
    return null;
  // Subtract in the small monotonic clock before adding the UTC epoch. Separate
  // flooring of a UTC start and a fractional delta can overlap adjacent events.
  const occurredAt = Math.max(Math.ceil(wallOrigin + (timestamp - elapsedMs)), previousEnd);
  const end = Math.floor(wallOrigin + timestamp);
  const durationMs = Math.min(end - occurredAt, Math.floor(remainingMs), 1000);
  return durationMs >= 1 ? { occurredAt, durationMs } : null;
}
