import { createLogger } from '@/lib/logger';

const logger = createLogger('batch-buffer');

export interface BatchBufferOptions<T> {
  batchSize: number;
  batchWindowMs: number;
  maxBufferSize: number;
  onFlush: (batch: T[]) => Promise<void>;
  name: string;
}

export class BatchBuffer<T> {
  private buffer: T[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private isFlushInProgress = false;
  private droppedCount = 0;
  private readonly options: BatchBufferOptions<T>;

  constructor(options: BatchBufferOptions<T>) {
    if (options.batchSize <= 0 || options.maxBufferSize <= 0 || options.batchWindowMs <= 0) {
      throw new Error('Buffer sizes and window must be positive');
    }
    if (options.batchSize > options.maxBufferSize) {
      throw new Error(
        `batchSize (${options.batchSize}) must be <= maxBufferSize (${options.maxBufferSize})`,
      );
    }
    this.options = options;
  }

  start(): void {
    this.startFlushTimer();
    logger(
      `[${this.options.name}] BatchBuffer started (size: ${this.options.batchSize}, window: ${this.options.batchWindowMs}ms, max: ${this.options.maxBufferSize})`,
    );
  }

  async add(item: T): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn(`[${this.options.name}] Received item during shutdown, skipping`);
      return;
    }

    // Backpressure: wait while buffer is full (caller is fire-and-forget, safe to await).
    while (this.buffer.length >= this.options.maxBufferSize && !this.isShuttingDown) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.buffer.push(item);

    if (this.buffer.length >= this.options.batchSize && !this.isFlushInProgress) {
      this.flush().catch(error => {
        logger.error(`[${this.options.name}] Flush failed: ${error.message}`);
      });
    }
  }

  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushInProgress || this.buffer.length === 0) {
      return;
    }

    // Acquire lock and atomically copy/clear buffer
    this.isFlushInProgress = true;
    const batch = [...this.buffer];
    this.buffer = [];

    try {
      await this.options.onFlush(batch);
      logger(`[${this.options.name}] Flushed ${batch.length} items`);
    } catch (error) {
      this.droppedCount += batch.length;
      // KAFKA_PRODUCER_DROP is a stable marker for alert rules (e.g. grep/log-based alerts).
      // logger.error bypasses the debug namespace gate — always emitted regardless of DEBUG env.
      logger.error(
        `[KAFKA_PRODUCER_DROP] [${this.options.name}] Flush failed, dropped ${batch.length} messages ` +
          `(total dropped: ${this.droppedCount}): ${(error as Error).message}`,
      );
      // Do NOT re-queue — re-queuing on a rejected send caused duplicate inserts.
      throw error;
    } finally {
      this.isFlushInProgress = false;
    }
  }

  async shutdown(): Promise<void> {
    logger.log(`[${this.options.name}] Graceful shutdown initiated`);
    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for any in-progress flush to complete
    const startTime = Date.now();
    const maxWait = 10000; // 10 seconds max wait
    while (this.isFlushInProgress && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Flush remaining items
    await this.flush();
    logger.log(`[${this.options.name}] Graceful shutdown complete`);
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(error => {
        logger.error(`[${this.options.name}] Timer flush failed: ${error.message}`);
      });
    }, this.options.batchWindowMs);
  }
}
