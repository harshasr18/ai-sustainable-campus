/**
 * Real-time event adapter — TRANSPORT-INDEPENDENT.
 *
 * Brief Section 12: "Define a common event interface independent of the transport.
 * Publish events only after committed database transactions. Use an outbox... Do not
 * use a frontend-only timer or mock events as a substitute for real synchronization."
 *
 * STATUS, STATED PLAINLY: there is NO WebSocket or SSE endpoint in Phase 1 and none
 * is claimed to work. What exists is the durable half that cannot be bolted on later:
 * events are written to `event_outbox` INSIDE the same transaction as the state
 * change, so a committed change can never lack its event and a rolled-back change can
 * never emit one. Phase 2 attaches a delivery transport to `drainOutbox`.
 *
 * Every consumer must scope by `workspace`: an event carries the workspace it belongs
 * to, and a subscriber may only ever receive its own (see eventBelongsToWorkspace).
 */
import { EventEnvelopeSchema, type EventEnvelope, type EventType } from '@campus/contracts';
import { outbox as outboxRepo, type Conn } from '@campus/db';

/**
 * What a caller supplies when publishing. `workspaceId` routes the durable outbox row
 * (and therefore every future subscriber); `workspace` is the kind carried in the
 * envelope so a consumer can assert it never received foreign data.
 */
export interface PublishInput {
  eventType: EventType;
  /** Required: the outbox row is scoped by it. Never derived from client input. */
  workspaceId: string;
  workspace: 'REAL' | 'DEMO';
  entityType: 'REPORT' | 'ISSUE' | 'TOKEN_TRANSACTION';
  entityId: string;
  entityVersion: number;
  actorUserId: string | null;
  payload: Record<string, unknown>;
}

export interface EventPublisher {
  /** Called INSIDE a transaction. Must not perform I/O outside the DB. */
  publish(tx: Conn, event: PublishInput): Promise<void>;
}

/**
 * Transactional-outbox publisher. The only implementation used by the application.
 */
export class OutboxEventPublisher implements EventPublisher {
  async publish(tx: Conn, event: PublishInput): Promise<void> {
    await outboxRepo.enqueue(tx, {
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      entityVersion: event.entityVersion,
      actorUserId: event.actorUserId,
      payload: event.payload,
    });
  }
}

export const outboxPublisher = new OutboxEventPublisher();

/** In-memory fan-out used by tests to assert what WOULD be delivered. */
export class RecordingEventPublisher implements EventPublisher {
  readonly events: { eventType: EventType; entityId: string; payload: Record<string, unknown> }[] = [];
  constructor(private readonly inner: EventPublisher = outboxPublisher) {}

  async publish(tx: Conn, event: PublishInput): Promise<void> {
    this.events.push({ eventType: event.eventType, entityId: event.entityId, payload: event.payload });
    await this.inner.publish(tx, event);
  }
}

export interface DrainResult {
  delivered: EventEnvelope[];
}

/**
 * Reads undelivered events and marks them published. Phase 2 wraps this in a poller
 * (or LISTEN/NOTIFY trigger) and pushes each envelope to subscribed clients.
 *
 * `asEnvelope` re-validates the stored payload through the shared schema, so a
 * malformed event fails at the boundary instead of corrupting every subscriber.
 */
export async function drainOutbox(
  tx: Conn,
  workspaceId: string,
  limit = 100,
): Promise<DrainResult> {
  const rows = await outboxRepo.pending(tx, workspaceId, limit);
  const delivered: EventEnvelope[] = [];
  const ids: string[] = [];

  for (const row of rows as Record<string, unknown>[]) {
    const envelope = EventEnvelopeSchema.parse({
      eventId: row.id,
      eventType: row.event_type,
      occurredAt: new Date(row.occurred_at as string).toISOString(),
      workspace: workspaceId, // replaced by the caller with the real kind when broadcasting
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityVersion: row.entity_version,
      actorUserId: row.actor_user_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    });
    delivered.push(envelope);
    ids.push(row.id as string);
  }

  await outboxRepo.markPublished(tx, ids);
  return { delivered };
}

/**
 * Authorization rule for subscribers, stated as code so it cannot be forgotten:
 * a client may only receive events for the workspace its session belongs to.
 */
export function eventBelongsToWorkspace(event: EventEnvelope, sessionWorkspace: 'REAL' | 'DEMO'): boolean {
  return event.workspace === sessionWorkspace;
}
