# What I need from you

**Short version: Phase 1 is already finished and verified. Nothing on this page is blocking the
code.** The list below is what I need from *you* — the things only you can supply — grouped by what
they unblock. If you send nothing at all, the system still runs; it just runs on placeholder campus
names and a demo dataset.

Last updated: 2026-10-16

---

## 0. The one item that was blocking is now closed

Stage 1 flagged **"is there an existing repository to inspect?"** as a blocking unknown, because
building a fresh scaffold over a real repository I had never seen is how you lose a codebase.

You have now answered it: *"this is my new project."* So the answer is **greenfield**, the build went
greenfield, and there is nothing to reconcile. That open question is formally closed — no action from
you. If an existing DSU repo or a teammate's earlier attempt shows up later, send it and I will
reconcile rather than restart.

---

## 1. To verify it yourself on your Windows machine — ~30 minutes

This is the one thing worth doing before anything else. You should not take my word for it.

| What | How to get it |
|---|---|
| A Windows PC with **Node.js 20 or newer** | `winget install OpenJS.NodeJS.LTS` in PowerShell, or download from <https://nodejs.org> (LTS). Check with `node -v`. |
| **Nothing else** | No Docker. No PostgreSQL install. No database server. The app runs on PGlite (PostgreSQL compiled to WebAssembly), so the database starts with the app. |
| The project itself | Everything is in this workspace — download it as a zip/folder. `node_modules` is not included; `npm install` fetches it. |

Then follow **`docs/RUNBOOK.md`** exactly — it is written for Windows and includes the one trap that
cost me an hour (`#` in `.env` values must be quoted, or logins fail confusingly). Start with:

```powershell
npm install
npm run migrate
npm run seed
npm run dev
node scripts/smoke-test.mjs
```

Expected last line: `50 passed, 0 failed`. If you get that, you have independently confirmed Phase 1.

**Optional, only if you want the full 99/99 test run:** install PostgreSQL 17 and point
`TEST_DATABASE_URL` at a **throwaway** database — the tests drop and recreate the `public` schema.
Two of the 99 tests need a real server (they test genuine parallel transactions); on PGlite the score
is 97 passed / 2 skipped, which is expected, not a failure.

---

## 2. To make it *DSU's* system rather than a generic one — not blocking, but needed before a demo

Right now the campus data is 8 blocks and ~60 spots named **`(placeholder)`**, and the seeded
accounts are `@demo.dsu.edu.in`. That was deliberate: I refused to invent block names and present
them as your campus. Here is what replaces them.

### 2a. Official campus data ⭐ the highest-value item

| What exactly | How to get it |
|---|---|
| Official **block / building names** as the university writes them ("Academic Block A", "Sir M. Visvesvaraya Block", …) | DSU main-campus map (university website / admin office), the student handbook, or the physical signage. A photo of the campus map board works. |
| A **short code or slug** per block, if one exists internally | Ask the facilities/estate office. If none exists, I will generate them. |
| **Floors** per building and what is on them (Ground / 1st / 2nd / Terrace) | The campus map, or a walk-through. |
| **Named spots** per floor where a defect would actually be reported — corridor, washroom block, lift lobby, stairwell, lab, canteen counter, parking row, street-light pole | Best done by walking the block with a phone and a notebook. The seed lists ~60 spots as a model of the right granularity. |
| **Latitude / longitude per block** (nice to have) | Right-click the building in Google Maps → click the coordinates to copy. Used as the map anchor for the future 3D twin. Advisory only — a report is never rejected for missing coordinates. |

**Easiest format:** fill in **`docs/templates/campus-data.csv`** — one row per spot, blocks repeating
down the sheet. Send it back and I will load it. It does not need to be complete; a partial list
beats invented names.

### 2b. Who owns what (department → HOD)

The system routes an issue to a role, not yet to a named person. To make approvals realistic I need:

- The list of **departments** at main campus (CSE, ECE, Mechanical, Civil, Admin, Hostel, Estate…).
- Which **block(s) and/or defect category** each department is responsible for.
- One **real contact** per department for the demo accounts (a real institutional email, or you tell
  me the naming pattern and I generate the addresses).

How to get it: the academic handbook / department office, or the estate-maintenance office, who
almost always already have a **written allocation of who fixes what**. If that document exists, it is
the single best input you can give me — the whole routing design should follow reality.

### 2c. Identity and branding (cosmetic, easy)

- The real **email domain** your students use (e.g. `@dsu.edu.in`) so accounts look right.
- **Logo** (PNG/SVG) and the **brand colours** (the site's blue/white/red-ish scheme) for the Phase 2 UIs.
- Whether the student login should eventually be **email + password** or **college SSO / Google Workspace**.
  Today it is email + password with hashed tokens; SSO is a Phase 2 adapter, but the answer changes the design.

---

## 3. To start Phase 2 — decisions only you can make

Small, but each one changes the shape of work, so I will not pick for you:

1. **Hosting / hardware.** One campus server, a cloud VM, or a laptop for the demo? Determines the
   real-time transport and object storage choices.
2. **Photo storage in production.** Local disk is fine for the demo; a real deployment needs
   S3-compatible storage. Do you have AWS / Azure / anything, or should I keep it local and swappable?
3. **Dedupe granularity.** Today two different defects of the same category at the same named spot
   merge into one ticket — deliberately conservative so nothing is silently lost. Keep that, or
   choose a different rule (page 30 m radius, per-photo)?
4. **PostgreSQL row-level security.** Workspace isolation is currently enforced in the repository
   layer and proven by tests. RLS would add database-level defence-in-depth. Worth doing, but it must
   be built and tested carefully against connection pooling — I will not claim it until it passes.
5. **Who is the first real HOD account** for piloting, and in **which block** does the pilot run?
   A one-block pilot is how I would de-risk the AI stage.

---

## 4. For the AI stage specifically (Phase 2) — the one thing that cannot be bought

You ruled out **paid AI APIs**, so the classifier has to run locally on free, open models. Those
models are trained on generic images and will be weak on DSU's actual corridors — so the highest-value
asset you can build *now*, while I build Phase 2, is a **photo dataset of your own campus**:

- **Several hundred photos per defect category** (broken lighting, damaged doors, water leakage,
  damaged furniture, electrical hazards, cleanliness, …), taken **on your phones**, ideally from the
  angle a student would actually shoot from.
- Include **"everything is fine" photos** — a correctly working corridor, a normal washroom. The
  system must learn to *reject* bad reports, not just accept good ones. Without these it will call
  every photo a defect.
- **A few duplicates and near-duplicates** on purpose (same defect shot twice, different lighting) so
  I can honestly measure duplicate detection instead of guessing.
- Anything you already have: **existing maintenance complaint photos, a WhatsApp group's backlog, a
  paper complaint register.** Real historical data with the outcome attached ("this got fixed", "this
  was a false alarm") is worth more than a perfectly labelled fresh set.

How to collect it: one afternoon per category, one or two students per block, phones, upload to a
shared Drive folder with the category as the folder name. Do not carefully frame each shot — messy is
better, because messy is what students will actually send.

If this never happens, the AI stage degrades to a weak generic model. If it happens, Phase 2 has
something real to stand on.

---

## 5. Summary — what to do, in order

| Priority | Item | Effort | Blocks what |
|---|---|---|---|
| 1 | Run it on your Windows machine (`docs/RUNBOOK.md`) | 30 min | Your own confidence in Phase 1 |
| 2 | Official block + spot list → `docs/templates/campus-data.csv` | An afternoon walk | A convincing demo |
| 3 | Department → responsibility allocation | One ask at the estate office | Realistic issue routing |
| 4 | The five Phase 2 decisions in §3 | A short reply | Starting Phase 2 |
| 5 | Campus photo dataset | Ongoing, an afternoon per category | The AI stage being real rather than generic |

**Items 2–5 are yours to gather at your own pace. Item 1 is the only one I would do this week.**
Nothing here is a prerequisite for Phase 1 being complete — it already is — and I will not start
Phase 2 until you tell me to.
