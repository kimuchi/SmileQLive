/**
 * GET /api/sound-settings/manifest  投影画面が読む音の一覧
 *
 * ルームを持たない画面（URL だけで回すルーレットなど）が使う。
 * 中身はルームごとの取得先 (`/api/rooms/{roomId}/sounds`) と同じ。
 * 効果音の設定はシステム全体で 1 つなので、ルームで変わらない。
 *
 * ルームの取得先と同じく**セッションを要求しない**。
 * 返すのは音の置き場所だけで、正解も名簿も参加トークンも含まない。
 */

import { buildSoundManifest } from '@/application/services/sound-service';
import { jsonOk } from '@/lib/errors/api-response';
import { withRoute } from '@/lib/http/route-helpers';
import type { SoundManifestResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withRoute<SoundManifestResponse>('sound_settings.manifest', async () => {
  return jsonOk<SoundManifestResponse>(await buildSoundManifest());
});
