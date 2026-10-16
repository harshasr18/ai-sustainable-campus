/**
 * Phase 5 — one master issue, many reports; uncertain matches go to a human.
 *
 * Integration tests over the real HTTP app + in-memory PGlite. The analyzer is a MOCK that
 * returns a chosen category: these tests exercise the duplicate RULES, the merge and the
 * authorization, not the vision model. Every test runs in its own freshly created block so
 * the "same block" rule cannot see other tests' issues.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiAnalysisResult } from '@campus/contracts';
import type { AiAnalysisRequest, AiAnalyzer } from '@campus/domain';
import { runAnalysis } from '../apps/api/src/routes/analysis.js';
import { auth, createTestContext, errorCode, submitReport, type TestContext } from './helpers.js';

let ctx: TestContext;
let catA: string; // e.g. the first active category
let catB: string; // a different one

beforeAll(async () => {
  ctx = await createTestContext();
  const cats = await ctx.db.query<{ id: string }>(`SELECT id FROM issue_categories WHERE active ORDER BY slug LIMIT 2`);
  catA = cats.rows[0]!.id;
  catB = cats.rows[1]!.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});

/** MOCK analyzer: predicts `predictCategoryId` (or the student's own choice) at 0.9. */
function mockAnalyzer(predictCategoryId?: string): AiAnalyzer {
  return {
    provider: 'stub-for-tests',
    model: 'stub-model',
    modelVersion: 'test',
    async analyze(request: AiAnalysisRequest): Promise<AiAnalysisResult> {
      const chosen = request.candidateCategories.find((c) => c.slug === request.selectedCategorySlug)!;
      const predicted = predictCategoryId ?? chosen.id;
      const agrees = predicted === chosen.id;
      return {
        reportId: request.reportId,
        provider: 'stub-for-tests',
        model: 'stub-model',
        modelVersion: 'test',
        status: agrees ? 'SUCCEEDED' : 'NEEDS_HUMAN_REVIEW',
        predictedCategoryId: predicted,
        categoryMatchesStudentSelection: agrees,
        confidence: 0.9,
        severity: null,
        repairRecommendation: null,
        duplicateCandidates: [],
        requiresHumanReview: !agrees,
      };
    },
  };
}

async function newBlock(spots = 3) {
  const b = await ctx.db.query<{ id: string }>(
    `INSERT INTO campus_blocks (workspace_id, official_name, slug) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.ids.demoWorkspaceId, `Test Block ${randomUUID().slice(0, 6)}`, `tb-${randomUUID()}`],
  );
  const blockId = b.rows[0]!.id;
  const spotIds: string[] = [];
  for (let i = 0; i < spots; i += 1) {
    const s = await ctx.db.query<{ id: string }>(
      `INSERT INTO campus_spots (workspace_id, block_id, official_name) VALUES ($1, $2, $3) RETURNING id`,
      [ctx.ids.demoWorkspaceId, blockId, `Spot ${i + 1}`],
    );
    spotIds.push(s.rows[0]!.id);
  }
  return { blockId, spotIds };
}

async function report(token: string, blockId: string, spotId: string, categoryId: string) {
  const { res, json } = await submitReport(ctx, token, { blockId, spotId, selectedCategoryId: categoryId });
  expect(res.statusCode).toBe(200);
  return json as { reportId: string; issueId: string; duplicateOfExistingIssue: boolean };
}

const analyse = (reportId: string, predict?: string) =>
  runAnalysis(ctx.db, mockAnalyzer(predict), ctx.ids.demoWorkspaceId, reportId, null, 'DEMO');

async function suggestionsFor(reportId: string) {
  const r = await ctx.db.query<{ id: string; reason_code: string; candidate_issue_id: string; status: string; signals: Record<string, unknown> }>(
    `SELECT id, reason_code, candidate_issue_id, status, signals FROM duplicate_suggestions WHERE report_id = $1`,
    [reportId],
  );
  return r.rows;
}

async function matchStatus(reportId: string) {
  const r = await ctx.db.query<{ duplicate_match_status: string; issue_id: string }>(
    `SELECT duplicate_match_status, issue_id FROM reports WHERE id = $1`,
    [reportId],
  );
  return r.rows[0]!;
}

describe('confirmed duplicates — the deterministic rule', () => {
  it('1. one unique report creates one master issue and, once analysed, no suggestion', async () => {
    const { blockId, spotIds } = await newBlock();
    const r = await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    expect(r.duplicateOfExistingIssue).toBe(false);
    await analyse(r.reportId);
    expect(await suggestionsFor(r.reportId)).toHaveLength(0);
    expect((await matchStatus(r.reportId)).duplicate_match_status).toBe('NO_MATCH');
  });

  it('2+3+7. five reports of one defect → one actionable master issue with five linked reports', async () => {
    const { blockId, spotIds } = await newBlock();
    const tokens = [ctx.tokens.student, ctx.tokens.student2, ctx.tokens.student, ctx.tokens.student2, ctx.tokens.hod];
    const results = [];
    for (const t of tokens) results.push(await report(t, blockId, spotIds[0]!, catA));
    expect(new Set(results.map((r) => r.issueId)).size).toBe(1);
    expect(results.filter((r) => r.duplicateOfExistingIssue)).toHaveLength(4);

    const issues = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM issues WHERE block_id = $1 AND status NOT IN ('RESOLVED','DUPLICATE')`,
      [blockId],
    );
    expect(issues.rows[0]!.n).toBe(1);

    const res = await ctx.app.inject({ method: 'GET', url: `/v1/issues/${results[0]!.issueId}`, headers: auth(ctx.tokens.hod) });
    const body = res.json();
    expect(body.linkedReportCount ?? body.issue?.reportCount).toBe(5);
  });

  it('9. concurrent submissions of one defect still produce one master issue', async () => {
    const { blockId, spotIds } = await newBlock();
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        submitReport(ctx, i % 2 ? ctx.tokens.student : ctx.tokens.student2, { blockId, spotId: spotIds[1]!, selectedCategoryId: catA }),
      ),
    );
    for (const r of all) expect(r.res.statusCode).toBe(200);
    expect(new Set(all.map((r) => r.json.issueId)).size).toBe(1);
  });
});

describe('uncertain matches become suggestions — never automatic merges', () => {
  it('4. a similar report in a DIFFERENT block is never suggested', async () => {
    const one = await newBlock();
    const two = await newBlock();
    await report(ctx.tokens.student, one.blockId, one.spotIds[0]!, catA);
    const other = await report(ctx.tokens.student2, two.blockId, two.spotIds[0]!, catA);
    await analyse(other.reportId);
    expect(await suggestionsFor(other.reportId)).toHaveLength(0);
  });

  it('5. a genuinely different issue in the same building (other spot, other category) is not suggested', async () => {
    const { blockId, spotIds } = await newBlock();
    await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    const different = await report(ctx.tokens.student2, blockId, spotIds[1]!, catB);
    await analyse(different.reportId);
    expect(await suggestionsFor(different.reportId)).toHaveLength(0);
    expect((await matchStatus(different.reportId)).duplicate_match_status).toBe('NO_MATCH');
  });

  it('6a. same block, different spot, same category, recent → suggestion for review (not merged)', async () => {
    const { blockId, spotIds } = await newBlock();
    const first = await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    const second = await report(ctx.tokens.student2, blockId, spotIds[1]!, catA);
    expect(second.issueId).not.toBe(first.issueId);
    await analyse(second.reportId);

    const sug = await suggestionsFor(second.reportId);
    expect(sug).toHaveLength(1);
    expect(sug[0]!.reason_code).toBe('SAME_BLOCK_SAME_CATEGORY_RECENT');
    expect(sug[0]!.candidate_issue_id).toBe(first.issueId);
    expect(sug[0]!.signals).toMatchObject({ sameBlock: true, sameSpot: false });
    expect(sug[0]!.signals).not.toHaveProperty('similarity');
    const m = await matchStatus(second.reportId);
    expect(m.duplicate_match_status).toBe('CANDIDATE_FOUND');
    expect(m.issue_id).toBe(second.issueId); // nothing moved
  });

  it('6b. same spot: student chose A, the model says B, and B is open there → suggestion', async () => {
    const { blockId, spotIds } = await newBlock();
    const existingB = await report(ctx.tokens.student, blockId, spotIds[2]!, catB);
    const choseA = await report(ctx.tokens.student2, blockId, spotIds[2]!, catA);
    expect(choseA.issueId).not.toBe(existingB.issueId);
    await analyse(choseA.reportId, catB);
    const sug = await suggestionsFor(choseA.reportId);
    expect(sug.map((s) => s.reason_code)).toEqual(['SAME_SPOT_AI_CATEGORY']);
    expect(sug[0]!.signals).toMatchObject({ sameSpot: true, modelCategoryMatchesCandidate: true, modelConfidence: 0.9 });
  });

  it('re-analysis does not pile up copies of the same suggestion', async () => {
    const { blockId, spotIds } = await newBlock();
    await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    const second = await report(ctx.tokens.student2, blockId, spotIds[1]!, catA);
    await analyse(second.reportId);
    await ctx.db.query(`UPDATE reports SET duplicate_match_status = 'NOT_CHECKED' WHERE id = $1`, [second.reportId]);
    await analyse(second.reportId);
    expect(await suggestionsFor(second.reportId)).toHaveLength(1);
  });
});

describe('mirrored pairs (found in the live duplicate-UI probe)', () => {
  it('two tickets analysed in one sweep produce ONE suggestion, not one in each direction', async () => {
    const { blockId, spotIds } = await newBlock();
    const first = await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    const second = await report(ctx.tokens.student2, blockId, spotIds[1]!, catA);
    // The worker sweeps oldest-first: the FIRST report is analysed after the second exists.
    await analyse(first.reportId);
    await analyse(second.reportId);
    const open = await ctx.db.query<{ source_issue_id: string; candidate_issue_id: string }>(
      `SELECT source_issue_id, candidate_issue_id FROM duplicate_suggestions
        WHERE status = 'OPEN' AND (source_issue_id IN ($1, $2) OR candidate_issue_id IN ($1, $2))`,
      [first.issueId, second.issueId],
    );
    expect(open.rows).toEqual([{ source_issue_id: first.issueId, candidate_issue_id: second.issueId }]);
    expect((await matchStatus(second.reportId)).duplicate_match_status).toBe('NO_MATCH');
  });

  it('a merge closes every open suggestion that proposed the merged ticket as a master', async () => {
    const { blockId, spotIds } = await newBlock();
    const a = await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    const b = await report(ctx.tokens.student2, blockId, spotIds[1]!, catA);
    const c = await report(ctx.tokens.student, blockId, spotIds[2]!, catA);
    await analyse(c.reportId); // c → a and c → b
    await analyse(b.reportId); // b → a (b → c is skipped: c → b is already open)
    const bToA = await ctx.db.query<{ id: string }>(
      `SELECT id FROM duplicate_suggestions WHERE source_issue_id = $1 AND candidate_issue_id = $2`,
      [b.issueId, a.issueId],
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/duplicate-suggestions/${bToA.rows[0]!.id}/confirm`,
      headers: auth(ctx.tokens.hod),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const stillOpen = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM duplicate_suggestions
        WHERE status = 'OPEN' AND (source_issue_id = $1 OR candidate_issue_id = $1)`,
      [b.issueId],
    );
    expect(stillOpen.rows[0]!.n).toBe(0);
    // c → a is unaffected and still awaits a decision.
    const cToA = await ctx.db.query<{ status: string }>(
      `SELECT status FROM duplicate_suggestions WHERE source_issue_id = $1 AND candidate_issue_id = $2`,
      [c.issueId, a.issueId],
    );
    expect(cToA.rows[0]!.status).toBe('OPEN');
  });
});

describe('HOD decides a suggestion', () => {
  async function scenario() {
    const { blockId, spotIds } = await newBlock();
    const master = await report(ctx.tokens.student, blockId, spotIds[0]!, catA);
    await analyse(master.reportId); // analysed before the second report exists → NO_MATCH
    const dup = await report(ctx.tokens.student2, blockId, spotIds[1]!, catA);
    await analyse(dup.reportId);
    const [sug] = await suggestionsFor(dup.reportId);
    return { blockId, master, dup, suggestionId: sug!.id };
  }

  it('a student can neither list nor decide suggestions (403)', async () => {
    const { suggestionId } = await scenario();
    for (const [method, url] of [
      ['GET', '/v1/duplicate-suggestions'],
      ['POST', `/v1/duplicate-suggestions/${suggestionId}/confirm`],
      ['POST', `/v1/duplicate-suggestions/${suggestionId}/dismiss`],
    ] as const) {
      const res = await ctx.app.inject({ method, url, headers: auth(ctx.tokens.student) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('confirm merges: one actionable issue, all reports traceable, credits preserved, history written', async () => {
    const { blockId, master, dup, suggestionId } = await scenario();
    const creditsBefore = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM token_transactions WHERE report_id = ANY($1::uuid[])`,
      [[master.reportId, dup.reportId]],
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/duplicate-suggestions/${suggestionId}/confirm`,
      headers: auth(ctx.tokens.hod),
      payload: { note: 'Same corridor light, reported from two doorways' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().masterIssueId).toBe(master.issueId);

    // One actionable issue left in the block; the merged ticket is terminal and points at it.
    const open = await ctx.db.query<{ id: string }>(
      `SELECT id FROM issues WHERE block_id = $1 AND status NOT IN ('RESOLVED','DUPLICATE')`,
      [blockId],
    );
    expect(open.rows.map((r) => r.id)).toEqual([master.issueId]);
    const merged = await ctx.db.query<{ status: string; duplicate_of_issue_id: string }>(
      `SELECT status, duplicate_of_issue_id FROM issues WHERE id = $1`,
      [dup.issueId],
    );
    expect(merged.rows[0]).toEqual({ status: 'DUPLICATE', duplicate_of_issue_id: master.issueId });

    // Both individual reports still exist and both now belong to the master.
    expect((await matchStatus(dup.reportId)).issue_id).toBe(master.issueId);
    expect((await matchStatus(dup.reportId)).duplicate_match_status).toBe('LINKED');
    const detail = await ctx.app.inject({ method: 'GET', url: `/v1/issues/${master.issueId}`, headers: auth(ctx.tokens.hod) });
    expect(detail.json().linkedReportCount ?? detail.json().issue?.reportCount).toBe(2);

    // The student who filed the duplicate still sees their own report, now on the master.
    const mine = await ctx.app.inject({ method: 'GET', url: `/v1/reports/${dup.reportId}`, headers: auth(ctx.tokens.student2) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().report.issueId).toBe(master.issueId);

    // Credits untouched by the merge.
    const creditsAfter = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM token_transactions WHERE report_id = ANY($1::uuid[])`,
      [[master.reportId, dup.reportId]],
    );
    expect(creditsAfter.rows[0]!.n).toBe(creditsBefore.rows[0]!.n);

    // History and audit record who merged, and the default issue list hides the merged shell.
    const hist = await ctx.db.query<{ new_status: string; reason: string; changed_by_user_id: string }>(
      `SELECT new_status, reason, changed_by_user_id FROM issue_status_history WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [dup.issueId],
    );
    expect(hist.rows[0]!.new_status).toBe('DUPLICATE');
    expect(hist.rows[0]!.reason).toMatch(/Merged into/);
    const list = await ctx.app.inject({ method: 'GET', url: `/v1/issues?blockId=${blockId}`, headers: auth(ctx.tokens.hod) });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([master.issueId]);

    // Deciding it twice is refused.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/v1/duplicate-suggestions/${suggestionId}/confirm`,
      headers: auth(ctx.tokens.hod),
    });
    expect(again.statusCode).toBe(409);
  });

  it('dismiss keeps both issues, marks the report HUMAN_OVERRIDDEN and moves nothing', async () => {
    const { master, dup, suggestionId } = await scenario();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/duplicate-suggestions/${suggestionId}/dismiss`,
      headers: auth(ctx.tokens.hod),
      payload: { note: 'Different rooms, two separate faults' },
    });
    expect(res.statusCode).toBe(200);
    const m = await matchStatus(dup.reportId);
    expect(m.duplicate_match_status).toBe('HUMAN_OVERRIDDEN');
    expect(m.issue_id).toBe(dup.issueId);
    expect(m.issue_id).not.toBe(master.issueId);
  });

  it('a ticket on which work has started cannot be merged away', async () => {
    const { dup, suggestionId } = await scenario();
    const claim = await ctx.app.inject({ method: 'POST', url: `/v1/issues/${dup.issueId}/claim`, headers: auth(ctx.tokens.hod), payload: {} });
    expect(claim.statusCode).toBe(200);
    for (const step of ['approve', 'start']) {
      const r = await ctx.app.inject({ method: 'POST', url: `/v1/issues/${dup.issueId}/${step}`, headers: auth(ctx.tokens.hod), payload: {} });
      expect(r.statusCode, r.body).toBe(200);
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/duplicate-suggestions/${suggestionId}/confirm`,
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('INVALID_STATE_TRANSITION');
  });

  it('two HODs confirming at once: exactly one merge happens', async () => {
    const { suggestionId } = await scenario();
    const results = await Promise.all(
      [ctx.tokens.hod, ctx.tokens.admin].map((t) =>
        ctx.app.inject({ method: 'POST', url: `/v1/duplicate-suggestions/${suggestionId}/confirm`, headers: auth(t) }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});
