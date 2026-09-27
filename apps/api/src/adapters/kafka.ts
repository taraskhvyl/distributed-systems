import { Kafka, Producer } from 'kafkajs'
import { config } from '../config.js'

const CLIENT_RETRIES = 10

// Adapter: the only Kafka producer in the api. The outbox relay is its sole user; request
// handlers never publish directly (they write outbox rows, see messaging/outbox.ts).
export function createProducer(): Producer {
  const kafka = new Kafka({
    clientId: 'mediashare-api',
    brokers: config.kafkaBrokers,
    retry: { retries: CLIENT_RETRIES },
  })
  return kafka.producer()
}
