-- ============================================================================
-- SOLOB+ Migration 003: One-time initial administrator bootstrap invariant
-- ============================================================================
-- A singleton row (PRIMARY KEY on a constant, CHECK-constrained key) records that the
-- initial administrator was provisioned. Concurrent bootstrap transactions race on this
-- PRIMARY KEY: exactly one can commit; all others observe the conflict and refuse.

CREATE TABLE IF NOT EXISTS system_bootstrap (
  bootstrap_key TEXT PRIMARY KEY CHECK (bootstrap_key = 'initial_admin'),
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
