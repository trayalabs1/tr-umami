/**
 * Next.js Instrumentation File
 *
 * This file is automatically loaded by Next.js on server startup.
 * Used for initializing process handlers and server-side setup.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on server side
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[INSTRUMENTATION] Loading server-side handlers...');

    // Import shutdown handlers - registers all process event listeners
    await import('./lib/shutdown');

    console.log('[INSTRUMENTATION] Server initialization complete');
  }
}
