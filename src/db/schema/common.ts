import { bigint, pgEnum, timestamp } from "drizzle-orm/pg-core";

export const id = () => bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
export const fk = (name: string) => bigint(name, { mode: "number" });
export const at = (name: string) => timestamp(name, { withTimezone: true });

export const remediationMode = pgEnum("remediation_mode", ["webhook", "api"]);
export const runStatus = pgEnum("run_status", ["success", "failed", "skipped"]);
