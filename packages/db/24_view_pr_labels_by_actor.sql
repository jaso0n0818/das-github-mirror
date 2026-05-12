-- Current labels on each PR with actor attribution.
-- Collapses label_events to the latest action per (repo, pr, label); only rows
-- where the latest action was "labeled" are included (i.e. label still applied).
-- actor_association is resolved from contributor_repo_roles (the actor's most
-- recently observed role from authored PRs/issues, reviews, or comments in
-- this repo). Actors with no stored association evidence return NULL.

CREATE OR REPLACE VIEW pr_labels_by_actor AS
WITH latest_events AS (
    SELECT DISTINCT ON (le.repo_full_name, le.target_number, le.label_name)
        le.repo_full_name,
        le.target_number,
        le.label_name,
        le.action,
        le.actor_github_id,
        crr.author_association AS actor_association
    FROM label_events le
    LEFT JOIN contributor_repo_roles crr
        ON crr.author_github_id = le.actor_github_id
        AND crr.repo_full_name = le.repo_full_name
    WHERE le.target_type = 'pr'
    ORDER BY le.repo_full_name, le.target_number, le.label_name, le.timestamp DESC
)
SELECT
    repo_full_name,
    target_number AS pr_number,
    label_name,
    actor_github_id,
    actor_association
FROM latest_events
WHERE action = 'labeled';
