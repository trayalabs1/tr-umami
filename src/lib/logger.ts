import debug from 'debug';

export function createLogger(loggerName: string) {
  const log = debug(`umami:${loggerName}`);
  log.log = console.log.bind(console);
  log.debug = console.debug.bind(console);
  log.warn = console.warn.bind(console);
  log.error = console.error.bind(console);
  return log;
}
