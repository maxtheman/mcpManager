/**
 * Session queue implementation for serializing Playwright commands.
 * Ensures per-session command ordering while allowing concurrent execution across different sessions.
 */

type SessionId = string;

interface QueueStats {
  sessionId: SessionId;
  pending: number;
  processing: boolean;
  totalProcessed: number;
  totalFailed: number;
  lastActivityAt: number | null;
}

/**
 * Per-session FIFO command queue.
 * Ensures commands for a single session are executed sequentially,
 * while allowing different sessions to run in parallel.
 */
export class SessionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private processing = false;
  private totalProcessed = 0;
  private totalFailed = 0;
  private lastActivityAt: number | null = null;

  constructor(public readonly sessionId: SessionId) {}

  private async executeCommand<T>(fn: () => Promise<T>): Promise<T> {
    this.processing = true;
    this.lastActivityAt = Date.now();
    try {
      const result = await fn();
      this.totalProcessed++;
      return result;
    } catch (error) {
      this.totalFailed++;
      throw error;
    } finally {
      this.pending--;
      this.processing = this.pending > 0;
    }
  }

  /**
   * Enqueue a command for sequential execution.
   * Commands are executed in FIFO order. Each command waits for the previous
   * one to complete before starting, regardless of whether it succeeded or failed.
   * @param fn - The async function to execute
   * @returns A promise that resolves with the command result or rejects with its error
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;

    const run = this.tail.then(() => this.executeCommand(fn));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Get current queue statistics.
   * @returns Statistics including pending count, processing state, and totals
   */
  getStats(): QueueStats {
    return {
      sessionId: this.sessionId,
      pending: this.pending,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      lastActivityAt: this.lastActivityAt,
    };
  }

  /**
   * Check if queue is idle (no pending commands).
   * @returns true if no commands are pending or processing
   */
  isIdle(): boolean {
    return this.pending === 0 && !this.processing;
  }

  /**
   * Wait for all pending commands to complete.
   * Resolves when the queue has finished processing all enqueued commands.
   */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

/**
 * Registry of session queues.
 * Creates queues on-demand and allows cleanup of idle queues.
 */
export class SessionQueueRegistry {
  private queues = new Map<SessionId, SessionQueue>();

  /**
   * Get or create a queue for the given session.
   * Creates a new queue if one doesn't exist for this session.
   * @param sessionId - The unique session identifier
   * @returns The session's command queue
   */
  forSession(sessionId: SessionId): SessionQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = new SessionQueue(sessionId);
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Remove a session's queue (typically after session ends).
   * Waits for any pending commands to complete before removing.
   * @param sessionId - The session to remove
   */
  async remove(sessionId: SessionId): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (queue) {
      await queue.drain();
      this.queues.delete(sessionId);
      return;
    }
  }

  /**
   * Get stats for all active queues.
   * @returns Array of statistics for each active session queue
   */
  getAllStats(): QueueStats[] {
    return Array.from(this.queues.values()).map((queue) => queue.getStats());
  }

  /**
   * Check if a session has an active queue.
   * @param sessionId - The session to check
   * @returns true if the session has an active queue
   */
  has(sessionId: SessionId): boolean {
    return this.queues.has(sessionId);
  }

  /**
   * Get count of active queues.
   * @returns Number of session queues currently registered
   */
  size(): number {
    return this.queues.size;
  }

  /**
   * Clean up idle queues older than maxIdleMs.
   * Removes queues that have no pending commands and haven't been used recently.
   * @param maxIdleMs - Maximum idle time in milliseconds before cleanup
   * @returns Array of session IDs that were removed
   */
  cleanupIdle(maxIdleMs: number): SessionId[] {
    const now = Date.now();
    const removed: SessionId[] = [];
    
    for (const [sessionId, queue] of Array.from(this.queues.entries())) {
      if (queue.isIdle() && queue.getStats().lastActivityAt !== null) {
        const idleTime = now - queue.getStats().lastActivityAt!;
        if (idleTime > maxIdleMs) {
          this.queues.delete(sessionId);
          removed.push(sessionId);
        }
      }
    }
    
    return removed;
  }
}

/** Singleton registry for the gateway process */
let defaultRegistry: SessionQueueRegistry | null = null;

/**
 * Get the default queue registry singleton.
 * Creates the registry on first access.
 * @returns The default SessionQueueRegistry instance
 */
export function getDefaultQueueRegistry(): SessionQueueRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SessionQueueRegistry();
  }
  return defaultRegistry;
}
