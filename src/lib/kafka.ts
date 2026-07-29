import type * as tls from 'node:tls';
import { CompressionTypes, Kafka, logLevel, type Producer, type SASLOptions } from 'kafkajs';
import { serializeError } from 'serialize-error';
import { BatchBuffer } from '@/lib/batch-buffer';
import { KAFKA, KAFKA_PRODUCER } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { sleep } from '@/lib/utils';

const logger = createLogger('kafka');

// Configuration from environment variables
const BATCH_WINDOW_MS = parseInt(process.env.KAFKA_BATCH_WINDOW_MS || '10', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.KAFKA_MAX_QUEUE_SIZE || '500', 10);
const BATCH_SIZE = Math.floor(MAX_QUEUE_SIZE * 0.8); // Flush at 80% capacity
const CONNECT_TIMEOUT = parseInt(process.env.KAFKA_CONNECT_TIMEOUT || '10000', 10);
const SEND_TIMEOUT = parseInt(process.env.KAFKA_SEND_TIMEOUT || '30000', 10);
const ACKS = 1;
const DEFAULT_MAX_MESSAGE_BYTES = 900_000;

let kafka: Kafka;
let producer: Producer;
const enabled = Boolean(process.env.KAFKA_URL && process.env.KAFKA_BROKER);

// Message type for batching
interface KafkaMessage {
  topic: string;
  value: string;
  timestamp: string;
}

type KafkaProducerMessage = { value: string; timestamp: string };

// Batch buffer instance
let batchBuffer: BatchBuffer<KafkaMessage> | null = null;

function getMaxMessageBytes() {
  const size = Number(process.env.KAFKA_MAX_MESSAGE_BYTES);

  return Number.isFinite(size) && size > 0 ? size : DEFAULT_MAX_MESSAGE_BYTES;
}

function getMessageSize(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function chunkBySize(messages: KafkaProducerMessage[], maxMessageBytes: number) {
  const chunks: KafkaProducerMessage[][] = [];
  let chunk: KafkaProducerMessage[] = [];
  let chunkSize = 0;

  for (const message of messages) {
    const size = getMessageSize(message.value);

    if (chunk.length && chunkSize + size > maxMessageBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkSize = 0;
    }

    chunk.push(message);
    chunkSize += size;
  }

  if (chunk.length) {
    chunks.push(chunk);
  }

  return chunks;
}

function getClient() {
  const { username, password } = new URL(process.env.KAFKA_URL);
  const brokers = process.env.KAFKA_BROKER.split(',');
  const mechanism =
    (process.env.KAFKA_SASL_MECHANISM as 'plain' | 'scram-sha-256' | 'scram-sha-512') || 'plain';

  const ssl: { ssl?: tls.ConnectionOptions | boolean; sasl?: SASLOptions } =
    username && password
      ? {
          ssl: {
            rejectUnauthorized: false,
          },
          sasl: {
            mechanism,
            username,
            password,
          },
        }
      : {};

  const client: Kafka = new Kafka({
    clientId: 'umami',
    brokers: brokers,
    connectionTimeout: CONNECT_TIMEOUT,
    logLevel: logLevel.ERROR,
    ...ssl,
  });

  if (process.env.NODE_ENV !== 'production') {
    globalThis[KAFKA] = client;
  }

  logger('Kafka initialized');

  return client;
}

async function getProducer(): Promise<Producer> {
  const producer = kafka.producer();
  await producer.connect();

  if (process.env.NODE_ENV !== 'production') {
    globalThis[KAFKA_PRODUCER] = producer;
  }

  logger(
    `Kafka producer initialized (batch: ${BATCH_SIZE}, window: ${BATCH_WINDOW_MS}ms, max: ${MAX_QUEUE_SIZE})`,
  );

  return producer;
}

/**
 * Flush handler called by BatchBuffer when it's time to send messages
 */
async function flushBatch(messages: KafkaMessage[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  // Group messages by topic
  const topicGroups = messages.reduce(
    (acc, msg) => {
      if (!acc[msg.topic]) acc[msg.topic] = [];
      acc[msg.topic].push({
        value: msg.value,
        timestamp: msg.timestamp,
      });
      return acc;
    },
    {} as Record<string, KafkaProducerMessage[]>,
  );

  await connect();

  if (!producer) {
    await sleep(500);
  }

  const maxMessageBytes = getMaxMessageBytes();

  // Send all topics in parallel
  await Promise.all(
    Object.entries(topicGroups).map(async ([topic, msgs]) => {
      // Split into chunks that stay under the broker's max message size
      for (const chunk of chunkBySize(msgs, maxMessageBytes)) {
        await producer.send({
          topic,
          messages: chunk,
          acks: ACKS,
          timeout: SEND_TIMEOUT,
          compression: CompressionTypes.GZIP,
        });
      }
    }),
  );

  logger(`Flushed ${messages.length} messages across ${Object.keys(topicGroups).length} topics`);
}

/**
 * Initialize batch buffer
 */
function initializeBatchBuffer(): void {
  if (!batchBuffer) {
    batchBuffer = new BatchBuffer<KafkaMessage>({
      batchSize: BATCH_SIZE,
      batchWindowMs: BATCH_WINDOW_MS,
      maxBufferSize: MAX_QUEUE_SIZE,
      onFlush: flushBatch,
      name: 'kafka',
    });

    batchBuffer.start();
    logger('Batch buffer initialized and started');
  }
}

/**
 * Send message to Kafka with automatic batching
 */
async function sendMessage(
  topic: string,
  message: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  if (!batchBuffer) {
    initializeBatchBuffer();
  }

  const messages = Array.isArray(message) ? message : [message];
  const maxMessageBytes = getMaxMessageBytes();

  // Add each message to the batch buffer (synchronous, non-blocking)
  for (const msg of messages) {
    const value = JSON.stringify(msg);
    const size = getMessageSize(value);

    // Oversized messages can never be delivered - drop instead of poisoning the batch
    if (size > maxMessageBytes) {
      logger(`Kafka message dropped: topic=${topic} size=${size} max=${maxMessageBytes}`);
      continue;
    }

    batchBuffer.add({
      topic,
      value,
      timestamp: Date.now().toString(),
    });
  }
}

async function connect(): Promise<Kafka> {
  if (!kafka) {
    kafka = process.env.KAFKA_URL && process.env.KAFKA_BROKER && (globalThis[KAFKA] || getClient());

    if (kafka) {
      producer = globalThis[KAFKA_PRODUCER] || (await getProducer());
    }
  }

  return kafka;
}

/**
 * Graceful shutdown: flush remaining messages and disconnect
 */
export async function gracefulShutdown(): Promise<void> {
  logger('Initiating graceful shutdown...');

  try {
    // Shutdown batch buffer (this will flush remaining messages)
    if (batchBuffer) {
      await batchBuffer.shutdown();
    }

    // Disconnect producer
    if (producer) {
      await producer.disconnect();
      logger('Producer disconnected');
    }
  } catch (e) {
    logger.error('Error during graceful shutdown:', serializeError(e));
  }

  logger('Kafka shutdown complete');
}

/**
 * Get current buffer metrics
 */
export function getMetrics() {
  return {
    bufferSize: batchBuffer?.getBufferSize() || 0,
    maxBufferSize: MAX_QUEUE_SIZE,
    batchSize: BATCH_SIZE,
    batchWindowMs: BATCH_WINDOW_MS,
  };
}

export default {
  enabled,
  client: kafka,
  producer,
  log: logger,
  connect,
  sendMessage,
  gracefulShutdown,
  getMetrics,
};
