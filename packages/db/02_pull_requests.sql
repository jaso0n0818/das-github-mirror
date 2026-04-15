-- Pull requests

CREATE TABLE IF NOT EXISTS pull_requests (
    repo_full_name          VARCHAR(255)    NOT NULL,
    pr_number               INTEGER         NOT NULL,
    author_github_id        VARCHAR(255),
    author_login            VARCHAR(255),
    author_association      VARCHAR(20),
    title                   TEXT,
    state                   VARCHAR(10)     NOT NULL,
    created_at              TIMESTAMP       NOT NULL,
    closed_at               TIMESTAMP,
    merged_at               TIMESTAMP,
    last_edited_at          TIMESTAMP,
    merged_by_login         VARCHAR(255),
    base_ref                VARCHAR(255),
    head_sha                VARCHAR(40),
    base_sha                VARCHAR(40),
    merge_base_sha          VARCHAR(40),
    additions               INTEGER,
    deletions               INTEGER,
    commits_count           INTEGER,
    labels                  TEXT[],
    closing_issue_numbers   INTEGER[],
    scoring_data_stored     BOOLEAN         NOT NULL DEFAULT FALSE,

    PRIMARY KEY (repo_full_name, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_author      ON pull_requests(author_github_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_state       ON pull_requests(state);
CREATE INDEX IF NOT EXISTS idx_pull_requests_merged_at   ON pull_requests(merged_at);
