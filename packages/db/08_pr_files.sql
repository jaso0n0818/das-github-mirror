-- PR file changes (fetched on merge)

CREATE TABLE IF NOT EXISTS pr_files (
    repo_full_name      VARCHAR(255)    NOT NULL,
    pr_number           INTEGER         NOT NULL,
    filename            VARCHAR(500)    NOT NULL,
    previous_filename   VARCHAR(500),
    status              VARCHAR(20)     NOT NULL,
    additions           INTEGER         NOT NULL DEFAULT 0,
    deletions           INTEGER         NOT NULL DEFAULT 0,
    changes             INTEGER         NOT NULL DEFAULT 0,

    PRIMARY KEY (repo_full_name, pr_number, filename)
);

CREATE INDEX IF NOT EXISTS idx_pr_files_pr ON pr_files(repo_full_name, pr_number);
