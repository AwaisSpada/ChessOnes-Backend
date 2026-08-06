# ADR-004: PersistenceQueue

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 2
- **Flag:** Used when LiveGame mutations are authoritative (`LIVE_HTTP_VIA_MANAGER` / later WS)

## Context

After emit, games used unordered fire-and-forget `game.save().catch`. Concurrent
patches could land out of order; durability was invisible; eviction had no
coherent “flushed” signal for cold restart. Blocking the hot path on Mongo
before emit was rejected for latency (ADR-001).

## Decision

Introduce **PersistenceQueue**: per-`gameId` ordered async Mongo writes after
in-memory success.

API shape: `enqueue(gameId, patch|fullSnapshot)`, `flush(gameId)`,
`enqueueTerminal(...)`.

Rules:

- Emit path **never awaits** the queue.
- Prefer `updateOne` fencing where `syncVersion < incoming` (syncVersion fence).
- Queue owns Game document field patches; ratings /
  `scheduleGameCompletionSideEffects` stay on the end path.
- Persist must **not** reverse-sync into LiveGame (hydration **H4**).
- Evict LiveGame only after flush success (or explicit shutdown policy).

Mongo remains the durable source of truth for cold start; LiveGame remains
authoritative while active and present.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Await Mongo before emit | Rejected — latency |
| Mongo as hot-path SoT while LiveGame active | Rejected |
| Kafka / Redis Streams / SQS outbox | Deferred — scale addendum; Domain Events non-goal |
| Roll back in-memory apply on persist failure | Forbidden |
| Unordered `save().catch` | Replaced by this ADR |

## Consequences

- Mutate → emit → enqueue is the only legal order.
- Mongo lag behind emit is expected while LiveGame is authoritative.
- Crash after emit before flush can lose last unflushed moves — same risk class
  as pre-migration, mitigated by ordered retry + fencing, not eliminated.
- Terminal eviction couples Manager (ADR-002) to flush completion.

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Ordered, fenced durable writes | Durability not instantaneous |
| Hot path not blocked on Mongo | Crash gap accepted |
| Clear flush for evict | Ops must watch queue depth / failures |

## Future work

- **DirtyGame** health via PersistenceSubscriber (ADR-007): mark dirty, metrics,
  retry, alert after threshold — without mutating LiveGame.
- Recovery-origin flush for dirty outstanding across crash.
- Multi-instance durable coordination (Phase 6).
