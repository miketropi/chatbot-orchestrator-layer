export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function round(ms: number): number {
  return Math.round(ms);
}

/** Deterministic pseudo-latency so the demo behaves the same on every run. */
export function pseudoLatency(key: string, min = 120, max = 420): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const span = max - min;
  return min + (Math.abs(hash) % (span + 1));
}

export function formatVnd(amount: number): string {
  return `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}₫`;
}

export function preview(value: unknown, max = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
