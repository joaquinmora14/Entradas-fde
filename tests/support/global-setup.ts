import pg from "pg";
// @ts-expect-error módulo JS sin tipos
import { migrate } from "../../scripts/migrate.mjs";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://fde:fde@localhost:5432/fde_test";
  process.env.DATABASE_URL = url;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS app CASCADE");
  await c.end();
  await migrate(url, { log: () => {} });
}
