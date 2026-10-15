# Phase 3 — proposed text for the missing sections

Your brief stops mid-sentence at **§15**. This document proposes the missing sections so
you can correct them before the work lands. Everything up to §14 is taken verbatim from
your brief; nothing below contradicts it.

**Sections 1–14 are unchanged and binding.** This covers §15 onward.

---

## §15. Administration pages

*[Your §15 heading, completed.]*

Build the admin-only pages, each reading and writing through the existing `/v1/admin/*`
endpoints. Where an endpoint does not exist, implement it in the existing backend
conventions (see §4 of `docs/PHASE3_AUDIT.md`) rather than mocking it in the client.

**15.1 Accounts and roles** — `GET /v1/admin/users`, `PATCH /v1/admin/users/:id/role`,
`PATCH /v1/admin/users/:id/status`.
List accounts with role, department and status; filter by role and status; search by email
or name. Changing a role or suspending an account requires a confirmation step naming the
account and the consequence. An administrator must not be able to demote or suspend their
own account — the guard exists in the backend and the UI must surface its refusal rather
than prevent the click and pretend it never happened.

**15.2 Campus blocks and spots** — `GET /v1/campus/blocks`, `POST /v1/admin/blocks`,
`PATCH /v1/admin/blocks/:id`, `POST /v1/admin/spots`.
List blocks with their spot counts and coordinates; create a block; edit a block's name,
description and coordinates; deactivate rather than delete. Blocks still labelled
`(placeholder)` are marked as such in the UI, so nobody mistakes the seed data for the
official campus list. Adding a spot requires selecting its block.

**15.3 Categories** — `GET /v1/campus/categories`, `POST /v1/admin/categories`, plus the
new `PATCH /v1/admin/categories/:id`.
List categories with the number of issues filed against each. Create and rename.
Deactivating a category that has issues filed against it is **refused**, not silently
allowed — historical issues must keep a resolvable category. A category's `description` is
an input to the AI classifier (§5a of `docs/AI_MODEL.md`), so editing it warns that
classification prompts change with it.

**15.4 Audit and system state** — `GET /v1/admin/audit`, `GET /v1/admin/outbox`,
`GET /v1/admin/ai/status`, `GET /v1/events/types`.
A read-only view of sensitive actions, undelivered events, the configured AI provider, and
the declared event contract. This page states plainly what is **not** implemented — the
live event transport among them — instead of hiding it.

**15.5 Issue administration** — HOD/ADMIN: the ability to correct a category and set
severity on an issue, both audited. No endpoint deletes an issue; the history is the
record.

---

## §16. Testing and verification

**16.1 Frontend tests.** Component and logic tests for: the API client's error-envelope
handling; role-based route guards (including that a student reaching an HOD URL is denied);
token and date formatting; status and severity badge mapping; the report flow's
validation and duplicate-submit prevention; the evidence-blob loader's authorization
failure path. These run in the existing Vitest setup.

**16.2 Backend tests for new endpoints.** Every endpoint added under §4 of the audit gets
tests: authorization per role, workspace isolation, and the failure paths (category in use,
self-demotion, invalid severity).

**16.3 End-to-end verification.** An HTTP-level test of the complete journey the project
exists to demonstrate: student registers a report with a photo → AI analyses it → the HOD
sees the analysis, reviews, approves, starts and resolves it → the student sees the
resolution and the token ledger shows exactly one idempotent credit.

**16.4 Performance.** The issue list, dashboards and twin must stay usable with the
existing data volume, and must not fetch unbounded result sets. Pagination is server-side.

**16.5 Accessibility and responsive checks.** Keyboard reachability for the primary flows,
visible focus states, labelled form controls, and the student flow usable at a 360 px
viewport.

**16.6 Honesty rules.** No test may assert a fabricated value. Any screenshot or claim in
the final report must come from a real run against the real backend.

---

## §17. Definition of done

Phase 3 is complete only when all of the following are true and were verified by execution:

1. An existing user can log in and lands on a dashboard appropriate to their role.
2. Role-based routing is enforced in the client **and** by the backend; a student typing an
   HOD URL is refused by the server, not merely hidden from.
3. A student can capture a photograph in the browser, select a block and spot, choose a
   category, submit, and see the **actual** server response — including the reference
   number and the real token outcome.
4. The gallery-upload path is absent from the student reporting flow.
5. A student sees only their own reports, and never another student's identity, detail or
   photograph. Verified by requesting another user's evidence and receiving 403.
6. The token panel reads balance and ledger from the server, shows reversals, and never
   computes an authoritative balance in the client.
7. The HOD can review an issue's AI analysis, correct the category, drive the permitted
   status transitions, and resolve with a required note.
8. The HOD page distinguishes AI recommendation, human decision and workflow status
   visually and unambiguously.
9. Concurrent conflicting updates cannot silently overwrite: the optimistic-concurrency
   guard is used and a stale write surfaces a clear conflict message.
10. The admin dashboard's every number is derived from backend aggregation, with no
    hardcoded figures.
11. The 3D twin renders interactive campus geometry, selecting a building shows its real
    counts and issue list, and the whole thing is **clearly labelled schematic** pending
    official campus data.
12. The twin degrades to a usable 2D/selector fallback when WebGL is unavailable, and never
    presents a static image as an interactive model.
13. Empty, loading, error and permission-denied states exist on every data page.
14. Real and demo workspaces are visually distinguishable.
15. The frontend consumes `@campus/contracts`, so client and server cannot drift silently.
16. All tests pass on both PGlite and native PostgreSQL, and the HTTP smoke test passes.
17. Any feature not implemented is labelled as not implemented in the UI, not faked.

---

## §18. Required final report

1. Repository changes, with the frontend's file layout.
2. Frontend stack chosen, and the justification for each added dependency.
3. Every screen implemented, mapped to the role that can reach it.
4. Backend endpoints added, with their authorization rules.
5. The design system: tokens, components, and how they are reused.
6. 3D twin implementation, its data interface, and exactly what is schematic.
7. Tests executed, with actual results — frontend, backend and end-to-end.
8. Windows setup and run commands for both applications.
9. Screenshots or equivalent evidence from a real run.
10. Remaining defects, known limitations, and what is deliberately not built.
11. Which Phase 2 stages remain open, and what the UI does until they land.

---

## §19. Explicitly out of scope for Phase 3

Naming these so they cannot be quietly assumed:

- **A native mobile application.** The student experience is a mobile-first web app, per
  the decision recorded in Phase 1. No Expo, Flutter or Android build.
- **Real-time transport.** `GET /v1/events/stream` stays a documented 501. The UI shows
  event *history* from the outbox; it does not claim live push.
- **AI duplicate detection and severity/repair recommendations.** These are Phase 2
  Stages 5–6. The UI renders their absence honestly and lights up when they land.
- **Official campus geometry.** The twin is schematic until real assets are supplied.
- **Offline operation.** No service worker or offline queue.
- **Payments, notifications by SMS/email, and SSO.** None are implemented or implied.

---

## Correction slot

If any of the above misstates your intent, tell me the section number and I will follow
your wording instead. I am treating §1–§14 as fixed and building against them now, since
this document only completes sections that were absent.
