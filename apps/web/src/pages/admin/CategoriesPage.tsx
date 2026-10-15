/**
 * Issue categories (§11).
 *
 * WHY THIS PAGE MATTERS MORE THAN IT LOOKS. A category is not just a label: it is half of the
 * dedupe key (`spot + category`), and it is the vocabulary the AI model is asked to choose
 * from. Adding a category with a vague name or a description that does not describe what the
 * fault LOOKS like degrades duplicate detection and the model's predictions at the same time.
 * So the form asks for a description and says why.
 *
 * CREATION ONLY. `POST /v1/admin/categories` exists; there is no PATCH, so a category cannot
 * be renamed or deactivated through the API. That is stated plainly rather than hidden behind
 * a disabled control, because an operator who needs to retire a category needs to know it is
 * a backend gap and not a UI oversight.
 *
 * The categories list is global rather than workspace-scoped (`issue_categories` has no
 * `workspace_id`), which is why DEMO and REAL share it — worth knowing when editing.
 */

import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Category, Paginated } from '../../lib/types.js';
import { Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { Modal } from '../../components/dialog.js';
import { useToast } from '../../components/toast.js';
import { formatCount } from '../../lib/format.js';

export function CategoriesPage() {
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  // `includeInactive` is not accepted by this route; the response is the active set, which is
  // what the reporting flow offers.
  const categories = useAsync(
    (signal) => api.get<Paginated<Category>>('/v1/campus/categories', { signal }),
    [],
  );

  const items = categories.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Issue categories</h2>
          <p className="page-head__subtitle">
            The list a student chooses from, and the vocabulary the AI model predicts over.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          Add a category
        </button>
      </div>

      <div className="mb-5">
        <InlineAlert variant="info" title="How a category is used">
          Every category here becomes a candidate label for the vision model, and the category a
          student picks combines with the spot to form the duplicate key. Two reports at the same
          spot in the same category are treated as one defect, so a category that is too broad will
          merge genuinely different problems.
        </InlineAlert>
      </div>

      {categories.error ? (
        <ErrorPane error={categories.error} onRetry={categories.reload} />
      ) : categories.loading && !categories.data ? (
        <SkeletonRows rows={5} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyPane
            icon="▦"
            title="No categories configured"
            text="A student cannot file a report without choosing a category, so this list must not be empty."
            action={
              <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                Add the first category
              </button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Slug</th>
                  <th scope="col">What it covers</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((category) => (
                  <tr key={category.id}>
                    <td className="strong">{category.name}</td>
                    <td className="mono small">{category.slug}</td>
                    <td className="small">
                      {category.description ?? <span className="muted">No description recorded</span>}
                    </td>
                    <td>
                      {category.active ? (
                        <span className="badge badge--resolved">Active</span>
                      ) : (
                        <span className="badge badge--danger">Inactive</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="small muted mt-4">
        {formatCount(items.length)} categor{items.length === 1 ? 'y' : 'ies'}. Renaming or
        deactivating a category has no endpoint — <span className="mono">POST /v1/admin/categories</span>
        {' '}is creation-only — so this page offers creation and nothing that would fail.
      </p>

      {creating && (
        <CategoryModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Category created.');
            categories.reload();
          }}
        />
      )}
    </>
  );
}

function CategoryModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  function slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/admin/categories', {
        name: name.trim(),
        slug: slug.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('The category could not be created.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add an issue category"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0 || slug.trim().length === 0}
          >
            {busy ? 'Creating…' : 'Create category'}
          </button>
        </>
      }
    >
      <div className="stack stack--4">
        <div className="field">
          <label className="field__label" htmlFor="c-name">
            Name
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="c-name"
            className="input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSlug(slugify(event.target.value));
            }}
            placeholder="For example: Broken furniture"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="c-slug">
            Slug
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="c-slug"
            className="input mono"
            value={slug}
            onChange={(event) => setSlug(slugify(event.target.value))}
            placeholder="broken-furniture"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="c-desc">
            What it covers
          </label>
          <textarea
            id="c-desc"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="For example: damaged desks, chairs, cupboards or benches."
          />
          <p className="field__hint">
            This description is fed to the vision model alongside the category name, so describe what
            the problem <em>looks like</em> in a photograph. It is not shown to students as guidance.
          </p>
        </div>

        {error && (
          <InlineAlert variant="error" title="Could not create the category">
            {error.message}
          </InlineAlert>
        )}
      </div>
    </Modal>
  );
}
