/**
 * System state (§11) — what this deployment actually is right now.
 *
 * THE POINT OF THIS PAGE is that an operator should be able to answer "is the AI running, is
 * the event transport live, what has the system refused to do?" without reading source code or
 * taking anyone's word for it. Every value is a real response from a real endpoint:
 *
 *   GET /v1/admin/ai/status      what model is configured (or that none is)
 *   GET /v1/events/types         the event vocabulary and the transport mode
 *   GET /v1/admin/outbox         undelivered events, and any that failed
 *   GET /v1/admin/audit          the sensitive-action log
 *
 * THE HONESTY RULES FROM §11 AND THE PHASE 2 BRIEF APPLY HERE MORE THAN ANYWHERE.
 *   - The AI card reports `configured: false` when no provider is set. It never says "AI
 *     ready" or shows a confidence figure for a model that has not run.
 *   - The transport card reports `NOT_IMPLEMENTED` and the page explains that this means
 *     polling the durable outbox, not live streaming. It does not call anything "live" or
 *     "real-time" — the Phase 2 rule forbids claiming synchronization was tested when the
 *     transport does not exist.
 *   - Failed events are shown in full. A silent failure count is worse than no count.
 */

import { api } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AiStatus, AuditEntry, EventTypeContract, Paginated } from '../../lib/types.js';
import { Card, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { AiTag } from '../../components/badges.js';
import { formatConfidence, formatCount, formatDateTime } from '../../lib/format.js';

interface OutboxEvent {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  occurredAt: string;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
}

export function SystemPage() {
  const ai = useAsync((signal) => api.get<AiStatus>('/v1/admin/ai/status', { signal }), []);
  const events = useAsync((signal) => api.get<EventTypeContract>('/v1/events/types', { signal }), []);
  const outbox = useAsync(
    (signal) => api.get<{ items: OutboxEvent[] } | Paginated<OutboxEvent>>('/v1/admin/outbox', { signal }),
    [],
  );
  const audit = useAsync(
    (signal) => api.get<Paginated<AuditEntry>>('/v1/admin/audit?limit=25', { signal }),
    [],
  );

  const outboxItems = toItems(outbox.data);
  const pendingEvents = outboxItems.filter((event) => !event.publishedAt);
  const failedEvents = pendingEvents.filter((event) => event.attempts > 0 && event.lastError);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">System state</h2>
          <p className="page-head__subtitle">
            Configuration and operational health, read live from the API rather than asserted here.
          </p>
        </div>
      </div>

      <section className="section">
        <StatGrid>
          <StatTile
            label="AI provider"
            value={ai.data ? ai.data.provider : null}
            tone={ai.data && !ai.data.configured ? 'warning' : 'default'}
            foot={ai.data ? (ai.data.configured ? 'Configured' : 'Not configured') : undefined}
          />
          <StatTile
            label="Undelivered events"
            value={outbox.data ? formatCount(pendingEvents.length) : null}
            foot="Waiting in the durable outbox"
          />
          <StatTile
            label="Failed events"
            value={outbox.data ? formatCount(failedEvents.length) : null}
            tone={failedEvents.length > 0 ? 'danger' : 'default'}
            foot={failedEvents.length > 0 ? 'These have been retried and errored' : 'None'}
          />
          <StatTile
            label="Event types declared"
            value={events.data ? formatCount(events.data.eventTypes.length) : null}
          />
        </StatGrid>
      </section>

      <div className="grid-2">
        <Card
          title={
            <>
              AI configuration <AiTag />
            </>
          }
          subtitle="What is actually loaded on this server."
        >
          {ai.error ? (
            <ErrorPane error={ai.error} onRetry={ai.reload} />
          ) : !ai.data ? (
            <SkeletonRows rows={4} />
          ) : (
            <>
              <dl className="dl">
                <dt>Provider</dt>
                <dd className="mono">{ai.data.provider}</dd>
                <dt>Model</dt>
                <dd className="mono">{ai.data.model}</dd>
                <dt>Model version</dt>
                <dd className="mono">{ai.data.modelVersion}</dd>
                <dt>Review threshold</dt>
                <dd>
                  {ai.data.humanReviewConfidenceThreshold}
                  <span className="small muted" style={{ display: 'block' }}>
                    Any analysis scoring below this must be confirmed by a person. It cannot drive an
                    irreversible decision on its own.
                  </span>
                </dd>
                <dt>Severity source</dt>
                <dd className="mono small">{ai.data.severitySource}</dd>
              </dl>

              {!ai.data.configured ? (
                <div className="mt-4">
                  <InlineAlert variant="info" title="No vision model is configured">
                    <code className="mono">AI_PROVIDER</code> is set to{' '}
                    <code className="mono">unconfigured</code>, so{' '}
                    <code className="mono">POST /v1/reports/:id/analyze</code> answers 501 and no
                    report receives a prediction. That is a deliberate, honest boundary rather than a
                    failure: nothing is guessed, and no confidence value is invented to fill the gap.
                    See <span className="mono">docs/AI_MODEL.md</span> for how to enable the local
                    model.
                  </InlineAlert>
                </div>
              ) : (
                <div className="mt-4">
                  <InlineAlert variant="warning" title="About the confidence figure">
                    The model's score is a ranking value, not a calibrated probability. It is useful
                    for ordering and for flagging ambiguity, and it is not evidence that a prediction
                    is correct. Accuracy has not been proven: the fixture set is small and synthetic.
                  </InlineAlert>
                </div>
              )}

              <p className="small muted mt-4 mb-0">
                Severity from the model is stored on the report, separately from the operational
                severity a person confirms on the issue. The two are never merged.
                {ai.data.severitySource !== 'IMPLEMENTED' && (
                  <>
                    {' '}The value above records that the automated severity stage is{' '}
                    <strong>not implemented</strong> — Phase 2 Stage 6 — so no AI severity is being
                    produced at all today.
                  </>
                )}
              </p>
            </>
          )}
        </Card>

        <Card
          title="Event transport"
          subtitle="How changes reach other systems."
          action={
            <a className="btn btn--secondary btn--sm" href="/v1/events/stream" target="_blank" rel="noreferrer">
              Try the stream
            </a>
          }
        >
          {events.error ? (
            <ErrorPane error={events.error} onRetry={events.reload} />
          ) : !events.data ? (
            <SkeletonRows rows={3} />
          ) : (
            <>
              <dl className="dl">
                <dt>Delivery mode</dt>
                <dd className="mono">{events.data.deliveryMode}</dd>
                <dt>Live transport</dt>
                <dd>
                  <span className="mono">{events.data.liveTransport}</span>
                  <span className="small muted" style={{ display: 'block' }}>
                    Not an error: the live transport is not implemented, so{' '}
                    <code className="mono">/v1/events/stream</code> answers 501 by design. Events are
                    durable — they are written to the outbox inside the same transaction as the change
                    that produced them.
                  </span>
                </dd>
              </dl>

              <div className="mt-4">
                <InlineAlert variant="info" title="Do not describe this as live">
                  No WebSocket or server-sent-events transport exists yet, so nothing on this
                  deployment pushes updates in real time and no end-to-end delivery has been tested.
                  The outbox is the record of truth: the counts above come from polling it, and the
                  stream button will return 501.
                </InlineAlert>
              </div>

              <h3 className="section__title mt-5">Declared event types</h3>
              <ul className="plain-list small">
                {events.data.eventTypes.map((type) => (
                  <li key={type}>
                    <span className="mono">{type}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <section className="section">
        <Card
          title="Undelivered events"
          subtitle="Written inside the transaction that made the change. This list is the backlog."
          flush
        >
          {outbox.error ? (
            <ErrorPane error={outbox.error} onRetry={outbox.reload} />
          ) : outbox.loading && !outbox.data ? (
            <SkeletonRows rows={4} />
          ) : outboxItems.length === 0 ? (
            <EmptyPane
              icon="✓"
              title="The outbox is empty"
              text="Every event produced so far has been delivered, so there is nothing waiting."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Occurred</th>
                    <th scope="col" className="table__num">
                      Attempts
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {outboxItems.slice(0, 50).map((event) => (
                    <tr key={event.id}>
                      <td className="mono small">{event.eventType}</td>
                      <td className="small">
                        {event.entityType}
                        <div className="mono muted" style={{ fontSize: 11 }}>
                          {event.entityId.slice(0, 8)}…
                        </div>
                      </td>
                      <td className="small nowrap">{formatDateTime(event.occurredAt)}</td>
                      <td className="table__num">{event.attempts}</td>
                      <td className="small">
                        {event.publishedAt ? (
                          <span className="badge badge--resolved">Delivered</span>
                        ) : event.lastError ? (
                          <>
                            <span className="badge badge--danger">Failed</span>
                            <div className="small muted">{event.lastError}</div>
                          </>
                        ) : (
                          <span className="badge badge--progress">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <section className="section">
        <Card
          title="Recent sensitive actions"
          subtitle="Who changed what, with the value before and after."
          flush
        >
          {audit.error ? (
            <ErrorPane error={audit.error} onRetry={audit.reload} />
          ) : audit.loading && !audit.data ? (
            <SkeletonRows rows={5} />
          ) : (audit.data?.items.length ?? 0) === 0 ? (
            <EmptyPane icon="⌘" title="No audited actions yet" text="Role changes, credential changes and other sensitive operations appear here." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Before → after</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data!.items.map((entry) => (
                    <tr key={entry.id}>
                      <td className="small nowrap">{formatDateTime(entry.createdAt)}</td>
                      <td className="small">{entry.actorDisplayName ?? <span className="muted">system</span>}</td>
                      <td className="mono small">{entry.action}</td>
                      <td className="small">
                        {entry.entityType}
                        {entry.entityId && (
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            {entry.entityId.slice(0, 8)}…
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <Delta before={entry.beforeState} after={entry.afterState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <p className="small muted mt-4">
        Confidence display helper available for future analysis panels:{' '}
        <span className="mono">{formatConfidence(null)}</span> when a score is absent — a missing
        score is rendered as an em dash, never as zero.
      </p>
    </>
  );
}

/** The outbox route returns either `{items}` or a paginated envelope; accept both. */
function toItems(data: { items: OutboxEvent[] } | Paginated<OutboxEvent> | null): OutboxEvent[] {
  if (!data) return [];
  return Array.isArray(data.items) ? data.items : [];
}

/** Renders the before/after state of an audit row without dumping raw JSON into the table. */
function Delta({ before, after }: { before: unknown; after: unknown }) {
  const summarise = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value !== 'object') return String(value);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '—';
    return entries.map(([key, val]) => `${key}: ${val === null ? 'none' : String(val)}`).join(', ');
  };

  return (
    <span>
      <span className="muted">{summarise(before)}</span>
      {' → '}
      <strong>{summarise(after)}</strong>
    </span>
  );
}
