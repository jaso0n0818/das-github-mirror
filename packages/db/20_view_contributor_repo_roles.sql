-- Latest known association per contributor per repo.
-- Unions PRs and issues, takes the most recently created record.

CREATE OR REPLACE VIEW contributor_repo_roles AS
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
