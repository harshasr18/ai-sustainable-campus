/**
 * Report an issue — the multi-step student flow (§7).
 *
 * Steps A→E exactly as the brief specifies: capture a fresh photograph, choose the block and
 * named spot, choose the category, review, then submit and show the ACTUAL server result.
 *
 * THREE THINGS WORTH READING BEFORE EDITING:
 *
 * 1. THE PHOTOGRAPH IS MANDATORY AND MUST BE CAPTURED IN-APP. There is no upload input in
 *    this component, by design (see hooks/useCamera.ts). Submission stays disabled until a
 *    capture exists.
 *
 * 2. GPS IS OPTIONAL AND IS NEVER A REASON TO BLOCK. §7 Step B: "A denied or unavailable GPS
 *    permission must not block reporting." The location the student *selected* is the
 *    authoritative one; GPS is attached only if the browser offers it without objection, and
 *    a refusal is mentioned once in a neutral tone and then dropped.
 *
 * 3. STEP E SHOWS WHAT THE SERVER SAID, NOT WHAT WE HOPED. The confirmation panel renders the
 *    parsed response body. If the backend says tokens were not awarded, the UI says so. There
 *    is no optimistic "+10" and no generated reference number — a fabricated success screen
 *    would be the worst possible bug in a system whose whole purpose is trustworthy records.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type {
  Block,
  Category,
  Paginated,
  Spot,
  SubmitReportResponse,
} from '../../lib/types.js';
import { useCamera } from '../../hooks/useCamera.js';
import { Card } from '../../components/data.js';
import { ErrorPane, InlineAlert } from '../../components/states.js';
import { DuplicateBadge, ValidationBadge } from '../../components/badges.js';

type Step = 'photo' | 'location' | 'category' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'photo', label: 'Photograph' },
  { key: 'location', label: 'Location' },
  { key: 'category', label: 'Category' },
  { key: 'review', label: 'Review' },
];

export function ReportIssuePage() {
  const navigate = useNavigate();
  const camera = useCamera();

  const [step, setStep] = useState<Step>('photo');
  const [blockId, setBlockId] = useState('');
  const [spotId, setSpotId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geoNote, setGeoNote] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | Error | null>(null);
  const [result, setResult] = useState<SubmitReportResponse | null>(null);

  const blocks = useAsync((signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }), []);
  const categories = useAsync(
    (signal) => api.get<Paginated<Category>>('/v1/campus/categories', { signal }),
    [],
  );

  // Spots are fetched only once a block is chosen — the endpoint is per-block.
  const spots = useAsync(
    (signal) =>
      blockId
        ? api.get<Paginated<Spot>>(`/v1/campus/blocks/${blockId}/spots`, { signal })
        : Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 }),
    [blockId],
  );

  /**
   * Optional GPS. Requested once when the flow opens, and never awaited by anything that
   * gates submission.
   */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setCoords({
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6)),
        }),
      () => setGeoNote('Location permission was not granted. Your selected block and spot are used instead.'),
      { timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  const selectedBlock = blocks.data?.items.find((block) => block.id === blockId);
  const selectedSpot = spots.data?.items.find((spot) => spot.id === spotId);
  const selectedCategory = categories.data?.items.find((category) => category.id === categoryId);

  const canLeavePhotoStep = camera.photo !== null;
  const canLeaveLocationStep = Boolean(blockId && spotId);
  const canLeaveCategoryStep = Boolean(categoryId);
  const canSubmit = canLeavePhotoStep && canLeaveLocationStep && canLeaveCategoryStep && !submitting;

  const currentIndex = useMemo(() => STEPS.findIndex((s) => s.key === step), [step]);

  /**
   * Submission.
   *
   * `multipart/form-data` because the photo travels with the fields in one request — the
   * backend rejects a report with no photo, and sending them together means a report can
   * never exist without its evidence.
   */
  async function handleSubmit() {
    if (!camera.photo || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const form = new FormData();
      // The filename is ignored by the server, which generates its own storage key. Sent
      // only because multipart requires one.
      form.append('photo', camera.photo.blob, 'capture.jpg');
      form.append('blockId', blockId);
      form.append('spotId', spotId);
      form.append('selectedCategoryId', categoryId);
      if (description.trim()) form.append('description', description.trim());
      if (coords) {
        // Sent as strings: multipart fields are text, and the server coerces + validates them.
        form.append('latitude', String(coords.latitude));
        form.append('longitude', String(coords.longitude));
      }
      form.append('capturedAt', new Date().toISOString());

      const response = await api.postForm<SubmitReportResponse>('/v1/reports', form);
      setResult(response);
      setStep('done');
    } catch (caught) {
      // A genuine failure: the user stays on the review step with everything intact and can
      // press submit again. Nothing is cleared, and no success is claimed.
      setSubmitError(caught instanceof Error ? caught : new Error('Submission failed.'));
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------------------------- Step E: result ---------------------------- */
  if (step === 'done' && result) {
    return <SubmissionResult result={result} onView={() => navigate(`/student/reports/${result.reportId}`)} />;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Report an issue</h2>
          <p className="page-head__subtitle">
            Photograph the problem, tell us where it is, and choose what kind of fault it is.
          </p>
        </div>
      </div>

      <div className="steps">
        {STEPS.map((item, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
          return (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {index > 0 && <span className="step__sep" aria-hidden="true" />}
              <div className={`step${state === 'current' ? ' step--current' : state === 'done' ? ' step--done' : ''}`}>
                <span className="step__dot" aria-hidden="true">
                  {state === 'done' ? '✓' : index + 1}
                </span>
                <span className="step__label">{item.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ---------------------------- Step A: photo ---------------------------- */}
      {step === 'photo' && (
        <Card
          title="Step 1 — Take a photograph"
          subtitle="This must be a photo taken now, in the app. Choosing an existing picture from your gallery is not accepted."
        >
          <div className="camera">
            <div className="camera__stage">
              {/* The video element stays mounted so the ref is stable across state changes;
                  it is hidden once a frame has been captured. */}
              <video
                ref={camera.videoRef}
                className="camera__video"
                playsInline
                muted
                style={{ display: camera.status === 'captured' ? 'none' : undefined }}
              />

              {camera.status === 'captured' && camera.photo && (
                <img className="camera__still" src={camera.photo.previewUrl} alt="The photograph you just captured" />
              )}

              {camera.status !== 'live' && camera.status !== 'captured' && (
                <div className="camera__placeholder">
                  <span aria-hidden="true" style={{ fontSize: 28 }}>
                    📷
                  </span>
                  <p>
                    {camera.status === 'starting'
                      ? 'Starting the camera…'
                      : camera.status === 'idle'
                        ? 'The camera is off. Press Start camera to begin.'
                        : 'The camera could not be shown.'}
                  </p>
                </div>
              )}
            </div>

            <div className="camera__controls">
              {camera.status !== 'captured' && (
                <>
                  {camera.status !== 'live' && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void camera.start()}
                      disabled={camera.status === 'starting'}
                    >
                      {camera.status === 'starting' ? 'Starting…' : 'Start camera'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="camera__shutter"
                    onClick={() => void camera.capture()}
                    disabled={camera.status !== 'live' || !camera.ready}
                    aria-label="Capture photograph"
                    title={camera.status === 'live' && camera.ready ? 'Take the photograph' : 'Waiting for the camera'}
                  />
                </>
              )}

              {camera.status === 'captured' && (
                <>
                  <img
                    src={camera.photo!.previewUrl}
                    alt=""
                    aria-hidden="true"
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }}
                  />
                  <div style={{ flex: 1 }}>
                    <p className="small strong" style={{ margin: 0 }}>
                      Photograph captured
                    </p>
                    <p className="small muted" style={{ margin: 0 }}>
                      {camera.photo!.width}×{camera.photo!.height} · {(camera.photo!.bytes / 1024).toFixed(0)} KB
                    </p>
                  </div>
                  <button type="button" className="btn btn--secondary" onClick={camera.retake}>
                    Retake
                  </button>
                </>
              )}
            </div>
          </div>

          {camera.errorMessage && (
            <div className="mt-4">
              <InlineAlert variant="warning" title="Camera unavailable">
                {camera.errorMessage}
              </InlineAlert>
            </div>
          )}

          <div className="btn-row mt-5">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canLeavePhotoStep}
              onClick={() => setStep('location')}
            >
              Continue
            </button>
            {!canLeavePhotoStep && (
              <span className="small muted">Take a photograph to continue.</span>
            )}
          </div>
        </Card>
      )}

      {/* --------------------------- Step B: location --------------------------- */}
      {step === 'location' && (
        <Card
          title="Step 2 — Where is it?"
          subtitle="Choose the building, then the exact place inside it. This decides which department gets the work."
        >
          {blocks.error ? (
            <ErrorPane error={blocks.error} onRetry={blocks.reload} />
          ) : (
            <>
              <div className="field">
                <label className="field__label" htmlFor="block">
                  Campus block / building
                  <span className="field__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id="block"
                  className="select"
                  value={blockId}
                  onChange={(event) => {
                    setBlockId(event.target.value);
                    setSpotId(''); // a spot from the previous block would be invalid
                  }}
                >
                  <option value="">Select a block…</option>
                  {(blocks.data?.items ?? [])
                    .filter((block) => block.active)
                    .map((block) => (
                      <option key={block.id} value={block.id}>
                        {block.officialName}
                      </option>
                    ))}
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="spot">
                  Named spot or facility
                  <span className="field__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id="spot"
                  className="select"
                  value={spotId}
                  disabled={!blockId || spots.loading}
                  onChange={(event) => setSpotId(event.target.value)}
                >
                  <option value="">
                    {!blockId ? 'Choose a block first' : spots.loading ? 'Loading spots…' : 'Select a spot…'}
                  </option>
                  {(spots.data?.items ?? [])
                    .filter((spot) => spot.active)
                    .map((spot) => (
                      <option key={spot.id} value={spot.id}>
                        {[spot.officialName, spot.floorLabel].filter(Boolean).join(' — ')}
                      </option>
                    ))}
                </select>
                {blockId && !spots.loading && (spots.data?.items.length ?? 0) === 0 && (
                  <p className="field__hint">
                    No named spots are configured for this block yet.
                  </p>
                )}
              </div>

              {geoNote && (
                <InlineAlert variant="info" title="GPS not used">
                  {geoNote}
                </InlineAlert>
              )}
              {coords && (
                <p className="small muted">
                  GPS attached: {coords.latitude}, {coords.longitude} — your selected spot above is still
                  the authoritative location.
                </p>
              )}
            </>
          )}

          <div className="btn-row mt-5">
            <button type="button" className="btn btn--secondary" onClick={() => setStep('photo')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canLeaveLocationStep}
              onClick={() => setStep('category')}
            >
              Continue
            </button>
            {!canLeaveLocationStep && <span className="small muted">Select a block and a spot.</span>}
          </div>
        </Card>
      )}

      {/* --------------------------- Step C: category --------------------------- */}
      {step === 'category' && (
        <Card
          title="Step 3 — What kind of problem is it?"
          subtitle="Pick the closest match. The AI compares your choice against the photograph and flags anything that needs a second look."
        >
          {categories.error ? (
            <ErrorPane error={categories.error} onRetry={categories.reload} />
          ) : categories.loading ? (
            <p className="muted">Loading categories…</p>
          ) : (
            <div className="grid-3">
              {(categories.data?.items ?? [])
                .filter((category) => category.active)
                .map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`btn ${categoryId === category.id ? 'btn--primary' : 'btn--secondary'}`}
                    style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 'var(--space-3)' }}
                    onClick={() => setCategoryId(category.id)}
                    aria-pressed={categoryId === category.id}
                  >
                    <span>
                      <span className="strong" style={{ display: 'block' }}>
                        {category.name}
                      </span>
                      {category.description && (
                        <span className="small" style={{ opacity: 0.8, fontWeight: 400 }}>
                          {category.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
            </div>
          )}

          <div className="btn-row mt-5">
            <button type="button" className="btn btn--secondary" onClick={() => setStep('location')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canLeaveCategoryStep}
              onClick={() => setStep('review')}
            >
              Continue
            </button>
          </div>
        </Card>
      )}

      {/* ---------------------------- Step D: review ---------------------------- */}
      {step === 'review' && (
        <Card title="Step 4 — Check and submit" subtitle="Everything here is what will be sent to the campus team.">
          <div className="grid-2">
            <div>
              {camera.photo && (
                <img
                  src={camera.photo.previewUrl}
                  alt="The photograph being submitted"
                  style={{ width: '100%', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}
                />
              )}
            </div>
            <div>
              <dl className="dl">
                <dt>Block</dt>
                <dd>{selectedBlock?.officialName ?? '—'}</dd>
                <dt>Spot</dt>
                <dd>{selectedSpot?.officialName ?? '—'}</dd>
                <dt>Floor</dt>
                <dd>{selectedSpot?.floorLabel ?? '—'}</dd>
                <dt>Category</dt>
                <dd>{selectedCategory?.name ?? '—'}</dd>
                <dt>GPS</dt>
                <dd>
                  {coords ? `${coords.latitude}, ${coords.longitude}` : <span className="muted">Not captured</span>}
                </dd>
              </dl>

              <div className="field mt-4">
                <label className="field__label" htmlFor="description">
                  Anything else? <span className="muted small">(optional)</span>
                </label>
                <textarea
                  id="description"
                  className="textarea"
                  maxLength={2000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="For example: the leak started after last night's rain and is spreading across the corridor."
                />
                <p className="field__hint">{description.length}/2000</p>
              </div>
            </div>
          </div>

          {submitError && (
            <div className="mt-4">
              <InlineAlert
                variant="error"
                title="The report was not submitted"
                details={submitError instanceof ApiError ? submitError.details : undefined}
              >
                {submitError.message}
                {submitError instanceof ApiError && submitError.requestId && (
                  <span className="mono"> (request {submitError.requestId})</span>
                )}
              </InlineAlert>
              <p className="small muted mt-3">
                Nothing was lost — your photograph and details are still here. Fix the problem above or
                press Submit again.
              </p>
            </div>
          )}

          <div className="btn-row mt-5">
            <button type="button" className="btn btn--secondary" onClick={() => setStep('category')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {submitting ? 'Submitting…' : 'Submit report'}
            </button>
          </div>

          <p className="small muted mt-3">
            Tokens are not awarded at submission. The server validates the report first — including
            checking whether it duplicates an existing one — and awards
            {' '}<strong>10 tokens</strong> when that succeeds.
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * Step E — the real server result.
 *
 * Every line is read from the response body. Where the backend reports something we cannot
 * yet do (no AI provider configured, duplicate detection pending), the panel says exactly
 * that rather than implying a check happened.
 */
function SubmissionResult({ result, onView }: { result: SubmitReportResponse; onView: () => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Report submitted</h2>
          <p className="page-head__subtitle">The campus team can see this now.</p>
        </div>
      </div>

      <Card title="What the server recorded" subtitle="Returned directly by the API — nothing here is estimated.">
        <dl className="dl">
          <dt>Reference</dt>
          <dd className="mono strong">{result.issuePublicReference}</dd>

          <dt>Master issue</dt>
          <dd>
            {result.duplicateOfExistingIssue ? (
              <>
                <span className="badge badge--progress">Linked to an existing ticket</span>
                <span className="muted small" style={{ display: 'block', marginTop: 4 }}>
                  Another student already reported this defect. Your report was attached to the same
                  repair ticket rather than creating a duplicate one — and it still counts.
                </span>
              </>
            ) : (
              <span className="badge badge--approved">New repair ticket created</span>
            )}
          </dd>

          <dt>Duplicate check</dt>
          <dd>
            <DuplicateBadge status={result.duplicateMatchStatus} />
          </dd>

          <dt>Validation</dt>
          <dd>
            <ValidationBadge status={result.validationStatus} />
            <span className="muted small" style={{ display: 'block', marginTop: 4 }}>
              Tokens: {result.tokensAwarded === 0 ? 'none awarded yet' : `${result.tokensAwarded} awarded`} ·
              policy {result.tokenPolicy.tokensPerValidatedReport} per validated report
            </span>
          </dd>
        </dl>

        {result.tokensAwarded === 0 && (
          <div className="mt-4">
            <InlineAlert variant="info" title="No tokens yet — and that is expected">
              Tokens are credited only after the report passes validation. That has not happened for this
              report yet, so the ledger shows nothing. You will see the credit appear in{' '}
              <strong>My tokens</strong> once it does.
            </InlineAlert>
          </div>
        )}
      </Card>

      <div className="btn-row mt-5">
        <button type="button" className="btn btn--primary" onClick={onView}>
          View this report
        </button>
        <Link to="/student/reports" className="btn btn--secondary">
          All my reports
        </Link>
      </div>
    </>
  );
}
