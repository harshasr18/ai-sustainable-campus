# How to fill in `campus-data.csv`

One row = **one spot** (one specific place a student could report a defect from). The block columns
repeat on every row of that block. This is the format that is easiest to fill in from a paper campus
map or a walk-through, and the easiest for me to load.

Open it in **Excel** (Windows: right-click → Open with → Excel), or Google Sheets. Columns:

| Column | Required? | What to put |
|---|---|---|
| `block_slug` | yes | Lowercase, hyphens, no spaces. `academic-block-a`. Reuse the **same** slug on every row of the same block — that is how rows group into blocks. |
| `block_official_name` | yes | The name the university actually uses. This is what students will see. |
| `block_description` | no | One short line, e.g. "General classrooms and lecture halls". |
| `block_latitude` | no | Right-click the building in Google Maps → click the coordinate text to copy, then paste the latitude here (e.g. `12.8612`). |
| `block_longitude` | no | Same, second number (`77.5525`). |
| `spot_official_name` | yes | e.g. `Ground Floor - Washroom Block`. Should make sense to someone standing there. |
| `spot_floor_label` | no | `Ground`, `1st Floor`, `2nd Floor`, `Terrace`… |
| `spot_area_label` | no | `Corridor`, `Washroom`, `Classroom`, `Stairwell`, `Lift Lobby`, `Parking` … |
| `spot_latitude` | no | Only if you want a spot pinned more precisely than its block. Leave blank otherwise. |
| `spot_longitude` | no | As above. |

## Rules that matter

- **Rows can be partial.** A half-filled sheet is genuinely useful. Missing coordinates are fine —
  nothing in the system requires them, and no report is ever rejected for a missing location pin.
- **Do not invent names to fill the sheet.** A short list of real names is worth far more than a long
  list of plausible ones. I deliberately did not guess your campus, and I am not going to now.
- **Commas inside a field** will break the file. Use a hyphen or `&` instead:
  `Cafeteria & Food Court`, not `Cafeteria, Food Court`.
- **Slide counter-examples.** Leave the 8 example rows in place or overwrite them — either is fine,
  but do not mix real names into the example blocks, or the demo dataset will contain half-invented
  buildings.

## When you send it back

I will load it into the seed, re-run the migration/seed, and confirm: block count, spot count, and
that the location selector in the API returns your real names. Send it as a `.csv` and I will take it
from there.

If your facilities office already has this as a **Word/Excel document or a PDF floor plan**, send that
instead — do not retype it into this template. I would rather convert your real document than have you
transcribe it twice.
