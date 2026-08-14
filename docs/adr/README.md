# Architecture Decision Records — Live Multiplayer

Permanent project documentation for ChessOnes live-human multiplayer
architecture decisions. These ADRs capture **why** the system is shaped as it
is; they do not authorize implementation by themselves.

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](./ADR-001-livegame-actor.md) | LiveGame Actor | Accepted |
| [ADR-002](./ADR-002-livegame-manager.md) | LiveGameManager | Accepted |
| [ADR-003](./ADR-003-server-authoritative-clocks.md) | Server Authoritative Clocks | Accepted |
| [ADR-004](./ADR-004-persistence-queue.md) | PersistenceQueue | Accepted |
| [ADR-005](./ADR-005-live-move-protocol.md) | Live Move Protocol | Accepted |
| [ADR-006](./ADR-006-game-transport.md) | GameTransport | Accepted (implemented) |
| [ADR-007](./ADR-007-domain-events.md) | Domain Events | Accepted (implemented) |

## Scope

- Applies to **live-human** games (`type` multiplayer | friend).
- Bot / pass-play paths remain Mongo-authoritative and out of LiveGame scope.
- ADR-003 flags (`LIVE_MEMORY_SNAPSHOT`, `LIVE_SERVER_TIMEOUTS`) default **ON** in
  production (`NODE_ENV=production`); other live flags stay **OFF** until rollout.

### Clock contract v1 (socket / HTTP)

Clients treat these as display-only / soft-claim inputs — never invent terminal state:

| Field | Where |
|-------|--------|
| `serverNow` | `ready:update`, `move-made`, `game-ended`, GET game, 409 sync |
| `clockStartedAt` | `ready:update` (allReady), GET game |
| `timeRemaining` | same as `serverNow` |
| `syncVersion` / `ply` | `move-made`, GET game, terminal 409 |

## Related documents

- [Architecture Test Plan](../ARCHITECTURE_TEST_PLAN.md) — permanent QA contract
  (invariants, expected behavior, integration / regression / concurrency /
  failure tests per ADR). Update that plan in the same change as any ADR
  revision.

## Related design canvases

Design canvases under the Cursor project are complementary detail; ADRs are the
permanent decision record. Do not treat canvas edits as ADR amendments unless
an ADR is explicitly revised.

## Conventions

Each ADR includes: Context, Decision, Alternatives considered, Consequences,
Trade-offs, Future work.

Status values: **Accepted**, **Accepted (design)** (approved, extract not yet
landed), **Superseded**, **Deprecated**.
