export function clamp(n, min, max) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError('n must be a finite number');
  }
  if (min > max) [min, max] = [max, min];
  return Math.min(Math.max(n, min), max);
}
