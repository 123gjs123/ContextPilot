import type { Suggestion } from './types.js';

// CP-047: notificación de Windows sólo para `critical` que no sean `quiet`, una vez por id.

export class NotificationFilter {
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(private readonly max = 1000) {}

  /** Devuelve true si hay que notificar; registra el id para no repetir. */
  shouldNotify(s: Pick<Suggestion, 'id' | 'severity' | 'quiet' | 'expiresAt'>, now = Date.now()): boolean {
    if (s.severity !== 'critical' || s.quiet) return false;
    const exp = Date.parse(s.expiresAt);
    if (Number.isFinite(exp) && exp <= now) return false;
    if (this.seen.has(s.id)) return false;
    this.seen.add(s.id);
    this.order.push(s.id);
    if (this.order.length > this.max) this.seen.delete(this.order.shift()!);
    return true;
  }
}

export function notificationContent(s: Pick<Suggestion, 'title' | 'detail'>): { title: string; body: string } {
  const body = s.detail.length > 200 ? `${s.detail.slice(0, 199)}…` : s.detail;
  return { title: `ContextPilot · ${s.title}`, body };
}
