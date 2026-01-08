import { getDefaultContextRegistry } from "./context-registry.js";
import { getDefaultSessionManager } from "./session-manager.js";

interface JanitorOptions {
  intervalMs?: number;
  onSessionExpired?: (sessionId: string) => void;
  onError?: (error: Error) => void;
}

export class SessionJanitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly options: Required<JanitorOptions>;

  constructor(options: JanitorOptions = {}) {
    this.options = {
      intervalMs: options.intervalMs ?? 60_000,
      onSessionExpired: options.onSessionExpired ?? (() => {}),
      onError: options.onError ?? (() => {}),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const tick = () => {
      this.cleanup().catch((err) => {
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      });
    };

    this.timer = setInterval(tick, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  async cleanup(): Promise<number> {
    const registry = getDefaultContextRegistry();
    const sessionManager = getDefaultSessionManager();
    const expired = registry.listExpiredSessions();

    let count = 0;
    for (const session of expired) {
      try {
        await sessionManager.end({ sessionId: session.sessionId });
        this.options.onSessionExpired(session.sessionId);
        count++;
      } catch (err) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return count;
  }

  isRunning(): boolean {
    return this.running;
  }
}
