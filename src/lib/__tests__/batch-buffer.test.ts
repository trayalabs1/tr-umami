import { BatchBuffer } from '../batch-buffer';

describe('umami BatchBuffer', () => {
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
