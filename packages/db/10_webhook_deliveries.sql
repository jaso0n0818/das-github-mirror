-- Webhook delivery dedup (X-GitHub-Delivery header)
-- Pruned periodically — only need recent entries for dedup.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id     VARCHAR(255)    PRIMARY KEY,
    received_at     TIMESTAMP       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_age ON webhook_deliveries(received_at);
