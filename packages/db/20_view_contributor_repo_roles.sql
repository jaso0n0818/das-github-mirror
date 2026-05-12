-- Latest known association per contributor per repo.
-- Uses every table that stores GitHub's author_association/reviewer_association:
-- PR authors, issue authors, submitted reviews, and issue/PR thread comments.
-- Rows without a stored association are ignored; label views should use the
-- latest known role, not let a missing observation erase earlier evidence.

CREATE OR REPLACE VIEW contributor_repo_roles AS
SELECT DISTINCT ON (repo_full_name, author_github_id)
    repo_full_name,
    author_github_id,
    author_login,
    author_association
FROM (
    SELECT
        repo_full_name,
        author_github_id,
        author_login,
        author_association,
        created_at AS observed_at,
        10 AS source_rank,
        'pr:' || pr_number::text AS source_key
    FROM pull_requests
    WHERE author_github_id IS NOT NULL
      AND author_github_id <> ''
      AND author_association IS NOT NULL

    UNION ALL

    SELECT
        repo_full_name,
        author_github_id,
        author_login,
        author_association,
        created_at AS observed_at,
        10 AS source_rank,
        'issue:' || issue_number::text AS source_key
    FROM issues
    WHERE author_github_id IS NOT NULL
      AND author_github_id <> ''
      AND author_association IS NOT NULL

    UNION ALL

    SELECT
        repo_full_name,
        reviewer_github_id AS author_github_id,
        reviewer_login AS author_login,
        reviewer_association AS author_association,
        submitted_at AS observed_at,
        20 AS source_rank,
        'review:' || pr_number::text || ':' || submitted_at::text AS source_key
    FROM reviews
    WHERE reviewer_github_id IS NOT NULL
      AND reviewer_github_id <> ''
      AND reviewer_association IS NOT NULL

    UNION ALL

    SELECT
        repo_full_name,
        author_github_id,
        author_login,
        author_association,
        COALESCE(updated_at, created_at) AS observed_at,
        30 AS source_rank,
        'comment:' || comment_id::text AS source_key
    FROM comments
    WHERE author_github_id IS NOT NULL
      AND author_github_id <> ''
      AND author_association IS NOT NULL
) combined
ORDER BY repo_full_name, author_github_id, observed_at DESC, source_rank DESC, source_key DESC;
