import type { NextRequest } from "next/server.js";
import { handleNotificationsDispatch } from "../../../../../lib/support/supportNotifications.server.ts";

// Cron (e.g. Vercel Cron, "Authorization: Bearer <CRON_SECRET>"): sends queued and retried support e-mails.
export async function GET(request: NextRequest) {
  return handleNotificationsDispatch(request);
}
