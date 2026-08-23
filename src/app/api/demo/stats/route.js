import { NextResponse } from "next/server";
import { getUsageStats, getChartData } from "@/lib/usageDb";
import { toDemoStats } from "@/lib/blabs/demoStats";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
export const dynamic = "force-dynamic";
const methodForbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

export async function GET(request) {
  try {
    const period = new URL(request.url).searchParams.get("period") || "7d";
    if (!VALID_PERIODS.has(period)) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    const [usageStats, chartBuckets] = await Promise.all([getUsageStats(period), getChartData(period)]);
    return NextResponse.json(toDemoStats(period, usageStats, chartBuckets));
  } catch {
    console.error("[API] Failed to get demo stats");
    return NextResponse.json({ error: "Failed to fetch demo stats" }, { status: 500 });
  }
}

export const POST = methodForbidden;
export const PUT = methodForbidden;
export const PATCH = methodForbidden;
export const DELETE = methodForbidden;
