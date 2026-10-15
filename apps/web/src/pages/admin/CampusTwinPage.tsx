/**
 * The campus digital twin (§13).
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT. Read this before changing anything in this file.
 * ---------------------------------------------------------------------------------------
 *
 * The Phase 3 audit found NO campus geometry assets in this repository: no .glb, .gltf, .obj,
 * .fbx, .ifc, .dwg, .geojson or .kml, no survey data, no floor plans, and no photographs of
 * the campus. The only positional data anywhere is a set of arithmetic offsets around a
 * single `CAMPUS_CENTER` constant in the seed, and the seeded block names themselves carry a
 * "(placeholder)" suffix.
 *
 * §13 permits exactly one honest response to that: a SCHEMATIC model, clearly labelled. And
 * §13's prohibitions are explicit — do not invent precise campus geometry, do not present a
 * schematic as survey-accurate or official, and NEVER render a static image and call it an
 * interactive 3D twin. So:
 *
 *   - Every block is a plain extruded box on a grid, sized by its issue count. The layout is
 *     deterministic and derived from the block's stable id, NOT from geography. It carries no
 *     spatial meaning whatsoever.
 *   - The scene is genuinely interactive: orbit, zoom, hover, click. It is real WebGL through
 *     React Three Fiber, not a picture of a model with a rotation animation laid over it.
 *   - When a block has real coordinates on its spots, they are used for the LABEL only, so an
 *     operator can see which parts of campus are mapped and which are not.
 *   - A banner states the schematic nature permanently. It is not a dismissible tooltip.
 *   - Nothing here is styled to look like architectural documentation: no shadows faking
 *     sunlight, no texture imagery, no compass rose.
 *
 * THE DATA IS REAL EVEN THOUGH THE GEOMETRY IS NOT. Heights and colours come from live issue
 * counts per block, fetched from `/v1/analytics/summary` and `/v1/issues`. If a block has ten
 * open issues its box is taller and redder. That mapping is the point of the screen, and it is
 * computed from database rows.
 *
 * WHEN REAL GEOMETRY ARRIVES. Replace `SchematicBlock` with a glTF loader and delete the
 * banner in the same commit. Until then the banner is not decorative; it is the difference
 * between a demo aid and a false claim.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Canvas, extend, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls as ThreeOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AnalyticsSummary, Block, Issue, Paginated, Spot } from '../../lib/types.js';
import { Card, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows, NotYetProduced } from '../../components/states.js';
import { OverdueBadge, SeverityBadge, StatusBadge } from '../../components/badges.js';
import { formatCount } from '../../lib/format.js';

/**
 * WHY ORBIT CONTROLS ARE WIRED BY HAND INSTEAD OF IMPORTED FROM `@react-three/drei`.
 *
 * drei was tried first and removed. Installing it makes `npm install` crash on npm 10.8.2 —
 * not because of a genuine conflict, but because npm's peer resolver recurses into
 * @react-three/fiber's OPTIONAL react-native peer and dies with
 * "Cannot read properties of null (reading 'edgesOut')". Pulling an entire auxiliary library
 * into the tree to get one camera control, and making the repository uninstallable for
 * anyone on a stock npm, is not a trade worth making. `three` already ships OrbitControls and
 * R3F already ships `extend`, so the binding below is the whole cost.
 *
 * See .npmrc for the full note; the flag there is a workaround for the npm bug, and this file
 * is a workaround for the dependency that triggers it.
 */
extend({ OrbitControls: ThreeOrbitControls });

type OrbitControlsElement = ThreeOrbitControls & { dispose: () => void };

declare module '@react-three/fiber' {
  interface ThreeElements {
    orbitControls: {
      // `ref` and `args` are declared here because this element is created by `extend`
      // rather than shipped by R3F, so its prop types are ours to describe.
      ref?: React.Ref<OrbitControlsElement>;
      args?: [camera: unknown, domElement: unknown];
      enablePan?: boolean;
      minDistance?: number;
      maxDistance?: number;
      maxPolarAngle?: number;
      makeDefault?: boolean;
      onEnd?: () => void;
    };
  }
}

/** Drives three's OrbitControls from R3F's frame loop, which is what keeps them in sync. */
function CameraControls() {
  const { camera, gl, invalidate } = useThree();
  const ref = useRef<OrbitControlsElement>(null);

  useFrame(() => {
    ref.current?.update();
  });

  return (
    <orbitControls
      ref={ref}
      args={[camera, gl.domElement]}
      enablePan={false}
      minDistance={14}
      maxDistance={70}
      maxPolarAngle={Math.PI / 2.15}
      onEnd={invalidate}
    />
  );
}

/** Colour by the worst thing open in that block. Deliberately not a gradient ramp. */
const STATUS_COLOURS = {
  clear: '#4a9a74',
  open: '#4fb3bd',
  overdue: '#d98d2b',
  critical: '#b42318',
  none: '#b9c0c3',
} as const;

export function CampusTwinPage() {
  const summary = useAsync(
    (signal) => api.get<AnalyticsSummary>('/v1/analytics/summary', { signal }),
    [],
  );
  const blocks = useAsync((signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }), []);
  const critical = useAsync(
    (signal) => api.get<Paginated<Issue>>(`/v1/issues${query({ severity: 'CRITICAL', limit: 100 })}`, { signal }),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null);
  /** Hovered box, mirrored into the DOM overlay rather than drawn inside the scene. */
  const [hoverLabel, setHoverLabel] = useState<{ name: string; detail: string } | null>(null);

  /**
   * Block placement.
   *
   * A deterministic grid derived from the block's id — the same block lands in the same cell
   * on every reload, so an operator can build a mental map of the SCREEN without being misled
   * into thinking it is a map of the CAMPUS. A stable sort by id (not by name) means renaming
   * a block does not shuffle the view.
   */
  const layout = useMemo(() => {
    const items = [...(blocks.data?.items ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)));
    return items.map((block, index) => {
      const stats = summary.data?.byBlock.find((b) => b.blockId === block.id);
      const isCritical = (critical.data?.items ?? []).some((issue) => issue.blockId === block.id);
      const hasOpen = (stats?.open ?? 0) > 0;
      const isOverdue = (stats?.overdue ?? 0) > 0;

      // Height encodes OPEN issue count; a block with nothing recorded stays at the floor
      // height rather than being hidden, because "no data" is itself information.
      const open = stats?.open ?? 0;
      const height = 1 + Math.min(open, 12) * 0.42;

      return {
        block,
        stats,
        height,
        colour: isCritical
          ? STATUS_COLOURS.critical
          : isOverdue
            ? STATUS_COLOURS.overdue
            : hasOpen
              ? STATUS_COLOURS.open
              : stats
                ? STATUS_COLOURS.clear
                : STATUS_COLOURS.none,
        x: (index % columns) * 9 - ((columns - 1) * 9) / 2,
        z: Math.floor(index / columns) * 9,
      };
    });
  }, [blocks.data, summary.data, critical.data]);

  const selectedBlock = layout.find((entry) => entry.block.id === selected) ?? null;

  const loading = (blocks.loading && !blocks.data) || (summary.loading && !summary.data);
  const error = blocks.error ?? summary.error;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Campus twin</h2>
          <p className="page-head__subtitle">
            A schematic view of every block, coloured and scaled by what is actually open in it.
          </p>
        </div>
        <Link to="/admin/campus" className="btn btn--secondary">
          Manage locations
        </Link>
      </div>

      {/* Permanent, not dismissible. §13: "do not present a schematic model as
          survey-accurate or as an official representation". */}
      <div className="mb-5">
        <InlineAlert variant="warning" title="This is a schematic model, not a survey of the campus">
          No official campus geometry exists in this project — no CAD, GIS or photogrammetry
          assets. Blocks are drawn as plain boxes arranged on a grid by their internal id, so the
          layout carries <strong>no</strong> real-world spatial meaning. Heights and colours encode
          live issue counts, which are real. Do not read building positions or distances from this
          view.
        </InlineAlert>
      </div>

      {error ? (
        <ErrorPane error={error} onRetry={blocks.reload} />
      ) : loading ? (
        <SkeletonRows rows={5} />
      ) : layout.length === 0 ? (
        <Card>
          <EmptyPane
            icon="▦"
            title="No blocks to display"
            text="The twin draws one box per campus block. Add blocks first, then they appear here with their live issue counts."
            action={
              <Link to="/admin/campus" className="btn btn--primary">
                Add campus blocks
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <section className="section">
            <StatGrid>
              <StatTile label="Blocks shown" value={formatCount(layout.length)} />
              <StatTile
                label="Open issues"
                value={summary.data ? formatCount(summary.data.issues.open) : null}
                foot="Across all blocks"
              />
              <StatTile
                label="Overdue"
                value={summary.data ? formatCount(summary.data.issues.overdue) : null}
                tone={summary.data && summary.data.issues.overdue > 0 ? 'danger' : 'default'}
              />
              <StatTile
                label="Critical severity"
                value={critical.data ? formatCount(critical.data.total) : null}
                tone={critical.data && critical.data.total > 0 ? 'danger' : 'default'}
                foot="Confirmed by a person, not the AI"
              />
            </StatGrid>
          </section>

          <div className="grid-2">
            <div>
              <div className="twin">
                <Canvas
                  // A fixed camera, a flat light, no shadows: this is a diagram, and lighting
                  // tricks would only make it look more authoritative than it is.
                  camera={{ position: [22, 20, 26], fov: 42 }}
                  dpr={[1, 2]}
                  // Antialiasing on; the schematic reads better with clean edges.
                  gl={{ antialias: true }}
                >
                  <color attach="background" args={['#f2f4f7']} />
                  <ambientLight intensity={1.35} />
                  <directionalLight position={[12, 18, 8]} intensity={0.7} />

                  {/* three's own GridHelper — part of the core library, no extra dependency. */}
                  <gridHelper args={[80, 20, '#b9c0c3', '#d9dee0']} position={[0, -0.01, 0]} />

                  {layout.map((entry) => (
                    <SchematicBlock
                      key={entry.block.id}
                      {...entry}
                      isSelected={selected === entry.block.id}
                      onSelect={() => setSelected(entry.block.id)}
                      onHover={setHoverLabel}
                    />
                  ))}

                  {/* Panning is disabled on purpose: a user who can pan will try to navigate to
                      a "part of campus", and there is no geography here to navigate. */}
                  <CameraControls />
                </Canvas>

                <div className="twin__overlay">
                  {/* The hover label, as real DOM. `aria-live` is off because a mouse hover is
                      not an event a screen-reader user can act on; the same information is in
                      the table below, which is reachable by keyboard. */}
                  {hoverLabel && (
                    <div className="twin__label twin__label--floating">
                      <strong>{hoverLabel.name}</strong>
                      <span>{hoverLabel.detail}</span>
                    </div>
                  )}
                  <div className="twin__notice">
                    <strong>Schematic layout.</strong> Grid position is generated from each block's
                    id, not from latitude and longitude. Drag to orbit, scroll to zoom, click a box
                    for its details.
                  </div>
                  <div className="twin__legend">
                    <LegendRow colour={STATUS_COLOURS.critical} label="Has a CRITICAL issue" />
                    <LegendRow colour={STATUS_COLOURS.overdue} label="Has an overdue issue" />
                    <LegendRow colour={STATUS_COLOURS.open} label="Open issues" />
                    <LegendRow colour={STATUS_COLOURS.clear} label="All resolved" />
                    <LegendRow colour={STATUS_COLOURS.none} label="No issues recorded" />
                    <span className="muted" style={{ marginTop: 2 }}>
                      Box height = open issue count
                    </span>
                  </div>
                </div>
              </div>

              <p className="small muted mt-3">
                Rendering {layout.length} block{layout.length === 1 ? '' : 's'} with real WebGL. The
                boxes are drawn from data; no 3D model of this campus has been loaded, because none
                exists in the project.
              </p>
            </div>

            <div className="stack stack--5">
              {selectedBlock ? (
                <BlockPanel entry={selectedBlock} onClear={() => setSelected(null)} />
              ) : (
                <Card title="Select a block">
                  <p className="muted mb-0">
                    Click any box in the model to see that block's issues. Blocks are also listed in
                    the panel below if you would rather not use the 3D view — it is a convenience, not
                    the only route to the data.
                  </p>
                </Card>
              )}

              <Card title="All blocks" subtitle="The same data, without the 3D view." flush>
                <div className="table-wrap">
                  <table className="table table--interactive">
                    <thead>
                      <tr>
                        <th scope="col">Block</th>
                        <th scope="col" className="table__num">
                          Open
                        </th>
                        <th scope="col" className="table__num">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {layout.map((entry) => (
                        <tr key={entry.block.id}>
                          <td>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => setSelected(entry.block.id)}
                            >
                              {entry.block.officialName}
                            </button>
                          </td>
                          <td className="table__num">{entry.stats?.open ?? 0}</td>
                          <td className="table__num">{entry.stats?.total ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function LegendRow({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="twin__legend-row">
      <span className="twin__swatch" style={{ background: colour }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** One block: a box whose height is its open-issue count, plus a hover label. */
function SchematicBlock({
  block,
  height,
  colour,
  stats,
  x,
  z,
  isSelected,
  onSelect,
  onHover,
}: {
  block: Block;
  height: number;
  colour: string;
  stats: { open: number; total: number; overdue: number } | undefined;
  x: number;
  z: number;
  isSelected: boolean;
  onSelect: () => void;
  /** Reports the hovered block so the parent can render the label as real DOM. */
  onHover: (label: { name: string; detail: string } | null) => void;
}) {
  const [hovered, setHovered] = useState(false);

  /**
   * The hover label is reported UPWARD and rendered as ordinary DOM in the overlay, rather
   * than injected into the WebGL scene. That keeps it selectable, visible to a screen reader,
   * and unaffected by a lost WebGL context.
   *
   * It is published from an effect rather than during render: calling a parent's setState
   * while rendering children is a React anti-pattern and produces exactly the warning it
   * deserves.
   */
  useEffect(() => {
    if (!hovered) return;
    onHover({
      name: block.officialName,
      detail: stats ? `${stats.open} open · ${stats.total} total` : 'No issues recorded',
    });
  }, [hovered, onHover, block.officialName, stats]);

  return (
    <group position={[x, height / 2, z]}>
      <mesh
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          onHover(null);
          document.body.style.cursor = '';
        }}
      >
        <boxGeometry args={[5, height, 5]} />
        <meshLambertMaterial color={colour} />
      </mesh>

      {/* A wireframe overlay makes a selected block obvious without relying on colour alone,
          which matters for anyone who cannot distinguish the red and amber. A plain
          wireframe box, so no line primitive or extra dependency is needed. */}
      {isSelected && (
        <mesh scale={1.02}>
          <boxGeometry args={[5, height, 5]} />
          <meshBasicMaterial color="#10161a" wireframe />
        </mesh>
      )}

    </group>
  );
}

function BlockPanel({
  entry,
  onClear,
}: {
  entry: {
    block: Block;
    stats: { open: number; total: number; overdue: number; resolved: number } | undefined;
    colour: string;
  };
  onClear: () => void;
}) {
  const issues = useAsync(
    (signal) =>
      api.get<Paginated<Issue>>(`/v1/issues${query({ blockId: entry.block.id, limit: 10 })}`, {
        signal,
      }),
    [entry.block.id],
  );

  const spots = useAsync(
    (signal) =>
      api.get<Paginated<Spot>>(`/v1/campus/blocks/${entry.block.id}/spots`, { signal }),
    [entry.block.id],
  );

  const mapped = (spots.data?.items ?? []).filter((s) => s.latitude !== null && s.longitude !== null);
  const unmapped = (spots.data?.items ?? []).filter((s) => s.latitude === null || s.longitude === null);

  return (
    <Card
      title={entry.block.officialName}
      subtitle={entry.block.description ?? 'No description recorded.'}
      action={
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
          Clear
        </button>
      }
    >
      <StatGrid>
        <StatTile label="Open" value={entry.stats?.open ?? 0} />
        <StatTile label="Overdue" value={entry.stats?.overdue ?? 0} tone={entry.stats?.overdue ? 'warning' : 'default'} />
        <StatTile label="Resolved" value={entry.stats?.resolved ?? 0} />
      </StatGrid>

      <h3 className="section__title mt-5">Latest issues</h3>
      {issues.error ? (
        <ErrorPane error={issues.error} onRetry={issues.reload} />
      ) : issues.loading && !issues.data ? (
        <SkeletonRows rows={3} />
      ) : (issues.data?.items.length ?? 0) === 0 ? (
        <p className="muted small mb-0">No issues reported in this block.</p>
      ) : (
        <ul className="plain-list small">
          {issues.data!.items.map((issue) => (
            <li key={issue.id}>
              <Link to={`/admin/issues/${issue.id}`}>
                <span className="mono">{issue.publicReference}</span> · {issue.title}
              </Link>
              <span className="row row--wrap" style={{ gap: 6, marginTop: 2 }}>
                <StatusBadge status={issue.status} />
                {issue.severity && <SeverityBadge severity={issue.severity} />}
                {issue.overdue && <OverdueBadge />}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="section__title mt-5">Spot coverage</h3>
      {spots.loading && !spots.data ? (
        <SkeletonRows rows={2} />
      ) : (spots.data?.items.length ?? 0) === 0 ? (
        <p className="muted small mb-0">No named spots in this block.</p>
      ) : (
        <>
          <p className="small">
            <strong>{mapped.length}</strong> of {spots.data!.items.length} spots have recorded
            coordinates. The {unmapped.length} without them are still perfectly reportable — a spot
            does not need a position to be selected — but they cannot be placed on any map.
          </p>
          {unmapped.length > 0 && (
            <p className="small muted mb-0">
              Unmapped: {unmapped.map((s) => s.officialName).join(', ')}
            </p>
          )}
        </>
      )}

      <p className="small muted mt-4 mb-0">
        <NotYetProduced what="Per-floor breakdowns, heat maps and real building geometry" /> — there is
        no floor-level data in the schema and no campus model in the repository.
      </p>
    </Card>
  );
}
