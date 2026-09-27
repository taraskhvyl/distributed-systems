# notifier

Tells users what happened to their files. Node 24 + TypeScript, a Kafka consumer in its
own consumer group `notifier`, so a slow notifier never delays processing.

For every event in `file-events` it runs each handler in turn (Strategy pattern):

1. **Live event**: publish to Redis channel `sse-events` for the file's owner.
   `apps/sse-gateway` writes it to the owner's open browser tabs.
2. **Webhook**: log the notification and POST it to `WEBHOOK_URL` if set.

It has no HTTP server and is on the `data` network only. The internet-facing part lives in
`apps/sse-gateway` (ADR 0005), so nothing reachable from outside can read Kafka.

## Layout

```
src/
  main.ts                    composition root: Redis publisher + Kafka consumer + handlers
  config.ts                  env → config
  events.ts                  EventEnvelope (the file-events format) + EnvelopeHandler type
  kafka/consumer.ts          subscribe, parse, call every handler
  notifications/
    live-push.ts             handler: event → Live event for the file's owner
    webhook.ts               handler: log + optional webhook POST (3 s timeout)
    messages.ts              human-readable text per event type
  redis/publisher.ts         PUBLISH to the Live events channel (@mediashare/live-events)
```

## Delivery

- Kafka → notifier: at-least-once (commits after the handlers ran).
- notifier → browser: **at-most-once**. Pub/sub keeps nothing; a tab that isn't connected
  misses the event and resyncs on reconnect.
- If Redis is down, the publish is logged and dropped, not thrown: a throw would make Kafka
  redeliver forever and stall the webhook handler too.

## Talks to

- **Kafka**: consumes `file-events`.
- **Redis**: ACL user `notifier`, allowed exactly `PUBLISH sse-events`.
- **Webhook URL** (optional, outbound).

## Config (env)

`REDIS_URL` (with the `notifier` user), `KAFKA_BROKERS`, `TOPIC_MAIN`, optional `WEBHOOK_URL`.

## Run

```bash
docker compose up -d --build notifier
docker compose logs -f notifier | grep "notification dispatched"
```

Scaling: like any consumer group, useful up to the partition count (3).
