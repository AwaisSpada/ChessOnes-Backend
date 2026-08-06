# ADR-006: GameTransport

- **Status:** Accepted (implemented)
- **Date:** 2026-08-06
- **Phases:** Extracted; Redis / cluster plug-in Phase 6+
- **Flag:** `LIVE_TRANSPORT` (`socket` | `testing`; redis falls back to socket)

## Context

Live mutation paths call Socket.IO (`io.to(...).emit`) directly from pipeline,
timeout, and abandon code. Scaling out, testing without a real socket server,
and swapping delivery (Redis fan-out, replay) would require hunting every emit
site. Delivery was conflated with authority.

## Decision

Introduce a **GameTransport** abstraction: game logic emits domain outcomes;
transport delivers. LiveGame / move pipeline / Timeout / Abandon **must not**
call Socket.IO directly after extract.

Fire-and-forget methods:

- `emitMoveMade`
- `emitMoveAccepted`
- `emitMoveRejected`
- `emitServerSync`
- `emitGameEnded`
- `emitConnectionStatus`

**Addressing:** `gameId` room; prefer `userId` for ack after reconnect;
optional `socketRef` for low-latency ack.

**Implementations:**

| Impl | Role |
|------|------|
| SocketIOTransport | Current behavior, behavior-identical extract |
| RedisTransport / ClusterTransport | Phase 6+ fan-out |
| ReplayTransport | Forensics |
| TestingTransport | Assert order without Socket.IO |

Boot via `createGameTransport(env)`.

**Not transport’s job:** legality, clocks, flag/abandon, Mongo, auth,
matchmaking, or LiveGame mutation authority.

With Domain Events (ADR-007): **Domain Events → Projection → GameTransport**.
Do not pass raw LiveGame references to sockets.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Keep direct `io.emit` forever | Rejected for scale/testability |
| Transport owns legality / clocks / persist | Explicitly rejected |
| Transport owns LiveGame mutation / sharding | Rejected — sticky/shard separate from delivery |
| Implement extract immediately without approval | Deferred — design-only until extract PR |
| Solve multi-instance authority via transport alone | Rejected — Phase 6 shared live store separate |

## Consequences

- Delivery ≠ authority. LiveGame stays process-local (or later sharded by
  `gameId`).
- Wire event → method mapping is fixed and stable for clients.
- Phase 5 reconnect presence should target GameTransport once extracted.
- Until extract lands, call sites remain direct Socket.IO (accepted interim).

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Swap delivery without rewriting mutations | Extra indirection |
| TestingTransport for order assertions | Design debt until PR lands |
| Clear public vs internal boundary | Redis fan-out without shared LiveGame still needs sticky/shard |

## Future work

- Behavior-identical SocketIOTransport extract (Phase 5 or Phase 6 prep).
- Redis / Cluster behind flag in Phase 6 addendum.
- ReplayTransport; spectator throttling via Projection.
- Wire all emits through Projection once ADR-007 is implemented.
