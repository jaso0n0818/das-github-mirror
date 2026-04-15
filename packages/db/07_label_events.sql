-- Label events (append-only log for anti-gaming timeline replay)

CREATE TABLE IF NOT EXISTS label_events (
    id                  SERIAL          PRIMARY KEY,
    repo_full_name      VARCHAR(255)    NOT NULL,
    target_number       INTEGER,
    target_type         VARCHAR(5)      NOT NULL DEFAULT 'issue',
    label_name          VARCHAR(255)    NOT NULL,
    action              VARCHAR(20)     NOT NULL,
    actor_github_id     VARCHAR(255),
    actor_login         VARCHAR(255),
    actor_association   VARCHAR(20),
    timestamp           TIMESTAMP       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_label_events_target ON label_events(repo_full_name, target_number, timestamp);
