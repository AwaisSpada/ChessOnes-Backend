# ADR-005: Live Move Protocol

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 4 (+ five protocol amendments)
- **Flag:** `LIVE_WS_MOVES` (hard dep: Phase 2; Phase 3 recommended before 4)

## Context

Socket `make-move` was an unvalidated client relay — unsafe for production
authority. HTTP moves worked but added RTT. Clients need Chess.com / Lichess
style command + ack/reject, stale-ply recovery, and safe dual-path migration
while HTTP remains available.

## Decision

Authenticated WebSocket command pipeline over LiveGame:

| Direction | Events |
|-----------|--------|
| Client → server | `live:move`, `live:sync` |
| Server → mover | `moveAccepted`, `moveRejected` |
| Server → room | `move-made` (existing name preserved) |
| Server → client | `serverSync`; existing `game:snapshot` / `game:sync` |

HTTP `POST /move` remains a compatibility adapter through the same MoveProcessor.

**Required client fields:** `requestId`, `clientPly`, `clientSequence`
(monotonic per player; advance on new `requestId`; retries may repeat sequence
with the same `requestId`).

**Required server fields:** `serverEventId` on every authoritative outbound
live-layer event; `recoverable` on `moveRejected`.

**Idempotency:** `(gameId, requestId)` for a bounded window — no second apply;
re-send original outcome.

**Client ACK timeout (docs):** `ackTimeoutMs = clamp(2.5 × ewmaRttMs, 1500, 8000)`.

When flag ON: disable unvalidated `make-move` relay. Clients never broadcast
`move-made`. Server is sole authority; client optimism commits only on accept
or matching fan-out. Seat from `LiveGame.players` — never trust client color.

Processing: `getOrHydrate` → serialized `applyMove` → room `move-made` → mover
`moveAccepted` → persist / reschedule.

Client ordering: apply if `syncVersion === last + 1`, else full replace on
`serverSync`; on gap, sync — do not apply out of order. One in-flight
`requestId` per game; never rotate id on auto-retry.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Keep unvalidated `make-move` relay | Rejected |
| Binary / protobuf frames | Deferred |
| Redis pub/sub as part of this protocol | Deferred (GameTransport / Phase 6) |
| Premoves as server-side queue | Deferred — client-only until later |
| Breaking rename of `move-made` | Rejected |
| Require new `requestId` on transport retries | Rejected — breaks idempotency |
| Prefer HTTP when WS is on | Rejected — prefer WS; HTTP for FLAG_OFF / WS down |

## Consequences

- Dual HTTP + WS requires lock + `clientPly` + dedupe; clients must not
  double-send the same move on both paths.
- Mobile / clients must implement ack/reject/sync or remain on HTTP until ready.
- Ack loss on disconnect is recovered via idempotent replay / ply check /
  `serverSync`.
- Recommended enablement after `LIVE_MEMORY_SNAPSHOT` + `LIVE_HTTP_VIA_MANAGER`
  (+ `LIVE_SERVER_TIMEOUTS`) proven.

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Lower command RTT; correlated ack/reject | Protocol + client complexity |
| Safe dual-path migration | Dual-send bugs if clients misbehave |
| Additive wire (`move-made` kept) | Two mental models until HTTP fades |
| Idempotent retries | Bounded dedupe memory / TTL tuning |

## Future work

- Optional `requestId` on HTTP.
- Per-socket Lichess-style ack counters.
- Optional full board on accept (additive only).
- Route pipeline emits through Projection → GameTransport / Domain Events
  (ADR-006, ADR-007) when those extracts land.
