# GitHub Mirror — Design & Next Steps

## Core Principle: Webhook-First

The mirror is driven by GitHub webhooks. Data arrives in real-time as events happen on tracked repos. The GitHub API is only called when a webhook signals that something needs fetching (diffs, file contents) — **webhooks are the invalidation signal, not a polling schedule.**

```
GitHub event occurs
    → webhook delivers metadata to mirror (free, instant)
    → if the event implies fetchable content (PR opened/pushed/merged),
      mirror calls GitHub API to fetch diffs + file contents
    → store everything
    → validators query the mirror, never GitHub
```

**What webhooks give us for free (no API calls):**
- PR metadata (author, state, timestamps, linked issues, associations)
- Issue metadata (author, state, timestamps, transfers)
- Reviews (reviewer, state, submitted_at)
- Label changes (actor, action, timestamp)

**What requires a GitHub API call (triggered by webhook, not polled):**
- PR file list + patches (`pr_files`) — fetched on `pull_request.opened`, `.synchronize`, `.merged`
- PR file contents for AST scoring (`pr_file_contents`) — fetched alongside file list
- Backfill on first repo install — bulk fetch historical data
- Gap recovery — if `last_event_at` goes stale, light backfill via API

**Rate limit impact:** ~1-3 API calls per PR over its lifetime (open, pushes, merge). At 256 repos, worst case ~500 calls/hour across the network. GitHub App limit is 15,000/hr per installation. We use <5%.

---

## Raw Tables (already defined)

The existing schema in `packages/db/` covers 10 tables. These are the webhook write layer — upserted on every event, append-only where appropriate.

| Table | Purpose |
|---|---|
| `repos` | Tracked repos + App installation metadata |
| `pull_requests` | One row per PR, upserted on state changes |
| `issues` | One row per issue, upserted on state changes |
| `reviews` | One row per review submission, append-only |
| `comments` | Issue + PR thread comments, append-only (upsert on edit) |
| `review_comments` | Inline code review comments on PR diffs, append-only (upsert on edit) |
| `label_events` | Append-only log of every label add/remove |
| `pr_files` | File-level change metadata (filename, status, additions, deletions) |
| `pr_file_contents` | Actual file content (base + head versions) for AST/token scoring |
| `webhook_deliveries` | Dedup table keyed on `X-GitHub-Delivery` header |

### Note on `scoring_data_stored`

The `pull_requests.scoring_data_stored` flag indicates whether `pr_files` and `pr_file_contents` have been fetched for this PR. It is set to `true` after a successful fetch. When a `pull_request.synchronize` event arrives (new push to the PR branch), the flag is reset to `false` and the diff is refetched — **the webhook is the invalidation signal.** Once a PR is merged, the flag becomes permanently `true` because the diff is immutable (fixed SHAs).

### Note on data retention

Raw tables keep data indefinitely. Storage is ~45 MB/month at current scale (256 repos), with conversation threads (issue_comments + review_comments) adding <1 MB/month. The 35-day lookback is a **scoring concern, not a storage concern** — views filter by time window, but historical data is preserved for trend analysis, audits, and dashboard use.

### Storage breakdown estimate (256 repos)

| Table | Monthly growth | Notes |
|---|---|---|
| `pull_requests` | ~2 MB | Metadata only, one row per PR |
| `issues` | ~1 MB | Metadata only, one row per issue |
| `reviews` | ~500 KB | One row per review submission |
| `comments` | ~500 KB | ~500 bytes/comment avg, covers issues + PR threads |
| `review_comments` | ~300 KB | Inline code comments, includes file path + line |
| `label_events` | ~200 KB | Append-only label log |
| `pr_files` | ~3 MB | File-level change metadata per PR |
| `pr_file_contents` | ~38 MB | Actual source code (pruned to 35-day window) |
| `webhook_deliveries` | ~100 KB | Pruned periodically |
| **Total** | **~45.5 MB** | Comments are negligible (<1% of total) |

---

## Computed Views

These are Postgres views (virtual tables) and materialized views that pre-aggregate raw data for the validator API. They provide **facts and counts only — zero scoring logic.** The mirror never computes credibility ratios, multipliers, or eligibility. Validators do all scoring math on their side.

### View: `contributor_repo_roles`

Latest known association per contributor per repo. Unions PRs and issues, takes the most recently created record.

```sql
CREATE VIEW contributor_repo_roles AS
SELECT DISTINCT ON (repo_full_name, author_github_id)
    repo_full_name,
    author_github_id,
    author_login,
    author_association
FROM (
    SELECT repo_full_name, author_github_id, author_login, author_association, created_at
    FROM pull_requests
    UNION ALL
    SELECT repo_full_name, author_github_id, author_login, author_association, created_at
    FROM issues
) combined
ORDER BY repo_full_name, author_github_id, created_at DESC;
```

**Why:** Validators need to know "is this person a maintainer in this repo?" for the maintainer exclusion rule (maintainers get 0 score for merged PRs in their own repos). Association can change over time (contributor promoted to collaborator) — latest record is most accurate.

**Columns:**
| Column | Why |
|---|---|
| `repo_full_name` | Which repo |
| `author_github_id` | Which contributor (immutable GitHub ID) |
| `author_login` | Display name (for human readability, not used as key) |
| `author_association` | OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / NONE — validators check the first three to determine maintainer status |

---

### View: `pr_review_summary`

Aggregates review counts per PR by review type.

```sql
CREATE VIEW pr_review_summary AS
SELECT
    repo_full_name,
    pr_number,
    COUNT(*) FILTER (WHERE review_state = 'CHANGES_REQUESTED') AS changes_requested_count,
    COUNT(*) FILTER (WHERE review_state = 'APPROVED') AS approved_count,
    COUNT(*) FILTER (WHERE review_state = 'COMMENTED') AS commented_count
FROM reviews
GROUP BY repo_full_name, pr_number;
```

**Why:** The raw `reviews` table has one row per review submission. Scoring needs counts per PR — specifically `changes_requested_count`, which feeds the review quality multiplier. This view collapses many rows into one per PR. Cheap aggregation, no reason to materialize.

**Columns:**
| Column | Why |
|---|---|
| `repo_full_name` | Which repo |
| `pr_number` | Which PR |
| `changes_requested_count` | Direct input to review quality multiplier (each round costs 12% in OSS scoring, 15% in discovery scoring) |
| `approved_count` | Not currently in scoring formulas, but useful signal for dashboards and future scoring changes |
| `commented_count` | Same — contextual, not scored |

---

### View: `pr_linked_issues`

Joins the `closing_issue_numbers` array on each PR against actual issue records. Provides all the raw fields validators need to make their own validity judgments.

```sql
CREATE VIEW pr_linked_issues AS
SELECT
    p.repo_full_name,
    p.pr_number,
    p.author_github_id     AS pr_author_github_id,
    p.merged_at             AS pr_merged_at,
    p.created_at            AS pr_created_at,
    linked.issue_number,
    i.author_github_id      AS issue_author_github_id,
    i.author_association    AS issue_author_association,
    i.state                 AS issue_state,
    i.created_at            AS issue_created_at,
    i.closed_at             AS issue_closed_at,
    i.updated_at            AS issue_updated_at,
    i.is_transferred
FROM pull_requests p
CROSS JOIN LATERAL unnest(p.closing_issue_numbers) AS linked(issue_number)
JOIN issues i
    ON i.repo_full_name = p.repo_full_name
    AND i.issue_number = linked.issue_number;
```

**Why:** The `closing_issue_numbers` array on `pull_requests` is just a list of integers. To evaluate issue validity, validators need the actual issue data alongside the PR data. This view does the unnest + join so the API can serve it in one call. No validity judgments baked in — just timestamps and fields side by side.

**Columns:**
| Column | Why |
|---|---|
| `repo_full_name` | Which repo |
| `pr_number` | Which PR |
| `pr_author_github_id` | Needed for "issue author ≠ PR author" check (self-created issues don't count) |
| `pr_merged_at` | Needed for close-window check (issue must close within 1 day of merge) and post-merge edit check |
| `pr_created_at` | Needed for "issue predates PR" check |
| `issue_number` | The linked issue |
| `issue_author_github_id` | Who filed the issue — the "discoverer" in discovery scoring |
| `issue_author_association` | Determines issue multiplier value: maintainer-authored (OWNER/MEMBER/COLLABORATOR) → 1.66x, others → 1.33x. Validator decides. |
| `issue_state` | Must be CLOSED for multiplier to apply on merged PRs |
| `issue_created_at` | Must predate PR creation for the linkage to be valid |
| `issue_closed_at` | Must be within 1 day of PR merge |
| `issue_updated_at` | If after PR merge → issue was edited post-merge, validators treat this as suspicious |
| `is_transferred` | Flagged for credibility — transferred issues are a potential gaming vector |

---

### Materialized View: `contributor_repo_pr_counts`

Simple counts of PRs by state per contributor per repo. Refreshed every 1-5 minutes.

```sql
CREATE MATERIALIZED VIEW contributor_repo_pr_counts AS
SELECT
    author_github_id,
    repo_full_name,
    COUNT(*) FILTER (WHERE state = 'MERGED')    AS merged_count,
    COUNT(*) FILTER (WHERE state = 'CLOSED')    AS closed_count,
    COUNT(*) FILTER (WHERE state = 'OPEN')      AS open_count,
    MIN(merged_at) FILTER (WHERE state = 'MERGED') AS earliest_merge_at
FROM pull_requests
WHERE created_at >= NOW() - INTERVAL '35 days'
GROUP BY author_github_id, repo_full_name;

CREATE UNIQUE INDEX ON contributor_repo_pr_counts (author_github_id, repo_full_name);
```

**Why materialized:** Aggregates over the full 35-day window of PRs across many contributors and repos. Live aggregation on every API request is wasteful. `REFRESH MATERIALIZED VIEW CONCURRENTLY` keeps it current with no read locks — validators can query while refresh runs.

**Columns:**
| Column | Why |
|---|---|
| `author_github_id` | Which contributor |
| `repo_full_name` | Which repo |
| `merged_count` | Numerator for credibility ratio, eligibility gate threshold (min 5 valid merged PRs) |
| `closed_count` | Denominator component for credibility ratio (closed = failed PRs) |
| `open_count` | Input to open PR spam threshold check (binary penalty if over threshold) and collateral calculation |
| `earliest_merge_at` | Pioneer ordering — who merged first in this repo gets pioneer dividends from followers |

---

### Materialized View: `contributor_repo_issue_counts`

Simple counts of issues by state per contributor per repo. Refreshed every 1-5 minutes.

```sql
CREATE MATERIALIZED VIEW contributor_repo_issue_counts AS
SELECT
    author_github_id,
    repo_full_name,
    COUNT(*) FILTER (WHERE state = 'CLOSED')    AS closed_count,
    COUNT(*) FILTER (WHERE state = 'OPEN')      AS open_count
FROM issues
WHERE created_at >= NOW() - INTERVAL '35 days'
GROUP BY author_github_id, repo_full_name;

CREATE UNIQUE INDEX ON contributor_repo_issue_counts (author_github_id, repo_full_name);
```

**Why materialized:** Same reason as PR counts — avoids re-aggregating the 35-day window on every request.

**Columns:**
| Column | Why |
|---|---|
| `author_github_id` | Which contributor |
| `repo_full_name` | Which repo |
| `closed_count` | Input to issue credibility ratio (closed without solving PR = failure) |
| `open_count` | Input to open issue spam threshold check |

---

### View: `pr_scoring_inputs`

The main "give me everything" view. Joins a PR row with its review summary, linked issue data, and contributor counts. Every column is a raw fact or simple count. Zero scoring math.

```sql
CREATE VIEW pr_scoring_inputs AS
SELECT
    p.repo_full_name,
    p.pr_number,
    p.author_github_id,
    p.author_login,
    p.author_association,
    p.state,
    p.created_at,
    p.merged_at,
    p.merged_by_login,
    p.base_ref,
    p.head_sha,
    p.base_sha,
    p.closing_issue_numbers,
    p.scoring_data_stored,
    -- Time fact (not decay — validator computes that)
    EXTRACT(EPOCH FROM (NOW() - p.merged_at)) / 3600.0 AS hours_since_merge,
    -- Review counts
    COALESCE(r.changes_requested_count, 0)  AS changes_requested_count,
    COALESCE(r.approved_count, 0)           AS approved_count,
    COALESCE(r.commented_count, 0)          AS commented_count,
    -- Contributor PR counts in this repo
    COALESCE(pc.merged_count, 0)            AS contributor_merged_count,
    COALESCE(pc.closed_count, 0)            AS contributor_closed_count,
    COALESCE(pc.open_count, 0)              AS contributor_open_count,
    pc.earliest_merge_at                    AS contributor_earliest_merge_in_repo,
    -- Contributor issue counts in this repo
    COALESCE(ic.closed_count, 0)            AS contributor_issues_closed,
    COALESCE(ic.open_count, 0)              AS contributor_issues_open
FROM pull_requests p
LEFT JOIN pr_review_summary r
    ON r.repo_full_name = p.repo_full_name AND r.pr_number = p.pr_number
LEFT JOIN contributor_repo_pr_counts pc
    ON pc.author_github_id = p.author_github_id AND pc.repo_full_name = p.repo_full_name
LEFT JOIN contributor_repo_issue_counts ic
    ON ic.author_github_id = p.author_github_id AND ic.repo_full_name = p.repo_full_name
WHERE p.created_at >= NOW() - INTERVAL '35 days';
```

**Why this view exists:** This is what powers the main validator API endpoint. One query returns everything a validator needs per PR — all facts, all counts, no opinions. The validator takes this, applies its own repo weights, token scoring, credibility formulas, eligibility gates, and multiplier math.

**Columns:**
| Column | Why |
|---|---|
| `repo_full_name` | Which repo — validator maps to repo weight from their own config |
| `pr_number` | Which PR |
| `author_github_id` | Stable identity — validator maps to hotkey via identity service |
| `author_login` | Display name for readability |
| `author_association` | Maintainer check (OWNER/MEMBER/COLLABORATOR = maintainer, gets 0 score in own repo) |
| `state` | OPEN/CLOSED/MERGED — determines which scoring path applies |
| `created_at` | 35-day lookback filter, issue-predates-PR check |
| `merged_at` | Time decay input, issue close-window check, pioneer ordering |
| `merged_by_login` | Audit — detects self-merge patterns |
| `base_ref` | Validator checks PR targets an acceptable branch |
| `head_sha` | Identifies the exact diff version stored |
| `base_sha` | Together with head_sha, defines what changed |
| `closing_issue_numbers` | Which issues this PR closes — feeds issue multiplier and discovery scoring |
| `scoring_data_stored` | Whether diff/file contents are available via the diff endpoint |
| `hours_since_merge` | Raw time fact — validator plugs into its own time decay formula |
| `changes_requested_count` | Input to review quality multiplier |
| `approved_count` | Context signal |
| `commented_count` | Context signal |
| `contributor_merged_count` | Input to credibility ratio numerator, eligibility gate |
| `contributor_closed_count` | Input to credibility ratio denominator |
| `contributor_open_count` | Input to open PR spam threshold |
| `contributor_earliest_merge_in_repo` | Pioneer ordering — earliest merge = pioneer, gets dividends from followers |
| `contributor_issues_closed` | Input to issue credibility ratio |
| `contributor_issues_open` | Input to open issue spam threshold |

---

## Validator API Endpoints

The "two calls away" pattern:

```
GET /api/v1/contributors/{github_id}/scoring-inputs?since={date}
    → Returns pr_scoring_inputs rows for this contributor
    → All facts + counts, no scoring math

GET /api/v1/pull-requests/{owner}/{repo}/{number}/files
    → Returns pr_files + pr_file_contents for token/AST scoring

GET /api/v1/repos/{owner}/{repo}/issues?state={state}&since={date}
    → Returns issues for discovery scoring

GET /api/v1/issues/{owner}/{repo}/{number}/label-events
    → Returns chronological label events for anti-gaming replay

GET /api/v1/pull-requests/{owner}/{repo}/{number}/linked-issues
    → Returns pr_linked_issues rows for issue multiplier evaluation
```

---

## Materialized View Refresh

```sql
-- pg_cron or application-level scheduler, every 1-5 minutes:
REFRESH MATERIALIZED VIEW CONCURRENTLY contributor_repo_pr_counts;
REFRESH MATERIALIZED VIEW CONCURRENTLY contributor_repo_issue_counts;
```

`CONCURRENTLY` requires a unique index on each materialized view (already defined above). No read locks during refresh — validators see the previous snapshot until refresh completes.

---

## Gotchas & Design Decisions

### `closing_issue_numbers` extraction

The `pull_request` webhook payload does not include parsed issue linkages directly. Options:
1. **Parse PR body text** — regex for "closes #123", "fixes #123", etc. Fragile (many formats).
2. **Call GitHub's timeline/events API** — one extra API call per PR. Reliable.
3. **Use the GraphQL API `closingIssuesReferences`** — most accurate, one call.

Decision needed. Leaning toward option 3 (GraphQL) for accuracy.

### Webhook ordering

GitHub does not guarantee delivery order. A `pull_request.closed` can arrive before `pull_request.opened` during retry backlog. All webhook handlers must upsert idempotently — never reject an event because a "prior" event hasn't been seen.

### Author association changes

A contributor can be promoted (CONTRIBUTOR → COLLABORATOR) between PR open and merge. The webhook delivers the association at event time. The `contributor_repo_roles` view handles this by taking the latest record, but individual PR rows may have stale associations from earlier events if not re-upserted on every state change.

### App uninstallation

If a repo owner uninstalls the GitHub App, webhooks stop and API calls fail. The `installation.deleted` webhook fires once — handle it by marking the repo inactive in `repos`. Don't retry API calls against uninstalled repos.

### Post-merge PR edits

Someone edits a PR description after merge to add "closes #456". The `pull_request.edited` webhook fires with new body text. Flag this rather than silently updating `closing_issue_numbers` — current scoring treats post-merge edits as suspicious.

---

## Future Considerations

### Discovery scoring improvements (Proposals 1-5)

The mirror schema already supports all proposed discovery scoring changes without modification:
- **Smooth credibility curve (P1):** Validators compute from merged/closed counts already provided
- **Repo-weighted credibility (P2):** Validators apply their own repo weights to counts
- **Volume-aware credibility (P3):** Total attempt counts available from contributor counts
- **Per-type credibility (P4):** `label_events` table already tracks `gt:bug`, `gt:feature`, `gt:refactor` label changes — validators can bucket issues by type from this data
- **Dynamic category weights (P5):** Computed from network-wide success rates — validator-side aggregation

### Live data for gittensor-ui

The same API that serves validators can serve the dashboard. PR merges, issue closes, review submissions — all visible within seconds of the webhook arriving. The `pr_scoring_inputs` view works for both audiences.

### Scoring frequency

With real-time data, validator scoring cycles can run more frequently (every 30 minutes or less) instead of waiting for batch GitHub API fetches. The mirror is always current.

---

## Next Steps

1. **Define TypeORM entities** matching the existing SQL schemas in `packages/db/`
2. **Implement webhook receiver** — verify signatures, dedup via `webhook_deliveries`, upsert into raw tables
3. **Implement diff fetcher** — triggered by PR webhooks (opened/synchronize/merged), stores to `pr_files` + `pr_file_contents`
4. **Create the SQL views** — `contributor_repo_roles`, `pr_review_summary`, `pr_linked_issues`, `pr_scoring_inputs`
5. **Create materialized views** — `contributor_repo_pr_counts`, `contributor_repo_issue_counts` + refresh schedule
6. **Build validator API endpoints** — backed by the views above
7. **Backfill service** — fetch historical data when a repo is first installed
8. **Resolve `closing_issue_numbers` extraction** — pick parsing strategy (body regex vs GraphQL API)
9. **Health monitoring** — alert on stale `last_event_at` per repo
