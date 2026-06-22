// Verifies the producer is created idempotent. We mock kafkajs.
const producerFactory = jest.fn(() => ({
  connect: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn(() => ({ producer: producerFactory })),
  CompressionTypes: { GZIP: 2 },
  logLevel: { ERROR: 0 },
}));

jest.mock('serialize-error', () => ({ serializeError: (e: unknown) => e }));

describe('umami kafka producer config', () => {
  beforeEach(() => {
    process.env.KAFKA_URL = 'http://u:p@localhost:9092';
    process.env.KAFKA_BROKER = 'localhost:9092';
    jest.resetModules();
    producerFactory.mockClear();
  });

  it('creates an idempotent producer with maxInFlightRequests=1', async () => {
    const mod = await import('../kafka');
    await mod.default.connect();
    expect(producerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ idempotent: true, maxInFlightRequests: 1 }),
    );
  });
});
