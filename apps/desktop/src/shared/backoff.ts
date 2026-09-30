// Backoff exponencial con jitter para reconectar el WebSocket (y reintentos de CDP).

export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 30_000, rand: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  // Jitter ±20 % para no sincronizar clientes.
  return Math.round(exp * (0.8 + 0.4 * rand()));
}
