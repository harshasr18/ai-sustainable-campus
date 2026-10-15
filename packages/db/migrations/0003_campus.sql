-- 0003 — Campus blocks, named spots, issue categories.
--
-- Brief Section 7C: GPS is NOT required for a valid report. The student-selected
-- block + named spot are authoritative for the reported location unless an
-- authorized review corrects it. Spot coordinates are advisory reference data.

CREATE TABLE campus_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  official_name text NOT NULL,
  slug          text NOT NULL,
  description   text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_blocks_workspace_slug UNIQUE (workspace_id, slug)
);

CREATE TABLE campus_spots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  block_id       uuid NOT NULL REFERENCES campus_blocks(id) ON DELETE RESTRICT,
  official_name  text NOT NULL,
  building_label text,
  floor_label    text,
  area_label     text,
  latitude       double precision,
  longitude      double precision,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_spot_lat CHECK (latitude  IS NULL OR (latitude  >= -90  AND latitude  <= 90)),
  CONSTRAINT ck_spot_lng CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  CONSTRAINT ux_spots_block_name UNIQUE (block_id, official_name)
);
CREATE INDEX ix_spots_block ON campus_spots (block_id) WHERE active;

CREATE TABLE issue_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_categories_slug UNIQUE (slug)
);

-- Categories are CONFIGURABLE DATA, never hardcoded in business logic.
INSERT INTO issue_categories (name, slug, description) VALUES
  ('Water Leakage',        'water-leakage',        'Leaking pipes, taps, tanks, or seepage'),
  ('Damaged Furniture',    'damaged-furniture',    'Broken desks, chairs, benches, fixtures'),
  ('Potholes & Roads',     'potholes',             'Potholes, broken paving, road damage'),
  ('Broken Lighting',      'broken-lighting',      'Non-functional lights, lamps, street lights'),
  ('Damaged Doors',        'damaged-doors',        'Broken locks, doors, windows, gates'),
  ('Damaged Toilets',      'damaged-toilets',      'Toilet, plumbing, or sanitation fixtures'),
  ('Waste Management',     'waste',                'Accumulated garbage or missed collection'),
  ('Greenery Maintenance', 'greenery-maintenance', 'Tree, hedge, lawn, or garden upkeep');
