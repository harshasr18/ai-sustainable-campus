/**
 * GET /v1/analytics/summary — the aggregates behind the role dashboards and the admin
 * analytics page.
 *
 * WHY THIS EXISTS. Phase 3 §6 and §12 ask for dashboard tiles, charts and a resolution-time
 * figure. The Phase 1/2 API exposed list endpoints with bounded pagination and nothing that
 * aggregated. The three tempting shortcuts were all rejected:
 *
 *   1. Sum the numbers in the browser over the first page. Wrong the moment a workspace has
 *      more rows than one page, and silently so.
 *   2. Seed a plausible-looking "campus stats" object. Fabricated data in a system whose
 *      entire purpose is trustworthy records.
 *   3. Show a spinner forever because the endpoint is missing. Not an option either.
 *
 * So the aggregation is done where the data is, in SQL, and every figure below is a
 * `count()`, `avg()` or `percentile_cont()` over real rows. `null` is returned — never 0 —
 * when a figure is undefined (no resolved issues means no average resolution time, which is
 * not the same as zero hours). The UI renders null as "—".
 *
 * SCOPE IS DERIVED FROM THE SESSION AND THE ROLE, NEVER FROM THE REQUEST.
 * A STUDENT gets aggregates over their own reports and the issues those reports belong to.
 * HOD and ADMIN get the whole workspace. There is no `userId` or `workspaceId` query
 * parameter, because accepting one is how a student would read the campus-wide picture.
 *
 * READ-ONLY: no history, audit or outbox writes, because nothing changes.
 *
 * ONE HONEST CAVEAT ON THE CONFIDENCE FIGURE. `ai.averageConfidence` is the mean of the
 * model's ranking scores. It is NOT a calibrated probability and the API does not call it
 * one — see the note returned alongside it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireAuth } from '../auth-plugin.js';
import type { Db } from '@campus/db';

const SummaryQuery = z.object({
  /** Optional drill-downs, so the analytics page can show "this block" without new routes. */
  blockId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  /** Trailing window in days. Absent means all time. */
  sinceDays: z.coerce.number().int().min(1).max(3650).optional(),
});

interface Counts {
  [key: string]: unknown;
}

/** `count(*) FILTER (...)` counts come back as JS numbers already; this is belt-and-braces. */
function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** Average/median come back as strings for numeric aggregates; `null` must stay `null`. */
function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get(
    '/v1/analytics/summary',
    { preHandler: requireAuth(db), schema: { querystring: SummaryQuery } },
    async (request) => {
      const actor = actorOf(request);
      const filters = request.query as z.infer<typeof SummaryQuery>;
      const isStudent = actor.role === 'STUDENT';

      /**
       * The scope predicate, built once and reused by every query below so no figure can
       * accidentally be computed over a wider scope than the caller may see.
       */
      const reportScope: string[] = ['r.workspace_id = $1'];
      const issueScope: string[] = ['i.workspace_id = $1'];
      const params: unknown[] = [actor.workspaceId];

      if (isStudent) {
        params.push(actor.userId);
        reportScope.push(`r.reporter_user_id = $${params.length}`);
        // An issue is visible to a student only through a report they filed. Expressed as a
        // subquery rather than a join so the two scopes stay independently readable.
        issueScope.push(
          `EXISTS (SELECT 1 FROM reports sr
                   WHERE sr.issue_id = i.id AND sr.reporter_user_id = $${params.length})`,
        );
      }
      if (filters.blockId) {
        params.push(filters.blockId);
        reportScope.push(`r.block_id = $${params.length}`);
        issueScope.push(`i.block_id = $${params.length}`);
      }
      if (filters.categoryId) {
        params.push(filters.categoryId);
        reportScope.push(`r.selected_category_id = $${params.length}`);
        issueScope.push(`i.category_id = $${params.length}`);
      }
      if (filters.sinceDays) {
        params.push(filters.sinceDays);
        reportScope.push(`r.submitted_at >= now() - ($${params.length} || ' days')::interval`);
        issueScope.push(`i.created_at >= now() - ($${params.length} || ' days')::interval`);
      }

      const R = reportScope.join(' AND ');
      const I = issueScope.join(' AND ');

      /* ----------------------- issues: counts by status ----------------------- */
      const issueCounts = await db.query<Counts>(
        `SELECT
           count(*)::int                                                        AS total,
           count(*) FILTER (WHERE i.status = 'SUBMITTED')::int                  AS submitted,
           count(*) FILTER (WHERE i.status = 'APPROVED')::int                   AS approved,
           count(*) FILTER (WHERE i.status = 'IN_PROGRESS')::int                AS in_progress,
           count(*) FILTER (WHERE i.status = 'RESOLVED')::int                   AS resolved,
           count(*) FILTER (WHERE i.status <> 'RESOLVED')::int                  AS open,
           count(*) FILTER (WHERE i.status <> 'RESOLVED' AND i.due_at < now())::int AS overdue,
           count(*) FILTER (WHERE i.claimed_by_user_id IS NULL
                              AND i.status <> 'RESOLVED')::int                   AS unclaimed
         FROM issues i WHERE ${I}`,
        params,
      );

      /* ---------------------- reports: counts by outcome ---------------------- */
      const reportCounts = await db.query<Counts>(
        `SELECT
           count(*)::int                                                                  AS total,
           count(*) FILTER (WHERE r.validation_status = 'PENDING')::int                    AS pending,
           count(*) FILTER (WHERE r.validation_status = 'AI_VALIDATED')::int               AS ai_validated,
           count(*) FILTER (WHERE r.validation_status = 'HUMAN_VALIDATED')::int            AS human_validated,
           count(*) FILTER (WHERE r.validation_status = 'DUPLICATE_VALIDATED')::int        AS duplicate_validated,
           count(*) FILTER (WHERE r.validation_status = 'REJECTED')::int                   AS rejected,
           count(*) FILTER (WHERE r.validation_status <> 'PENDING')::int                   AS decided,
           count(*) FILTER (WHERE r.duplicate_match_status = 'LINKED')::int                AS duplicates_linked,
           count(*) FILTER (WHERE r.duplicate_match_status = 'CANDIDATE_FOUND')::int       AS duplicates_candidate,
           count(DISTINCT r.reporter_user_id)::int                                        AS distinct_reporters
         FROM reports r WHERE ${R}`,
        params,
      );

      /* --------------------------- resolution times --------------------------- */
      const resolution = await db.query<Counts>(
        `SELECT
           count(*)::int                                                       AS resolved_count,
           avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 3600.0)     AS average_hours,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 3600.0
           )                                                                   AS median_hours,
           avg(EXTRACT(EPOCH FROM (i.approved_at - i.created_at)) / 3600.0)     AS average_first_action_hours
         FROM issues i
         WHERE ${I} AND i.resolved_at IS NOT NULL`,
        params,
      );

      /* ------------------------------ breakdowns ------------------------------ */
      const byBlock = await db.query<Counts>(
        `SELECT b.id AS block_id, b.official_name AS block_name,
                count(*)::int                                                   AS total,
                count(*) FILTER (WHERE i.status <> 'RESOLVED')::int              AS open,
                count(*) FILTER (WHERE i.status = 'RESOLVED')::int               AS resolved,
                count(*) FILTER (WHERE i.status <> 'RESOLVED' AND i.due_at < now())::int AS overdue
         FROM issues i JOIN campus_blocks b ON b.id = i.block_id
         WHERE ${I}
         GROUP BY b.id, b.official_name
         ORDER BY total DESC, b.official_name ASC`,
        params,
      );

      const byCategory = await db.query<Counts>(
        `SELECT c.id AS category_id, c.name AS category_name,
                count(*)::int                                                   AS total,
                count(*) FILTER (WHERE i.status <> 'RESOLVED')::int              AS open,
                count(*) FILTER (WHERE i.status = 'RESOLVED')::int               AS resolved
         FROM issues i JOIN issue_categories c ON c.id = i.category_id
         WHERE ${I}
         GROUP BY c.id, c.name
         ORDER BY total DESC, c.name ASC`,
        params,
      );

      /**
       * Severity of the MASTER issue, which is the human-confirmed operational value. Reports
       * carry a separate AI severity; the two are never conflated (§ Stage 6 rule).
       */
      const bySeverity = await db.query<Counts>(
        `SELECT COALESCE(i.severity, 'UNSET') AS severity, count(*)::int AS total
         FROM issues i WHERE ${I}
         GROUP BY COALESCE(i.severity, 'UNSET')
         ORDER BY total DESC`,
        params,
      );

      /* --------------------------- reports over time --------------------------- */
      /*
       * The number of weeks is a BOUND PARAMETER, not spliced into the SQL, so the statement
       * shape is identical for every caller and nothing is ever string-concatenated from a
       * value. Its placeholder index is computed explicitly rather than with a nested
       * template expression — an earlier draft wrote `$${params.length + 1}` inside the
       * query, which interpolated to the bare digit `2` instead of the placeholder `$2`,
       * and the driver then refused the statement with
       * "bind message supplies 2 parameters, but prepared statement requires 1".
       */
      const weekCountParam = `$${params.length + 1}`;
      const weeks = await db.query<Counts>(
        `WITH span AS (
           SELECT generate_series(
             date_trunc('week', now()) - ((${weekCountParam}::int - 1) || ' weeks')::interval,
             date_trunc('week', now()),
             interval '1 week'
           ) AS wk
         )
         SELECT s.wk::date AS week_start,
                count(r.id)::int AS total,
                count(r.id) FILTER (WHERE r.validation_status <> 'PENDING')::int AS decided,
                count(r.id) FILTER (WHERE r.duplicate_match_status = 'LINKED')::int AS duplicates
         FROM span s
         LEFT JOIN reports r ON date_trunc('week', r.submitted_at) = s.wk AND ${R}
         GROUP BY s.wk
         ORDER BY s.wk`,
        [...params, 12],
      );

      /* -------------------------------- tokens -------------------------------- */
      /**
       * The ledger is scoped to the WORKSPACE (and to the student's own user id), and it is
       * deliberately NOT narrowed by block, category or date.
       *
       * `token_transactions` has no block or category column — an award is for a report, not
       * for a place — so applying those filters is not possible without a join that would
       * change what the figure means. Rather than silently ignoring the filter, the response
       * states the scoping in `tokens.scope` so a consumer can label the figure correctly.
       *
       * This also fixes a real bug: an earlier draft reused the report-filter parameter array
       * here, so a block-filtered request sent two bind parameters to a statement with one
       * placeholder and the driver rejected it with
       * "bind message supplies 2 parameters, but prepared statement requires 1".
       */
      const tokenParams = isStudent ? [actor.workspaceId, actor.userId] : [actor.workspaceId];
      const tokenScope = isStudent ? 't.workspace_id = $1 AND t.user_id = $2' : 't.workspace_id = $1';
      const tokens = await db.query<Counts>(
        `SELECT
           COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'CREDIT'), 0)::int   AS credited,
           count(*) FILTER (WHERE t.transaction_type = 'CREDIT')::int                     AS credit_count,
           COALESCE(sum(t.amount) FILTER (WHERE t.transaction_type = 'REVERSAL'), 0)::int AS reversed,
           count(*) FILTER (WHERE t.transaction_type = 'REVERSAL')::int                   AS reversal_count,
           count(DISTINCT t.user_id) FILTER (WHERE t.transaction_type = 'CREDIT')::int    AS students_credited
         FROM token_transactions t WHERE ${tokenScope}`,
        tokenParams,
      );

      /* ---------------------------------- AI ---------------------------------- */
      /**
       * AI figures DO honour the filters: an analysis belongs to a report, and reports carry a
       * block and a category, so narrowing the dashboard narrows these numbers with it. The
       * scope predicate is the report scope with `a.` — the analysis — as the anchor.
       */
      const aiParams = [...params];
      /**
       * The report scope with the ANALYSIS as its anchor. Every clause built above is
       * `r.`-qualified, so swapping the leading workspace clause for `a.workspace_id` gives an
       * analysis-scoped predicate that keeps the student, block, category and date clauses
       * intact — and keeps the parameter indices correct, which a hand-written second scope
       * does not (it is how the token aggregate above ended up with two binds for one
       * placeholder).
       */
      const aiScope = reportScope
        .map((clause) => clause.replace(/^r\.workspace_id/, 'a.workspace_id'))
        .join(' AND ');

      const ai = await db.query<Counts>(
        `SELECT
           count(*)::int                                                          AS total,
           count(*) FILTER (WHERE a.status = 'SUCCEEDED')::int                     AS succeeded,
           count(*) FILTER (WHERE a.status = 'NEEDS_HUMAN_REVIEW')::int            AS needs_review,
           count(*) FILTER (WHERE a.status = 'FAILED')::int                        AS failed,
           count(*) FILTER (WHERE a.status = 'PENDING')::int                       AS pending,
           count(*) FILTER (WHERE a.category_matches_choice IS FALSE)::int         AS disagreements,
           count(*) FILTER (WHERE a.duplicate_candidates <> '[]'::jsonb)::int      AS with_duplicate_candidates,
           avg(a.confidence)                                                      AS average_confidence,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a.confidence)               AS median_confidence,
           avg(a.latency_ms)                                                      AS average_latency_ms
         FROM ai_analyses a JOIN reports r ON r.id = a.report_id
         WHERE ${aiScope}`,
        aiParams,
      );

      const issues = issueCounts.rows[0] ?? {};
      const reports = reportCounts.rows[0] ?? {};
      const res = resolution.rows[0] ?? {};
      const tokenRow = tokens.rows[0] ?? {};
      const aiRow = ai.rows[0] ?? {};

      return {
        scope: {
          /**
           * Which workspace this summary describes. A DEMO session and a REAL session must
           * never be mixed, so the caller can always tell which one they are reading.
           */
          workspace: actor.workspaceKind,
          audience: isStudent ? 'OWN_REPORTS' : 'WHOLE_WORKSPACE',
          generatedAt: new Date().toISOString(),
          filters: {
            blockId: filters.blockId ?? null,
            categoryId: filters.categoryId ?? null,
            sinceDays: filters.sinceDays ?? null,
          },
        },
        issues: {
          total: num(issues.total),
          submitted: num(issues.submitted),
          approved: num(issues.approved),
          inProgress: num(issues.in_progress),
          resolved: num(issues.resolved),
          open: num(issues.open),
          overdue: num(issues.overdue),
          unclaimed: num(issues.unclaimed),
        },
        reports: {
          total: num(reports.total),
          pending: num(reports.pending),
          aiValidated: num(reports.ai_validated),
          humanValidated: num(reports.human_validated),
          duplicateValidated: num(reports.duplicate_validated),
          rejected: num(reports.rejected),
          decided: num(reports.decided),
          duplicatesLinked: num(reports.duplicates_linked),
          duplicatesCandidate: num(reports.duplicates_candidate),
          distinctReporters: num(reports.distinct_reporters),
        },
        resolution: {
          /**
           * `null` — not 0 — when nothing has been resolved yet. A zero-hour average would
           * read as "we fix things instantly", which is the opposite of the truth.
           */
          resolvedCount: num(res.resolved_count),
          averageHours: optionalNum(res.average_hours),
          medianHours: optionalNum(res.median_hours),
          averageFirstActionHours: optionalNum(res.average_first_action_hours),
        },
        byBlock: byBlock.rows.map((row) => ({
          blockId: String(row.block_id),
          blockName: String(row.block_name),
          total: num(row.total),
          open: num(row.open),
          resolved: num(row.resolved),
          overdue: num(row.overdue),
        })),
        byCategory: byCategory.rows.map((row) => ({
          categoryId: String(row.category_id),
          categoryName: String(row.category_name),
          total: num(row.total),
          open: num(row.open),
          resolved: num(row.resolved),
        })),
        bySeverity: bySeverity.rows.map((row) => ({
          severity: String(row.severity),
          total: num(row.total),
        })),
        reportsByWeek: weeks.rows.map((row) => ({
          weekStart: new Date(String(row.week_start)).toISOString(),
          total: num(row.total),
          decided: num(row.decided),
          duplicates: num(row.duplicates),
        })),
        tokens: {
          /**
           * `WHOLE_WORKSPACE` or `OWN_LEDGER`. Block/category/date filters do not apply to the
           * ledger, so a UI showing a filtered view must not label these figures as filtered.
           */
          scope: isStudent ? 'OWN_LEDGER' : 'WHOLE_WORKSPACE',
          credited: num(tokenRow.credited),
          creditCount: num(tokenRow.credit_count),
          reversed: num(tokenRow.reversed),
          reversalCount: num(tokenRow.reversal_count),
          studentsCredited: num(tokenRow.students_credited),
        },
        ai: {
          analyses: num(aiRow.total),
          succeeded: num(aiRow.succeeded),
          needsReview: num(aiRow.needs_review),
          failed: num(aiRow.failed),
          pending: num(aiRow.pending),
          disagreements: num(aiRow.disagreements),
          withDuplicateCandidates: num(aiRow.with_duplicate_candidates),
          averageConfidence: optionalNum(aiRow.average_confidence),
          medianConfidence: optionalNum(aiRow.median_confidence),
          averageLatencyMs: optionalNum(aiRow.average_latency_ms),
          /**
           * Stated explicitly in the payload so no consumer can mistake the mean ranking score
           * for a probability. See docs/AI_MODEL.md.
           */
          confidenceNote: 'Mean model ranking score, not a calibrated probability.',
          /**
           * Empty when there are no analyses: "never analysed" and "analysed and failed" are
           * different facts and the UI must be able to tell them apart.
           */
          models: await db
            .query<Counts>(
              `SELECT DISTINCT a.provider, a.model FROM ai_analyses a
               JOIN reports r ON r.id = a.report_id WHERE ${aiScope}`,
              aiParams,
            )
            .then((r) => r.rows.map((row) => ({ provider: String(row.provider), model: String(row.model) }))),
        },
      };
    },
  );
}
