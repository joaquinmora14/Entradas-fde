import { afterAll, beforeEach } from "vitest";
import { closeDb, getDb } from "@/server/db";
import { setSheetsClientForTests } from "@/server/sheets/sync";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://fde:fde@localhost:5432/fde_test";
delete process.env.BOOTSTRAP_ADMIN_EMAILS;

beforeEach(async () => {
  setSheetsClientForTests(null);
  await getDb().query(`
    TRUNCATE app.audit_logs, app.idempotency_keys, app.sheet_sync_jobs, app.sync_runs,
             app.pool_people, app.invitations, app.invitation_quotas, app.password_reset_tokens,
             app.sessions, app.settings, app.users RESTART IDENTITY CASCADE;
    UPDATE app.sync_lease SET holder = NULL, expires_at = '-infinity';
  `);
});

afterAll(async () => {
  await closeDb();
});
