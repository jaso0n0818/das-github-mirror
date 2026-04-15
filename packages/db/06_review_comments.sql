-- Inline code review comments (comments on specific lines in a PR diff).
-- These come from the pull_request_review_comment webhook event.
-- Thread/conversation comments on the PR page are in issue_comments.sql.

CREATE TABLE IF NOT EXISTS review_comments (
    repo_full_name      VARCHAR(255)    NOT NULL,
    comment_id          BIGINT          NOT NULL,
    pr_number           INTEGER         NOT NULL,
    reviewer_github_id  VARCHAR(255),
    reviewer_login      VARCHAR(255),
    review_id           BIGINT,
    path                VARCHAR(1024),
    line                INTEGER,
    side                VARCHAR(5),
    body                TEXT,
    created_at          TIMESTAMP       NOT NULL,
    updated_at          TIMESTAMP,

    PRIMARY KEY (repo_full_name, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_review_comments_pr       ON review_comments(repo_full_name, pr_number);
CREATE INDEX IF NOT EXISTS idx_review_comments_reviewer ON review_comments(reviewer_github_id);
CREATE INDEX IF NOT EXISTS idx_review_comments_review   ON review_comments(review_id);
