import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import { installProcessGuard } from "../lib/process-guard";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

installProcessGuard();

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;

export function getDb() {
  if (!instance) {
    instance = drizzle(env.databaseUrl, {
      mode: "planetscale",
      schema: fullSchema,
    });
  }
  return instance;
}
