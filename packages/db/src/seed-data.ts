/**
 * Campus reference data.
 *
 * ⚠️  PLACEHOLDER DATA — NOT official Dayananda Sagar University block names.
 * The brief listed "Official campus information — block and facility names, plus
 * available map/building assets" as an UNRESOLVED item. Rather than invent names
 * and present them as fact, these are representative placeholders that:
 *   - let the location selector and 3D campus be developed immediately, and
 *   - are renamed/replaced through the admin API (or by editing this file) once
 *     the official list is confirmed.
 *
 * Nothing in the domain or API layer references these names. They are pure data,
 * exactly as the brief requires ("Make categories configurable", ids are the keys).
 *
 * `mapAnchor` is reference geometry for the future 3D digital twin; it is advisory
 * and never required for a valid report (brief Section 7C).
 */

export interface SeedSpot {
  officialName: string;
  floorLabel?: string;
  areaLabel?: string;
  latitude?: number;
  longitude?: number;
}

export interface SeedBlock {
  slug: string;
  officialName: string;
  description: string;
  /** Advisory lat/lng used as a sensible default when a spot has no coordinates. */
  latitude: number;
  longitude: number;
  spots: SeedSpot[];
}

/** Coordinates approximate the DSU main campus area (Bengaluru) for map anchoring. */
const CAMPUS_CENTER = { latitude: 12.8612, longitude: 77.5525 };

export const SEED_BLOCKS: SeedBlock[] = [
  {
    slug: 'academic-block-a',
    officialName: 'Academic Block A (placeholder)',
    description: 'General classrooms and lecture halls',
    latitude: CAMPUS_CENTER.latitude + 0.0009,
    longitude: CAMPUS_CENTER.longitude + 0.0004,
    spots: [
      { officialName: 'Ground Floor — Corridor', floorLabel: 'Ground', latitude: CAMPUS_CENTER.latitude + 0.0009, longitude: CAMPUS_CENTER.longitude + 0.0004 },
      { officialName: 'Ground Floor — Washroom Block', floorLabel: 'Ground', areaLabel: 'Washroom' },
      { officialName: 'First Floor — Room 101', floorLabel: '1st Floor' },
      { officialName: 'First Floor — Room 110', floorLabel: '1st Floor' },
      { officialName: 'Terrace / Roof Area', floorLabel: 'Terrace' },
    ],
  },
  {
    slug: 'engineering-computing',
    officialName: 'Engineering & Computing Block (placeholder)',
    description: 'Engineering and computing departments, labs',
    latitude: CAMPUS_CENTER.latitude + 0.0004,
    longitude: CAMPUS_CENTER.longitude + 0.0011,
    spots: [
      { officialName: 'Main Entrance Lobby', floorLabel: 'Ground' },
      { officialName: 'Computer Lab 1', floorLabel: '1st Floor' },
      { officialName: 'Computer Lab 2', floorLabel: '2nd Floor' },
      { officialName: 'Washroom — 1st Floor', floorLabel: '1st Floor', areaLabel: 'Washroom' },
      { officialName: 'Stairwell — East Wing', areaLabel: 'Stairwell' },
    ],
  },
  {
    slug: 'central-library',
    officialName: 'Central Library (placeholder)',
    description: 'Library, reading rooms, study areas',
    latitude: CAMPUS_CENTER.latitude + 0.0001,
    longitude: CAMPUS_CENTER.longitude - 0.0006,
    spots: [
      { officialName: 'Reading Hall', floorLabel: 'Ground' },
      { officialName: 'Reference Section', floorLabel: '1st Floor' },
      { officialName: 'Washroom Block', areaLabel: 'Washroom' },
    ],
  },
  {
    slug: 'medical-centre',
    officialName: 'Medical Centre / Health Facility (placeholder)',
    description: 'Campus medical facilities',
    latitude: CAMPUS_CENTER.latitude - 0.0007,
    longitude: CAMPUS_CENTER.longitude + 0.0003,
    spots: [
      { officialName: 'Consultation Room' },
      { officialName: 'Waiting Area' },
      { officialName: 'Washroom' , areaLabel: 'Washroom' },
    ],
  },
  {
    slug: 'hostel-block',
    officialName: 'Hostel Block (placeholder)',
    description: 'Student residential facilities',
    latitude: CAMPUS_CENTER.latitude - 0.0014,
    longitude: CAMPUS_CENTER.longitude - 0.0009,
    spots: [
      { officialName: 'Common Room' },
      { officialName: 'Washroom — Ground Floor', areaLabel: 'Washroom' },
      { officialName: 'Water Tank / Supply Area', areaLabel: 'Utility' },
      { officialName: 'Corridor — East' },
    ],
  },
  {
    slug: 'cafeteria',
    officialName: 'Cafeteria & Food Court (placeholder)',
    description: 'Dining and food services',
    latitude: CAMPUS_CENTER.latitude - 0.0003,
    longitude: CAMPUS_CENTER.longitude + 0.0008,
    spots: [
      { officialName: 'Dining Hall' },
      { officialName: 'Kitchen Service Area' },
      { officialName: 'Handwash Station', areaLabel: 'Washroom' },
    ],
  },
  {
    slug: 'roads-parking',
    officialName: 'Internal Roads & Parking (placeholder)',
    description: 'Campus roads, driveways, parking bays',
    latitude: CAMPUS_CENTER.latitude,
    longitude: CAMPUS_CENTER.longitude,
    spots: [
      { officialName: 'Main Gate Road', areaLabel: 'Road' },
      { officialName: 'Parking Bay — North', areaLabel: 'Parking' },
      { officialName: 'Parking Bay — South', areaLabel: 'Parking' },
      { officialName: 'Service Road Near Hostel', areaLabel: 'Road' },
    ],
  },
  {
    slug: 'sports-gardens',
    officialName: 'Sports Grounds & Gardens (placeholder)',
    description: 'Outdoor sports infrastructure and campus greenery',
    latitude: CAMPUS_CENTER.latitude + 0.0015,
    longitude: CAMPUS_CENTER.longitude - 0.0015,
    spots: [
      { officialName: 'Main Sports Ground', areaLabel: 'Outdoor' },
      { officialName: 'Garden — East Lawn', areaLabel: 'Greenery' },
      { officialName: 'Garden — Near Library', areaLabel: 'Greenery' },
      { officialName: 'Outdoor Seating Area', areaLabel: 'Outdoor' },
    ],
  },
];
