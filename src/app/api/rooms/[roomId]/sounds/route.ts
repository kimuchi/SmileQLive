/**
 * GET /api/rooms/{roomId}/sounds  そのルームで鳴らす音の一覧
 *
 * 投影画面はこれを読んでから音源を取りに行く。
 * 差し替えていない音も同梱の既定音の URL で必ず並ぶので、
 * 「一覧に無い音」は起こらない。
 *
 * 参加者向け Snapshot と同じく、セッションを要求しない公開経路。
 * 出すのは効果音の置き場所だけで、正解も参加トークンも含まない。
 */

import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { buildSoundManifest } from '@/application/services/sound-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { SoundManifestResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ roomId: string }>(
  'rooms.sound_manifest',
  async (_request, ctx) => {
    const roomId = requireRoomId(ctx.params);
    return jsonOk<SoundManifestResponse>(await buildSoundManifest(roomId));
  },
);
