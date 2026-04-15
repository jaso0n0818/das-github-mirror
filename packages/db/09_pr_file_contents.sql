-- PR file contents for token scoring (base + head versions)
-- Pruned along with lookback window — no need to keep contents older than ~35 days.

CREATE TABLE IF NOT EXISTS pr_file_contents (
    repo_full_name      VARCHAR(255)    NOT NULL,
    pr_number           INTEGER         NOT NULL,
    filename            VARCHAR(500)    NOT NULL,
    base_content        TEXT,
    head_content        TEXT,
    is_binary           BOOLEAN         NOT NULL DEFAULT FALSE,
    byte_size           INTEGER,

    PRIMARY KEY (repo_full_name, pr_number, filename)
);
