// Mock the logger so logger.error is a jest spy we can assert on.
// The logger binds console.error at module-init time, so a post-import
// console.error spy would not intercept it — mocking the module is the clean approach.
const mockLoggerError = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => {
    const log = jest.fn() as any;
    log.error = mockLoggerError;
    log.warn = jest.fn();
    log.log = jest.fn();
    log.debug = jest.fn();
    return log;
  },
}));

import { BatchBuffer } from '../batch-buffer';

describe('umami BatchBuffer', () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it('emits KAFKA_PRODUCER_DROP marker on flush failure', async () => {
    const onFlush = jest.fn().mockRejectedValue(new Error('broker unavailable'));
    const buf = new BatchBuffer<number>({
      batchSize: 10,
      batchWindowMs: 1000,
      maxBufferSize: 20,
      onFlush,
      name: 'kafka',
    });
    await buf.add(1);
    await buf.add(2);
    await expect(buf.flush()).rejects.toThrow('broker unavailable');

    // Assert the stable alertable marker is present in the log output
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('KAFKA_PRODUCER_DROP'));
    // Assert running total is surfaced
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('total dropped: 2'));
  });

  it('does not re-queue a failed batch and counts drops', async () => {
    const onFlush = jest.fn().mockRejectedValue(new Error('send failed'));
    const buf = new BatchBuffer<number>({
      batchSize: 10,
      batchWindowMs: 1000,
      maxBufferSize: 20,
      onFlush,
      name: 'kafka',
    });
    await buf.add(1);
    await buf.add(2);
    await expect(buf.flush()).rejects.toThrow('send failed');
    expect(buf.getBufferSize()).toBe(0);
    expect(buf.getDroppedCount()).toBe(2);
  });

  it('clears buffer on successful flush', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer<number>({
      batchSize: 10,
      batchWindowMs: 1000,
      maxBufferSize: 20,
      onFlush,
      name: 'kafka',
    });
    await buf.add(1);
    await buf.flush();
    expect(buf.getBufferSize()).toBe(0);
    expect(buf.getDroppedCount()).toBe(0);
  });
});
