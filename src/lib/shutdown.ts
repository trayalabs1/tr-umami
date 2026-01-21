import { serializeError } from 'serialize-error';
import kafka from '@/lib/kafka';
import { createLogger } from '@/lib/logger';
import prisma from '@/lib/prisma';

const logger = createLogger('shutdown');

// Shutdown state management
let isShuttingDown = false;
let shutdownTimer: NodeJS.Timeout | null = null;
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds max shutdown time

/**
 * Graceful shutdown handler - flushes Kafka queue and closes connections
 */
export async function gracefulShutdown(signal: string, exitCode: number = 0): Promise<void> {
  // Prevent duplicate shutdown attempts
  if (isShuttingDown) {
    logger.log(`Shutdown already in progress, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.log(`\n[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);

  // Force exit after timeout to prevent hanging
  shutdownTimer = setTimeout(() => {
    logger.error(`[SHUTDOWN] Timeout after ${SHUTDOWN_TIMEOUT}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // Step 1: Flush Kafka messages (most critical - prevent data loss)
    if (kafka.enabled && typeof kafka.gracefulShutdown === 'function') {
      logger.log('[SHUTDOWN] Flushing Kafka queue...');
      const kafkaStart = Date.now();

      try {
        await kafka.gracefulShutdown();

        const kafkaDuration = Date.now() - kafkaStart;
        logger.log(`[SHUTDOWN] Kafka flushed in ${kafkaDuration}ms`);

        // Log final metrics
        if (typeof kafka.getMetrics === 'function') {
          const metrics = kafka.getMetrics();
          logger.log('[SHUTDOWN] Final Kafka metrics:', JSON.stringify(metrics));
        }
      } catch (kafkaError) {
        logger.error('[SHUTDOWN] Kafka flush error:', serializeError(kafkaError));
        // Continue shutdown even if Kafka fails
      }
    }

    // Step 2: Close Prisma connections
    logger.log('[SHUTDOWN] Closing database connections...');
    try {
      await Promise.race([
        prisma.client.$disconnect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Prisma disconnect timeout')), 5000),
        ),
      ]);
      logger.log('[SHUTDOWN] Database connections closed');
    } catch (prismaError) {
      logger.error('[SHUTDOWN] Database disconnect error:', serializeError(prismaError));
    }

    // Step 3: Clear shutdown timer
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }

    logger.log(`[SHUTDOWN] Graceful shutdown complete (exit code: ${exitCode})`);
    process.exit(exitCode);
  } catch (error) {
    logger.error('[SHUTDOWN] Fatal error during shutdown:', serializeError(error));

    // Clear timer and force exit
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }

    process.exit(1);
  }
}

/**
 * Handle unhandled promise rejections
 * These occur when a promise rejects without a .catch() handler
 */
function handleUnhandledRejection(reason: any, promise: Promise<any>): void {
  logger.error('\n[FATAL] Unhandled Promise Rejection detected');
  logger.error('[FATAL] Reason:', serializeError(reason));
  logger.error('[FATAL] Promise:', promise);

  // In production, we want to restart the pod to recover
  // But first, try to flush Kafka to prevent data loss
  if (process.env.NODE_ENV === 'production') {
    logger.error('[FATAL] Initiating emergency shutdown...');
    gracefulShutdown('unhandledRejection', 1).catch(() => {
      // If graceful shutdown fails, force exit
      process.exit(1);
    });
  } else {
    // In development, just log but keep running for debugging
    logger.error('[FATAL] Unhandled rejection in development mode, continuing...');
  }
}

/**
 * Handle uncaught exceptions
 * These are synchronous errors that weren't caught by try-catch
 */
function handleUncaughtException(error: Error, origin: string): void {
  logger.error('\n[FATAL] Uncaught Exception detected');
  logger.error('[FATAL] Error:', serializeError(error));
  logger.error('[FATAL] Origin:', origin);
  logger.error('[FATAL] Stack:', error.stack);

  // Emergency shutdown - this is a critical error
  logger.error('[FATAL] Initiating emergency shutdown...');
  gracefulShutdown('uncaughtException', 1).catch(() => {
    // If graceful shutdown fails, force exit immediately
    process.exit(1);
  });
}

/**
 * Handle warning events (memory leaks, deprecations, etc.)
 */
function handleWarning(warning: Error): void {
  // Log warnings but don't crash
  // log.warn('[WARNING]', warning.name, warning.message);

  // Check for memory leak warnings
  if (warning.name === 'MaxListenersExceededWarning') {
    logger.error('[WARNING] Potential memory leak detected - too many event listeners');
  }
}

/**
 * Handle before exit - last chance cleanup
 */
function handleBeforeExit(code: number): void {
  logger(`Process about to exit with code: ${code}`);

  // Log final memory usage
  const memUsage = process.memoryUsage();
  logger.log('[SHUTDOWN] Final memory usage:', {
    heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
    heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
    rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)}MB`,
    external: `${(memUsage.external / 1024 / 1024).toFixed(2)}MB`,
  });
}

// ============================================================================
// Register all process event handlers
// ============================================================================

// Graceful shutdown signals
process.on('SIGTERM', () => {
  logger.log('[SIGNAL] Received SIGTERM (Kubernetes graceful shutdown)');
  gracefulShutdown('SIGTERM', 0);
});

process.on('SIGINT', () => {
  logger.log('[SIGNAL] Received SIGINT (Ctrl+C)');
  gracefulShutdown('SIGINT', 0);
});

// Error handlers
process.on('unhandledRejection', handleUnhandledRejection);
process.on('uncaughtException', handleUncaughtException);

// Warning handlers
process.on('warning', handleWarning);

// Exit handlers
process.on('beforeExit', handleBeforeExit);

// Log startup
logger.log('[STARTUP] Process handlers registered');
logger.log('[STARTUP] PID:', process.pid);
logger.log('[STARTUP] Node version:', process.version);
logger.log('[STARTUP] Platform:', process.platform);

// Export for testing
export default {
  gracefulShutdown,
  isShuttingDown: () => isShuttingDown,
};
