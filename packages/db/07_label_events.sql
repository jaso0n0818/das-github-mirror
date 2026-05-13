-- Label events (append-only log for anti-gaming timeline replay).
-- Actor's repo role (author_association) is NOT stored here — neither the
-- webhook sender nor GraphQL LabeledEvent.actor expose it. The labels views
-- resolve the role at read time via contributor_repo_roles.

CREATE TABLE IF NOT EXISTS label_events (
    id                  SERIAL          PRIMARY KEY,
    repo_full_name      VARCHAR(255)    NOT NULL,
    target_number       INTEGER,
    target_type         VARCHAR(5)      NOT NULL DEFAULT 'issue',
    label_name          VARCHAR(255)    NOT NULL,
    action              VARCHAR(20)     NOT NULL,
    actor_github_id     VARCHAR(255),
    actor_login         VARCHAR(255),
    timestamp           TIMESTAMPTZ     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_label_events_target ON label_events(repo_full_name, target_number, timestamp);

CREATE UNIQUE INDEX IF NOT EXISTS uq_label_events_natural_key
    ON label_events (repo_full_name, target_number, target_type,
                     label_name, action, timestamp)
    NULLS NOT DISTINCT;
