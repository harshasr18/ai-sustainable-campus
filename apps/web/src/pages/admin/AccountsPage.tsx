/**
 * Account administration (§11).
 *
 * THE ONE RULE THAT SHAPES THIS PAGE: an admin cannot change their own role or status, and
 * the server refuses it regardless of what the UI offers. So the self-row is rendered with
 * the controls DISABLED AND AN EXPLANATION, not hidden — hiding it would make an operator
 * wonder whether the option exists elsewhere. The endpoint is the authority; this is
 * courtesy.
 *
 * Role changes are the most dangerous operation in the system, so they go through a
 * confirmation that states the consequence in plain words, and the response is read back
 * from the server rather than assumed.
 */

import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AdminUser } from '../../lib/types.js';
import { Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { ConfirmDialog } from '../../components/dialog.js';
import { useToast } from '../../components/toast.js';
import { roleLabel, useSession, type Role } from '../../lib/session.js';

const ROLES: Role[] = ['STUDENT', 'HOD', 'ADMIN'];

export function AccountsPage() {
  const { user: me } = useSession();
  const toast = useToast();

  const [roleFilter, setRoleFilter] = useState('');
  const [pending, setPending] = useState<{ user: AdminUser; role: Role } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | Error | null>(null);

  const users = useAsync(
    (signal) =>
      api.get<{ items: AdminUser[] }>(`/v1/admin/users${roleFilter ? `?role=${roleFilter}` : ''}`, {
        signal,
      }),
    [roleFilter],
  );

  async function changeRole(target: AdminUser, role: Role) {
    setBusy(target.id);
    setActionError(null);
    try {
      await api.patch(`/v1/admin/users/${target.id}/role`, { role });
      toast.success(`${target.displayName} is now ${roleLabel(role).toLowerCase()}.`);
      users.reload();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error('The role change failed.');
      setActionError(error);
      toast.error('The role change was refused.', error.message);
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(target: AdminUser) {
    const next = target.accountStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    setBusy(target.id);
    setActionError(null);
    try {
      await api.patch(`/v1/admin/users/${target.id}/status`, { accountStatus: next });
      toast.success(
        next === 'SUSPENDED' ? `${target.displayName} suspended.` : `${target.displayName} reactivated.`,
      );
      users.reload();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error('The status change failed.');
      setActionError(error);
      toast.error('The status change was refused.', error.message);
    } finally {
      setBusy(null);
    }
  }

  const items = users.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Accounts</h2>
          <p className="page-head__subtitle">
            Roles and access for this campus. Every change here is written to the audit log with the
            value before and after.
          </p>
        </div>
      </div>

      {actionError && (
        <div className="mb-5">
          <InlineAlert variant="error" title="That change was refused">
            {actionError.message}
          </InlineAlert>
        </div>
      )}

      <div className="filter-bar">
        <div className="field">
          <label className="field__label" htmlFor="u-role">
            Show
          </label>
          <select
            id="u-role"
            className="select"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
          >
            <option value="">Everyone</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role)}
              </option>
            ))}
          </select>
        </div>
        <span className="small muted" style={{ marginLeft: 'auto', paddingBottom: 8 }}>
          {items.length} account{items.length === 1 ? '' : 's'}
        </span>
      </div>

      <Card flush>
        {users.error ? (
          <ErrorPane error={users.error} onRetry={users.reload} />
        ) : users.loading && !users.data ? (
          <SkeletonRows rows={5} />
        ) : items.length === 0 ? (
          <EmptyPane icon="⌕" title="No accounts match" text="Try a different filter." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Department</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const isSelf = row.id === me?.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        {row.displayName}
                        {isSelf && (
                          <span className="badge badge--neutral" style={{ marginLeft: 8 }}>
                            You
                          </span>
                        )}
                      </td>
                      <td className="mono small">{row.email}</td>
                      <td className="small">{row.department ?? <span className="muted">—</span>}</td>
                      <td>
                        <select
                          className="select"
                          value={row.role}
                          disabled={isSelf || busy === row.id}
                          onChange={(event) => setPending({ user: row, role: event.target.value as Role })}
                          aria-label={`Role for ${row.displayName}`}
                          title={
                            isSelf
                              ? 'You cannot change your own role. The server refuses it independently of this control.'
                              : undefined
                          }
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {roleLabel(role)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {row.accountStatus === 'ACTIVE' ? (
                          <span className="badge badge--resolved">Active</span>
                        ) : (
                          <span className="badge badge--danger">Suspended</span>
                        )}
                      </td>
                      <td className="table__actions">
                        <button
                          type="button"
                          className={`btn btn--sm ${row.accountStatus === 'ACTIVE' ? 'btn--danger' : 'btn--secondary'}`}
                          disabled={isSelf || busy === row.id}
                          title={
                            isSelf
                              ? 'You cannot suspend your own account. The server refuses it independently of this control.'
                              : undefined
                          }
                          onClick={() => void changeStatus(row)}
                        >
                          {busy === row.id
                            ? 'Working…'
                            : row.accountStatus === 'ACTIVE'
                              ? 'Suspend'
                              : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="small muted mt-4">
        Your own row is disabled because the server will not let an admin change their own role or
        status — a deliberate guard against privilege escalation, and one this page cannot bypass.
      </p>

      {pending && (
        <ConfirmDialog
          title={`Make ${pending.user.displayName} a ${roleLabel(pending.role).toLowerCase()}?`}
          destructive={pending.role === 'ADMIN'}
          confirmLabel="Change the role"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const target = pending;
            setPending(null);
            void changeRole(target.user, target.role);
          }}
        >
          <p className="mb-0">
          {
            pending.role === 'ADMIN'
              ? 'An administrator can change roles, manage campus locations and read every report in this workspace. This is the widest level of access the system has.'
              : pending.role === 'HOD'
                ? 'A head of department can approve, action and resolve issues, confirm severity, correct categories, and validate reports — which awards tokens.'
                : 'A student can submit reports and see only their own. They cannot see the campus queue or any other student’s photographs.'
          }
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
