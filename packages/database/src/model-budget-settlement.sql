ALTER TABLE run_model_reservations ADD COLUMN actual_tokens integer CHECK(actual_tokens >= 0);
INSERT INTO schema_migrations(version) VALUES(13);
