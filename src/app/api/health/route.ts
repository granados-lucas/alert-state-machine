import { sql } from "drizzle-orm";
import { json } from "@/server/http";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await database().execute(sql`select 1`);
    return json({ status: "ok" });
  } catch {
    return json({ status: "database unavailable" }, 503);
  }
}
