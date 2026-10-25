import { json } from "@/server/http";

export const dynamic = "force-dynamic";

// Liveness: o processo responde. Não toca o banco (para isso, /api/health): reiniciar o app não conserta um banco fora.
export function GET() {
  return json({ status: "ok" });
}
