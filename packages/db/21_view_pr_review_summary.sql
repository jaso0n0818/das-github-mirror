-- Aggregates review counts per PR by review type.
-- Maintainer-only CHANGES_REQUESTED count is the scoring-relevant field.

CREATE OR REPLACE VIEW pr_review_summary AS
SELECT
    repo_full_name,
    pr_number,
    COUNT(*) FILTER (WHERE review_state = 'CHANGES_REQUESTED'
                       AND reviewer_association IN ('OWNER', 'MEMBER', 'COLLABORATOR'))
        AS maintainer_changes_requested_count,
    COUNT(*) FILTER (WHERE review_state = 'CHANGES_REQUESTED') AS changes_requested_count,
    COUNT(*) FILTER (WHERE review_state = 'APPROVED') AS approved_count,
    COUNT(*) FILTER (WHERE review_state = 'COMMENTED') AS commented_count
FROM reviews
GROUP BY repo_full_name, pr_number;
