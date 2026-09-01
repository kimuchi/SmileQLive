/**
 * GET /api/rooms/{roomId}/sounds  投影画面が鳴らす音の一覧
 *
 * 投影画面はこれを読んでから音源を取りに行く。
 * 差し替えていない音も同梱の既定音の URL で必ず並ぶので、
 * 「一覧に無い音」は起こらない。
 *
 * **中身はルームによって変わらない。** 効果音の設定はシステム全体で 1 つになり、
 * 同じものを `/api/sound-settings/manifest` からも取れる。
 * それでもこの経路を残しているのは、**既に開いている投影画面がここを読み続ける**ため。
 * 会の最中にデプロイしても、開きっぱなしの投影画面が音を失わないようにする。
 *
 * 参加者向け Snapshot と同じく、セッションを要求しない公開経路。
 * 出すのは効果音の置き場所だけで、正解も参加トークンも含まない。
 * ルーム ID は経路を分けるためだけに残してあり、中身の決定には使わない。
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
    // 形の検査だけは通す。壊れた URL に 200 を返さない。
    requireRoomId(ctx.params);
    return jsonOk<SoundManifestResponse>(await buildSoundManifest());
  },
);
