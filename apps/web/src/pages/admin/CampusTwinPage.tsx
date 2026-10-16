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

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
      target?: [number, number, number];
      enablePan?: boolean;
      minDistance?: number;
      maxDistance?: number;
      maxPolarAngle?: number;
      makeDefault?: boolean;
      onEnd?: () => void;
    };
  }
}

/**
 * Drives three's OrbitControls from R3F's frame loop, which is what keeps them in sync.
 *
 * IT ALSO REFITS THE CAMERA WHEN THE LAYOUT CHANGES, and that is not a nicety. R3F reads
 * `camera={{ position }}` only for the FIRST frame; before this effect existed the camera
 * was placed once and never reconsidered, so a grid wider than the one the position was
 * chosen for simply hung off the edge of the canvas. That is not a rendering glitch a
 * viewer can reason about — it looks like blocks are missing, which for a screen whose
 * entire job is "show me every block" is a correctness bug, not a cosmetic one.
 *
 * The effect body runs only when `position`/`target` actually change (they are memoised on
 * the layout), so a user's own orbit is never fought or reset.
 */
function CameraControls({
  position,
  target,
}: {
  position: [number, number, number];
  target: [number, number, number];
}) {
  const { camera, gl, invalidate } = useThree();
  const ref = useRef<OrbitControlsElement>(null);

  useFrame(() => {
    ref.current?.update();
  });

  useEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    const controls = ref.current;
    if (controls) {
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    }
    camera.lookAt(target[0], target[1], target[2]);
    invalidate();
  }, [camera, invalidate, position, target]);

  return (
    <orbitControls
      ref={ref}
      args={[camera, gl.domElement]}
      enablePan={false}
      minDistance={14}
      maxDistance={90}
      maxPolarAngle={Math.PI / 2.15}
      onEnd={invalidate}
    />
  );
}

/** Cell pitch on the schematic grid, and the footprint of one block box. */
const CELL_SPACING = 9;
const BLOCK_SIZE = 5;
/** Vertical field of view, shared by the Canvas and the fit calculation so they cannot drift. */
const CAMERA_FOV = 42;
/** Constant viewing angle, normalised. Changing the layout must not change this. */
const VIEW_DIRECTION = { x: 0.556, y: 0.502, z: 0.663 } as const;

/** Colour by the worst thing open in that block. Deliberately not a gradient ramp. */
const STATUS_COLOURS = {
  clear: '#4a9a74',
  open: '#4fb3bd',
  overdue: '#d98d2b',
  critical: '#b42318',
  none: '#b9c0c3',
} as const;

/**
 * WEBGL FALLBACK (Phase 5 — audit finding F8).
 *
 * With WebGL disabled (old GPU, blocklisted driver, remote desktop, hardened browser) the
 * <Canvas> threw during mount and, with no boundary, React unmounted the WHOLE application:
 * the admin saw a blank page and lost the navigation too. Three layers now prevent that:
 *   1. a capability check before the Canvas is ever mounted;
 *   2. an error boundary around the Canvas for failures the check cannot predict;
 *   3. a `webglcontextlost` listener for a context the GPU takes away later.
 * Each falls back to the same data drawn as a flat grid of buttons, so selection still works.
 */
function detectWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

class TwinBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    // Logged for the developer console only; the user sees the 2D fallback, not a stack.
    console.warn('Campus twin: 3D view failed, showing the 2D fallback.', error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface LayoutEntry {
  block: Block;
  stats: { open: number; total: number; overdue: number } | undefined;
  colour: string;
}

function FlatTwin({
  layout,
  selected,
  onSelect,
  reason,
}: {
  layout: LayoutEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
  reason: string;
}) {
  return (
    <div className="twin twin--flat" data-testid="twin-fallback">
      <p className="small mt-0 mb-3">
        <strong>3D view unavailable.</strong> {reason} The same blocks and counts are shown as a flat
        schematic grid below.
      </p>
      <div className="twin-flat__grid" role="list">
        {layout.map((entry) => (
          <button
            key={entry.block.id}
            type="button"
            role="listitem"
            className={`twin-flat__cell${selected === entry.block.id ? ' twin-flat__cell--selected' : ''}`}
            style={{ borderTopColor: entry.colour }}
            aria-pressed={selected === entry.block.id}
            onClick={() => onSelect(entry.block.id)}
          >
            <strong>{entry.block.officialName}</strong>
            <span className="small muted">
              {entry.stats ? `${entry.stats.open} open · ${entry.stats.total} total` : 'No issues recorded'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function CampusTwinPage() {
  /** Checked once; a later context loss flips it off too. */
  const [webgl, setWebgl] = useState<{ ok: boolean; reason: string }>(() =>
    detectWebGL()
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'This browser or device did not provide WebGL.' },
  );
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
    /*
     * ROWS IS NEEDED TO CENTRE `z`, WHICH IS NOT SYMMETRIC BY DEFAULT.
     *
     * `x` was always centred about the origin, but `z` ran 0, 0, 0, 9, 9, 9, 18 … — the
     * whole grid sat on one side of the camera's orbit target. Two blocks were therefore
     * pushed off the left edge of the canvas and the layout looked lopsided for no reason
     * a viewer could see. Subtracting half the row span puts the grid's centre on the
     * origin, which is also what the orbit target assumes.
     */
    const rows = Math.max(1, Math.ceil(items.length / columns));
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
        x: (index % columns) * CELL_SPACING - ((columns - 1) * CELL_SPACING) / 2,
        z: (Math.floor(index / columns) - (rows - 1) / 2) * CELL_SPACING,
      };
    });
  }, [blocks.data, summary.data, critical.data]);

  /**
   * Camera framing, derived from where the blocks actually ended up.
   *
   * A FIXED CAMERA POSITION CANNOT BE RIGHT FOR EVERY WORKSPACE. The REAL and DEMO
   * workspaces hold different numbers of blocks, and the grid grows with the square root of
   * that count — so any position chosen when there were eight blocks clips the outer ring
   * once there are twenty. Comfortably fitting a sphere around the layout instead means the
   * view is correct for four blocks and for forty, and it keeps being correct when someone
   * adds a block through the admin console.
   */
  const framing = useMemo(() => {
    if (layout.length === 0) {
      return { position: [26, 23, 30] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
    }
    const xs = layout.map((entry) => entry.x);
    const zs = layout.map((entry) => entry.z);
    const minX = Math.min(...xs) - BLOCK_SIZE / 2;
    const maxX = Math.max(...xs) + BLOCK_SIZE / 2;
    const minZ = Math.min(...zs) - BLOCK_SIZE / 2;
    const maxZ = Math.max(...zs) + BLOCK_SIZE / 2;

    const centre: [number, number, number] = [(minX + maxX) / 2, 0, (minZ + maxZ) / 2];
    // Radius of the circle that contains the whole footprint, seen from any azimuth.
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    // Standard fit-sphere distance, plus a margin so the nearest box is not flush with the edge.
    const halfFov = ((CAMERA_FOV / 2) * Math.PI) / 180;
    const distance = (radius / Math.sin(halfFov)) * 1.08;

    return {
      position: [
        centre[0] + VIEW_DIRECTION.x * distance,
        VIEW_DIRECTION.y * distance,
        centre[2] + VIEW_DIRECTION.z * distance,
      ] as [number, number, number],
      target: centre,
    };
  }, [layout]);

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
              {!webgl.ok ? (
                <FlatTwin layout={layout} selected={selected} onSelect={setSelected} reason={webgl.reason} />
              ) : (
              <TwinBoundary
                fallback={
                  <FlatTwin
                    layout={layout}
                    selected={selected}
                    onSelect={setSelected}
                    reason="The 3D renderer failed to start on this device."
                  />
                }
              >
              <div className="twin">
                <Canvas
                  onCreated={({ gl }) => {
                    gl.domElement.addEventListener('webglcontextlost', (event) => {
                      event.preventDefault();
                      setWebgl({ ok: false, reason: 'The graphics context was lost (GPU reset or memory pressure).' });
                    });
                  }}
                  // A fixed camera, a flat light, no shadows: this is a diagram, and lighting
                  // tricks would only make it look more authoritative than it is.
                  camera={{ position: framing.position, fov: CAMERA_FOV }}
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
                  <CameraControls position={framing.position} target={framing.target} />
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
                </div>
              </div>
              </TwinBoundary>
              )}

              {/* THE KEY SITS BELOW THE CANVAS, NOT ON TOP OF IT. It used to be absolutely
                  positioned over the scene, and in a real browser it covered a block box and the
                  note covered the top strip — the same "a block looks missing" defect the camera
                  fit fixed, reintroduced by the overlays. A screen whose job is to show every
                  block must not draw opaque cards over some of them. */}
              <div className="twin__key">
                <div className="twin__notice">
                  <strong>Schematic layout.</strong> Grid position is generated from each block's
                  id, not from latitude and longitude. Drag to orbit, scroll to zoom, click a box
                  for its details.
                </div>
                <div className="twin__legend" aria-label="Colour key">
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

              <p className="small muted mt-3">
                {webgl.ok
                  ? `Rendering ${layout.length} block${layout.length === 1 ? '' : 's'} with real WebGL. `
                  : `Showing ${layout.length} block${layout.length === 1 ? '' : 's'} without WebGL. `}
                The boxes are drawn from data; no 3D model of this campus has been loaded, because none
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
        <boxGeometry args={[BLOCK_SIZE, height, BLOCK_SIZE]} />
        <meshLambertMaterial color={colour} />
      </mesh>

      {/* A wireframe overlay makes a selected block obvious without relying on colour alone,
          which matters for anyone who cannot distinguish the red and amber. A plain
          wireframe box, so no line primitive or extra dependency is needed. */}
      {isSelected && (
        <mesh scale={1.02}>
          <boxGeometry args={[BLOCK_SIZE, height, BLOCK_SIZE]} />
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
