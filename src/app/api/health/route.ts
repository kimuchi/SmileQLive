import { NextResponse } from 'next/server';

/**
 * Cloud Run 起動プローブ用。
 * 外部 DB へ接続せず、Node.js プロセスが HTTP 応答できるかだけを確認する。
 * DB 接続確認は /api/diagnostics（管理者専用）で行う。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'smileq-live',
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
