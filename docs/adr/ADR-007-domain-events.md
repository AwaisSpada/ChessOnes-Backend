# ADR-007: Domain Events

- **Status:** Accepted (implemented) — design remains frozen; runtime behind `LIVE_DOMAIN_EVENTS`
- **Date:** 2026-08-06
- **Phases:** M0–M5 landed behind flag (sole path when ON; GameTransport direct path when OFF)
- **Flag:** `LIVE_DOMAIN_EVENTS` default false

## Context

After Phases 0–4, LiveGame mutation paths still couple apply → emit → persist →
reschedule in call sites. Adding tournaments, spectators, analytics, or
anti-cheat would keep touching LiveGame. Public wire payloads risk leaking
internal fields if domain models are emitted raw.

Kafka-style buses are out of scope for the current single-process deployment.

## Decision

Adopt a **synchronous in-process EventBus**. LiveGame (and move / end helpers)
mutate under `runSerialized`, then `publish(DomainEvent)`. Subscribers react.

### Internal Domain Events ≠ Public Transport Events

| | Internal Domain Events | Public Transport Events |
|--|------------------------|-------------------------|
| Audience | In-process subscribers | Remote clients |
| Names | `MOVE_APPLIED`, `TIMEOUT_OCCURRED`, … | `move-made`, `moveAccepted`, … |
| Stability | May evolve with server | Wire contract; additive only |
| Produced by | LiveGame / pipeline | Projection → GameTransport |

### Projection layer

```
Domain Events → Projection → GameTransport
```

Projection builds client DTOs and calls GameTransport (ADR-006). Isolates wire
from domain models; allows multiple public shapes from one domain event.

### Envelope

Every event includes: `eventId`, `serverEventId`, `gameId`, `syncVersion`,
`occurredAt`, `eventType`, **`origin`**, `payload`.

**Allowed `origin` values:** `HTTP` | `WS` | `Timeout` | `Abandon` |
`Reconnect` | `Recovery` | `System`.

### Subscriber hard rule

Subscribers **must never** mutate LiveGame board, clocks, turns, status, or
`syncVersion`. Allowed only: emit (via Projection), persist, schedule, record
metrics / alerts.

### Required move subscriber order

**Projection → Persistence (+ DirtyGame) → Scheduler** → optional analytics /
replay. Registration order = execution order. Bus awaits handlers sequentially.

### DirtyGame (PersistenceSubscriber)

On persist failure: mark dirty → metrics → retry with backoff → alert after
threshold. Do not roll back in-memory apply. DirtyGame is persistence health,
not a second authority.

### Non-goals

No Kafka / Redis Streams / SQS / async outbox in this ADR. No Phase 0–4 runtime
change from the design alone. No roadmap amendments from this document.

This design document is **frozen**; reopen only explicitly.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Keep coupled call sites forever | Rejected for extensibility |
| Kafka / Redis Streams / SQS | Deferred — scale addendum |
| One shared schema for domain + wire | Rejected |
| Pass raw LiveGame to sockets | Rejected |
| Async queue inside the bus | Rejected for v1 ordering |
| Fatal abort of remaining subscribers (v1) | Rejected — isolate failures |
| Roll back LiveGame on persist fail | Forbidden |
| Subscribers mutate LiveGame to “fix” persist | Forbidden |

## Consequences

- Publishers finish mutation, then publish; LiveGame eventually stops importing
  PersistenceQueue / ClockScheduler / GameTransport.
- Never Persistence before Projection/Transport; never Scheduler before
  Transport.
- Projection/Transport throw → log; continue persist + schedule (non-fatal;
  reconnect / `serverSync` recovers).
- Persist fail → DirtyGame path; RAM stays authoritative.
- Until implementation phase is approved, Phase 5+ continues against current
  call sites.

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Decoupled extensibility | Sync bus: slow handlers add publish latency |
| Wire isolation via Projection | Dual-write migration window (M0–M5) |
| Ordered Projection → Persist → Schedule | No bus-level retries |
| Frozen design clarity | Extract blocked until separate approval |

## Future work

Migration (behavior-preserving), when implementation is approved:

1. **M0** — EventBus + DomainEvent types (incl. `origin`); no publishers
2. **M1** — Dual-write publish alongside existing emit/persist/schedule
3. **M2** — ProjectionSubscriber → GameTransport; remove direct io
4. **M3** — Persistence (+ DirtyGame) + Scheduler into subscribers
5. **M4** — Timeout / Abandon finalize via events
6. **M5** — Remove dual-write

Also deferred: optional `correlationId` / `causationEventId` / `actorUserId`;
Analytics / Replay / Spectator / notifications / anti-cheat / tournament
subscribers; Recovery-origin dirty flush across crash.
