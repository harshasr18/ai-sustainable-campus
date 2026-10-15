/**
 * Tokens and ledger history (§9).
 *
 * THE RULE THIS PAGE EXISTS TO HONOUR: "Never calculate or award authoritative tokens solely
 * in frontend code."
 *
 * So the balance shown is the number the server returned, verbatim. There is no local
 * arithmetic over the transaction list, no optimistic increment after a submission, and no
 * running total kept in state. If the ledger and the balance ever disagreed, this page would
 * show the discrepancy rather than resolve it silently — the ledger is the authority and the
 * UI's job is to report, not to reconcile.
 *
 * Reversals are displayed because they are part of the record, not hidden as an embarrassment.
 * §9 asks for exactly that.
 */

import { Link } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Paginated, TokenBalance, TokenTransaction } from '../../lib/types.js';
import { Card, Pagination, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { formatCount, formatDateTime } from '../../lib/format.js';
import { useState } from 'react';

const PAGE_SIZE = 25;

export function TokensPage() {
  const [offset, setOffset] = useState(0);

  const balance = useAsync((signal) => api.get<TokenBalance>('/v1/tokens/balance', { signal }), []);
  const transactions = useAsync(
    (signal) =>
      api.get<Paginated<TokenTransaction>>(
        `/v1/tokens/transactions${query({ limit: PAGE_SIZE, offset })}`,
        { signal },
      ),
    [offset],
  );

  const items = transactions.data?.items ?? [];
  const total = transactions.data?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">My tokens</h2>
          <p className="page-head__subtitle">
            Ten tokens for every report the server validates — including reports merged into an
            existing repair ticket, because the effort was still real.
          </p>
        </div>
      </div>

      {balance.error ? (
        <ErrorPane error={balance.error} onRetry={balance.reload} />
      ) : (
        <section className="section">
          <div className="card" style={{ padding: 'var(--space-6)' }}>
            <div className="token-hero">
              <div>
                <p className="stat__label">Current balance</p>
                <p className="token-hero__value">
                  {balance.data ? formatCount(balance.data.balance) : '—'}
                  <span className="token-hero__unit"> tokens</span>
                </p>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <StatGrid>
                  <StatTile
                    label="Lifetime credited"
                    value={balance.data ? formatCount(balance.data.lifetimeCredited) : null}
                  />
                  <StatTile
                    label="Reversed"
                    value={balance.data ? formatCount(balance.data.lifetimeReversed) : null}
                    tone={balance.data && balance.data.lifetimeReversed > 0 ? 'warning' : 'default'}
                  />
                </StatGrid>
              </div>
            </div>

            <p className="small muted mt-4 mb-0">
              Balance is the sum of the ledger below, computed by the server. This page does not
              calculate it.
            </p>
          </div>
        </section>
      )}

      {balance.data && balance.data.lifetimeReversed > 0 && (
        <div className="mb-5">
          <InlineAlert variant="warning" title="Some credits were reversed">
            A reversal means staff withdrew a previously awarded credit. Every reversal requires a
            recorded reason, shown against the entry below.
          </InlineAlert>
        </div>
      )}

      <Card title="Transaction history" subtitle="Every credit and reversal on your account." flush>
        {transactions.error ? (
          <ErrorPane error={transactions.error} onRetry={transactions.reload} />
        ) : transactions.loading && !transactions.data ? (
          <SkeletonRows rows={5} />
        ) : items.length === 0 ? (
          <EmptyPane
            icon="◎"
            title="No token activity yet"
            text="Your first credit appears once a report you submitted has been validated. You will get 10 tokens for it."
            action={
              <Link to="/student/report" className="btn btn--primary">
                Report an issue
              </Link>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Recorded</th>
                    <th scope="col">Type</th>
                    <th scope="col">Report</th>
                    <th scope="col">Reason</th>
                    <th scope="col" className="table__num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((transaction) => (
                    <tr key={transaction.id}>
                      <td className="nowrap">{formatDateTime(transaction.createdAt)}</td>
                      <td>
                        {transaction.transactionType === 'CREDIT' ? (
                          <span className="badge badge--resolved">Credit</span>
                        ) : (
                          <span className="badge badge--danger">Reversal</span>
                        )}
                      </td>
                      <td>
                        {transaction.reportId ? (
                          <Link
                            to={`/student/reports/${transaction.reportId}`}
                            className="mono"
                          >
                            {transaction.reportId.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        {transaction.reason ?? <span className="muted">Report validated</span>}
                      </td>
                      <td className="table__num">
                        <span
                          className={
                            transaction.transactionType === 'CREDIT' ? 'amount--credit' : 'amount--debit'
                          }
                        >
                          {transaction.transactionType === 'CREDIT' ? '+' : '−'}
                          {transaction.amount}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={total}
              limit={PAGE_SIZE}
              offset={offset}
              onChange={setOffset}
              busy={transactions.refreshing}
            />
          </>
        )}
      </Card>

      <p className="small muted mt-4">
        Each entry carries a server-generated idempotency key, so a retried request can never
        credit the same report twice. See <span className="mono">docs/API.md</span> for the ledger
        contract.
      </p>
    </>
  );
}
