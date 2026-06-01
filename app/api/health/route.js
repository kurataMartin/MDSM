// app/api/health/route.js
// Liveness probe used by Docker healthcheck AND by the Vercel cron keep-alive.
// Returns 200 + DB/chain status so you can monitor from an uptime service.

import { NextResponse } from "next/server";
import { healthCheck } from "@/lib/db";

export const dynamic = "force-dynamic"; // never cache — always live

export async function GET() {
  const db = await healthCheck();
  const ok = db.status === "healthy";
  return NextResponse.json(
    { status: ok ? "ok" : "degraded", db },
    { status: ok ? 200 : 503 }
  );
}
