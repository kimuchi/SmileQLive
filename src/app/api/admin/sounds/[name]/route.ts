/**
 * DELETE /api/admin/sounds/{name}  1 音を同梱の既定へ戻す
 *
 * 設定ごと消すのではなく、その 1 音の差し替えだけを取り消す。
 */

import { resetSound } from '@/application/services/sound-service';
import { isSoundName } from '@/domain/sound/sound-catalog';
import { AppError } from '@/lib/errors/app-error';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import { withParams } from '@/app/api/admin/_lib/admin-route';
import type { SoundSettingsResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = withParams<{ name: string }>(
  'admin.sounds.reset',
  async (request, { params }) => {
    assertSameOrigin(request);
    const { name } = await params;
    if (!isSoundName(name)) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'name', message: '音の種類が不正です' }],
      });
    }
    return jsonOk<SoundSettingsResponse>(await resetSound(name));
  },
);
