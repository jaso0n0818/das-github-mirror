-- The main "give me everything" view for PR scoring.
-- Joins a PR row with its review summary. Every column is a raw fact or count.
-- Contributor counts (credibility, eligibility) are served via a separate API
-- endpoint with a validator-supplied lookback window.

CREATE OR REPLACE VIEW pr_scoring_inputs AS
SELECT
    p.repo_full_name,
    p.pr_number,
    p.title,
    p.author_github_id,
    p.author_login,
    p.author_association,
    p.state,
    p.labels,
    p.created_at,
    p.closed_at,
    p.merged_at,
    p.last_edited_at,
    p.merged_by_login,
    p.base_ref,
    p.head_sha,
    p.base_sha,
    p.merge_base_sha,
    p.additions,
    p.deletions,
    p.commits_count,
    p.closing_issue_numbers,
    p.scoring_data_stored,
    -- Anti-gaming flag: PR body edited after merge (blocks issue bonuses)
    CASE WHEN p.last_edited_at > p.merged_at THEN TRUE ELSE FALSE END AS edited_after_merge,
    -- Time fact (not decay — validator computes that)
    EXTRACT(EPOCH FROM (NOW() - p.merged_at)) / 3600.0 AS hours_since_merge,
    -- Review counts (maintainer-only for scoring penalty)
    COALESCE(r.maintainer_changes_requested_count, 0) AS maintainer_changes_requested_count,
    COALESCE(r.changes_requested_count, 0)  AS changes_requested_count,
    COALESCE(r.approved_count, 0)           AS approved_count,
    COALESCE(r.commented_count, 0)          AS commented_count
FROM pull_requests p
LEFT JOIN pr_review_summary r
    ON r.repo_full_name = p.repo_full_name AND r.pr_number = p.pr_number;
