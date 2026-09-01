/**
 * DELETE /api/sound-settings/{name}  1 音を同梱の既定へ戻す
 *
 * 設定ごと消すのではなく、その 1 音の差し替えだけを取り消す。
 * 差し替えと同じく**ログインを求めない**（理由は ../route.ts）。
 */

import { resetSound } from '@/application/services/sound-service';
import { isSoundName } from '@/domain/sound/sound-catalog';
import { AppError } from '@/lib/errors/app-error';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute } from '@/lib/http/route-helpers';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import type { SoundSettingsResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RESET_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export const DELETE = defineRoute<{ name: string }>(
  'sound_settings.reset',
  async (request, ctx) => {
    assertSameOrigin(request);
    checkRateLimit(clientKeyFromRequest(request, 'sound_settings.reset'), RESET_RATE_LIMIT);

    const { name } = await ctx.params;
    if (!isSoundName(name)) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'name', message: '音の種類が不正です' }],
      });
    }
    return jsonOk<SoundSettingsResponse>(await resetSound(name));
  },
);
