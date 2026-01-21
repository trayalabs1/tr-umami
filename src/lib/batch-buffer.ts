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

  add(item: T): void {
    if (this.isShuttingDown) {
      logger.warn(`[${this.options.name}] Received item during shutdown, skipping`);
      return;
    }

    this.buffer.push(item);

    // Trigger immediate flush if batch size reached
    if (this.buffer.length >= this.options.batchSize && !this.isFlushInProgress) {
      // Fire and forget - don't await so messages can keep arriving during flush
      this.flush().catch(error => {
        logger.error(`[${this.options.name}] Flush failed: ${error.message}`);
      });
    }

    // Force flush if buffer exceeds max size (prevents unbounded growth)
    if (this.buffer.length >= this.options.maxBufferSize && !this.isFlushInProgress) {
      logger(`[${this.options.name}] Buffer full (${this.buffer.length}), forcing immediate flush`);
      this.flush().catch(error => {
        logger.error(`[${this.options.name}] Force flush failed: ${error.message}`);
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
      logger.error(`[${this.options.name}] Failed to flush batch: ${(error as Error).message}`);
      // Re-add items to buffer for retry (prepend failed batch)
      this.buffer.unshift(...batch);
      throw error;
    } finally {
      // Release lock
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

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(error => {
        logger.error(`[${this.options.name}] Timer flush failed: ${error.message}`);
      });
    }, this.options.batchWindowMs);
  }
}
