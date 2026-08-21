/**
 * GET /api/sounds/{publicId}/{name}  差し替えた効果音そのもの
 *
 * **セッションを要求しない。**
 * 投影担当は司会と違う端末で画面を開くため、ここで認証を求めると会場で詰まる。
 * 返すのは効果音だけで、正解も名簿も含まない。配信 ID は推測できないため、
 * URL を知らない人には届かない。
 *
 * 自分のドメインから配るのには 2 つ理由がある。
 *   1. 投影画面は fetch して decodeAudioData へ渡す。別オリジンだと
 *      バケットへ CORS の設定が要り、その設定漏れが会場で音の出ない原因になる。
 *   2. 効果音ラボの規約は素材の直リンクを禁じている。自分の保存先から配る形にしておく。
 */

import { readSoundFile } from '@/application/services/sound-service';
import { isSoundName } from '@/domain/sound/sound-catalog';
import { AppError } from '@/lib/errors/app-error';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ブラウザに持たせる時間。
 *
 * URL に差し替え時刻が入っているので、差し替えれば URL が変わる。
 * つまり古い音がキャッシュから鳴ることは無く、長く持たせて構わない。
 */
const CACHE_CONTROL = 'private, max-age=3600';

/**
 * 連打の上限。
 *
 * 投影画面は開くたびに 9 音ぶんを取りに来るだけなので、これで足りる。
 * 認証を求めない経路なので、置いておかないと配信量をいくらでも使わせられる。
 */
const FETCH_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export const GET = withParams<{ publicId: string; name: string }>(
  'sounds.file',
  async (request, { params }) => {
    checkRateLimit(clientKeyFromRequest(request, 'sounds.file'), FETCH_RATE_LIMIT);

    const { publicId, name } = await params;
    if (!isSoundName(name)) {
      throw new AppError('SOUND_NOT_FOUND');
    }

    const file = await readSoundFile(publicId, name);
    if (!file) {
      throw new AppError('SOUND_NOT_FOUND');
    }

    return new Response(file.bytes, {
      status: 200,
      headers: {
        'content-type': file.mimeType,
        'content-length': String(file.bytes.byteLength),
        'cache-control': CACHE_CONTROL,
        // 差し替えた音を別サイトから読ませない。
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  },
);
