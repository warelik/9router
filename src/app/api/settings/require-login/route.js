import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { isDemoLock } from "@/lib/blabs/flags";
import { scrubRequireLoginResponse } from "@/lib/blabs/demoPolicy";

export async function GET() {
  try {
    const settings = await getSettings();
    if (isDemoLock()) {
      return NextResponse.json(scrubRequireLoginResponse(settings));
    }
    const requireLogin = settings.requireLogin !== false;
    const tunnelDashboardAccess = settings.tunnelDashboardAccess !== false;
    const tunnelUrl = settings.tunnelUrl || "";
    const tailscaleUrl = settings.tailscaleUrl || "";
    return NextResponse.json({ requireLogin, tunnelDashboardAccess, tunnelUrl, tailscaleUrl });
  } catch (error) {
    if (isDemoLock()) {
      return NextResponse.json(scrubRequireLoginResponse(null), { status: 200 });
    }
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}
