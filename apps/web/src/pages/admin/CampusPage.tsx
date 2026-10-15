/**
 * Campus locations (§11) — blocks and the named spots inside them.
 *
 * THE ENDPOINT SHAPE FORCES A DESIGN DECISION. Blocks are listed by `/v1/campus/blocks`, and
 * SPOTS are only reachable per-block at `/v1/campus/blocks/:id/spots`. There is no
 * "all spots" route, so this page loads spots LAZILY, one block at a time, and expands a
 * block on demand. Fetching spots for every block on mount would be one request per block
 * against an endpoint that was deliberately built per-block.
 *
 * WHAT THE API DOES NOT SUPPORT. `POST /v1/admin/blocks` creates, and
 * `PATCH /v1/admin/blocks/:id` updates, but there is no DELETE for either and no PATCH for a
 * spot. So this page offers creation and block editing, and marks deactivation as unavailable
 * rather than leaving a button that would 404. Deactivating is what the `active` column is
 * for; the route to set it just does not exist yet.
 *
 * COORDINATES ARE OPTIONAL AND HONEST. A spot may have no latitude/longitude. When it does
 * not, the page says "not recorded" — it never invents a position, and the 3D twin lays
 * unmapped spots out schematically and labels them as such.
 */

import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Block, Paginated, Spot } from '../../lib/types.js';
import { Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { Modal } from '../../components/dialog.js';
import { useToast } from '../../components/toast.js';

export function CampusPage() {
  const toast = useToast();
  const [creatingBlock, setCreatingBlock] = useState(false);
  const [editingBlock, setEditingBlock] = useState<Block | null>(null);
  const [addingSpotTo, setAddingSpotTo] = useState<Block | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const blocks = useAsync(
    (signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }),
    [],
  );

  const items = blocks.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Campus locations</h2>
          <p className="page-head__subtitle">
            A report is filed against a block and a named spot. Those two ids are what the duplicate
            check keys on, so getting them right is what makes merging work.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreatingBlock(true)}>
          Add a block
        </button>
      </div>

      <div className="mb-5">
        <InlineAlert variant="info" title="Two operations are not available on this API">
          Deleting a block or spot, and editing a spot after it exists, have no endpoints. Blocks can
          be marked inactive through <span className="mono">PATCH /v1/admin/blocks/:id</span>; spots
          have only a create route today. Nothing here pretends otherwise.
        </InlineAlert>
      </div>

      {blocks.error ? (
        <ErrorPane error={blocks.error} onRetry={blocks.reload} />
      ) : blocks.loading && !blocks.data ? (
        <SkeletonRows rows={5} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyPane
            icon="▦"
            title="No blocks configured"
            text="Add the first campus block, then add the named spots inside it."
            action={
              <button type="button" className="btn btn--primary" onClick={() => setCreatingBlock(true)}>
                Add a block
              </button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table table--interactive">
              <thead>
                <tr>
                  <th scope="col">Block</th>
                  <th scope="col">Slug</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((block) => (
                  <tr key={block.id}>
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setExpanded(expanded === block.id ? null : block.id)}
                        aria-expanded={expanded === block.id}
                      >
                        {expanded === block.id ? '▾' : '▸'} {block.officialName}
                      </button>
                      {block.description && (
                        <div className="small muted">{block.description}</div>
                      )}
                      {expanded === block.id && <SpotList blockId={block.id} />}
                    </td>
                    <td className="mono small">{block.slug}</td>
                    <td>
                      {block.active ? (
                        <span className="badge badge--resolved">Active</span>
                      ) : (
                        <span className="badge badge--danger">Inactive</span>
                      )}
                    </td>
                    <td className="table__actions">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setEditingBlock(block)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setAddingSpotTo(block)}
                      >
                        Add spot
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creatingBlock && (
        <BlockModal
          onClose={() => setCreatingBlock(false)}
          onDone={() => {
            setCreatingBlock(false);
            toast.success('Block created.');
            blocks.reload();
          }}
        />
      )}

      {editingBlock && (
        <BlockModal
          block={editingBlock}
          onClose={() => setEditingBlock(null)}
          onDone={() => {
            setEditingBlock(null);
            toast.success('Block updated.');
            blocks.reload();
          }}
        />
      )}

      {addingSpotTo && (
        <SpotModal
          block={addingSpotTo}
          onClose={() => setAddingSpotTo(null)}
          onDone={() => {
            const block = addingSpotTo;
            setAddingSpotTo(null);
            toast.success('Spot added.');
            // The new spot belongs to this block, so the expanded list has to refetch.
            setExpanded(block.id);
            blocks.reload();
          }}
        />
      )}
    </>
  );
}

/** Spots for one block, loaded only when the block is expanded. */
function SpotList({ blockId }: { blockId: string }) {
  const spots = useAsync(
    (signal) => api.get<Paginated<Spot>>(`/v1/campus/blocks/${blockId}/spots`, { signal }),
    [blockId],
  );

  if (spots.error) return <ErrorPane error={spots.error} onRetry={spots.reload} />;
  if (spots.loading && !spots.data) return <p className="small muted">Loading spots…</p>;
  if ((spots.data?.items.length ?? 0) === 0) {
    return <p className="small muted">No named spots in this block yet.</p>;
  }

  return (
    <ul className="plain-list small" style={{ marginTop: 4 }}>
      {spots.data!.items.map((spot) => (
        <li key={spot.id}>
          {spot.officialName}
          {spot.floorLabel ? ` · ${spot.floorLabel}` : ''}
          {spot.latitude !== null && spot.longitude !== null ? (
            <span className="muted mono"> · {spot.latitude}, {spot.longitude}</span>
          ) : (
            // Never invent a position. The twin places this spot schematically and says so.
            <span className="muted"> · no coordinates recorded</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function BlockModal({
  block,
  onClose,
  onDone,
}: {
  block?: Block;
  onClose: () => void;
  onDone: () => void;
}) {
  const [officialName, setOfficialName] = useState(block?.officialName ?? '');
  const [slug, setSlug] = useState(block?.slug ?? '');
  const [description, setDescription] = useState(block?.description ?? '');
  const [active, setActive] = useState(block?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  /** Mirrors the server's slug rule so the operator is not told off after the round trip. */
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
      if (block) {
        await api.patch(`/v1/admin/blocks/${block.id}`, {
          officialName: officialName.trim(),
          description: description.trim() || null,
          active,
        });
      } else {
        await api.post('/v1/admin/blocks', {
          officialName: officialName.trim(),
          slug: slug.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('The block could not be saved.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={block ? `Edit ${block.officialName}` : 'Add a campus block'}
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
            disabled={busy || officialName.trim().length === 0 || (!block && slug.trim().length === 0)}
          >
            {busy ? 'Saving…' : block ? 'Save changes' : 'Create block'}
          </button>
        </>
      }
    >
      <div className="stack stack--4">
        <div className="field">
          <label className="field__label" htmlFor="b-name">
            Official name
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="b-name"
            className="input"
            value={officialName}
            onChange={(event) => {
              setOfficialName(event.target.value);
              if (!block) setSlug(slugify(event.target.value));
            }}
            placeholder="For example: Main Academic Block"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="b-slug">
            Slug
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="b-slug"
            className="input mono"
            value={slug}
            disabled={Boolean(block)}
            onChange={(event) => setSlug(slugify(event.target.value))}
            placeholder="main-academic-block"
          />
          <p className="field__hint">
            {block
              ? 'A slug cannot be changed after creation — reports and links reference it.'
              : 'Lowercase letters, numbers and hyphens. The server validates this again.'}
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="b-desc">
            Description <span className="muted small">(optional)</span>
          </label>
          <textarea
            id="b-desc"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {block && (
          <label className="radio">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
            <span>
              <span className="strong">Active</span>
              <span className="small muted" style={{ display: 'block' }}>
                An inactive block stops appearing in the student reporting flow. Existing issues keep
                their history.
              </span>
            </span>
          </label>
        )}

        {error && (
          <InlineAlert variant="error" title="Could not save">
            {error.message}
          </InlineAlert>
        )}
      </div>
    </Modal>
  );
}

function SpotModal({ block, onClose, onDone }: { block: Block; onClose: () => void; onDone: () => void }) {
  const [officialName, setOfficialName] = useState('');
  const [floorLabel, setFloorLabel] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const coordsComplete = latitude.trim() !== '' && longitude.trim() !== '';
  const coordsPartial = (latitude.trim() === '') !== (longitude.trim() === '');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/admin/spots', {
        blockId: block.id,
        officialName: officialName.trim(),
        ...(floorLabel.trim() ? { floorLabel: floorLabel.trim() } : {}),
        ...(coordsComplete ? { latitude: Number(latitude), longitude: Number(longitude) } : {}),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('The spot could not be saved.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add a spot in ${block.officialName}`}
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
            disabled={busy || officialName.trim().length === 0 || coordsPartial}
          >
            {busy ? 'Saving…' : 'Create spot'}
          </button>
        </>
      }
    >
      <div className="stack stack--4">
        <div className="field">
          <label className="field__label" htmlFor="s-name">
            Named spot
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="s-name"
            className="input"
            value={officialName}
            onChange={(event) => setOfficialName(event.target.value)}
            placeholder="For example: Girls' washroom, west wing"
          />
          <p className="field__hint">
            This name is what students pick from, so make it recognisable on the ground rather than
            precise on a plan.
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="s-floor">
            Floor or level <span className="muted small">(optional)</span>
          </label>
          <input
            id="s-floor"
            className="input"
            value={floorLabel}
            onChange={(event) => setFloorLabel(event.target.value)}
            placeholder="Ground floor"
          />
        </div>

        <fieldset className="field">
          <legend className="field__label">Coordinates (optional)</legend>
          <div className="field-row">
            <label className="field">
              <span className="sr-only">Latitude</span>
              <input
                className="input mono"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="Latitude"
                inputMode="decimal"
              />
            </label>
            <label className="field">
              <span className="sr-only">Longitude</span>
              <input
                className="input mono"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="Longitude"
                inputMode="decimal"
              />
            </label>
          </div>
          <p className="field__hint">
            {coordsPartial
              ? 'Enter both coordinates or neither. A single value cannot be placed on a map.'
              : 'Leave both blank if the position is not known. A spot without coordinates still works — the twin places it schematically and labels it as unmapped rather than inventing a position.'}
          </p>
        </fieldset>

        {error && (
          <InlineAlert variant="error" title="Could not create the spot">
            {error.message}
          </InlineAlert>
        )}
      </div>
    </Modal>
  );
}
