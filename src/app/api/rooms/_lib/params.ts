import 'server-only';

/**
 * ルーム系ルートの動的セグメント検証。
 *
 * - UUID 以外の roomId は DB へ渡さず 404 として扱う（SQL エラー文言を返さない）。
 * - Route Handler からのみ使う内部ヘルパー。`_lib` 配下なのでルートにはならない。
 */

import { AppError } from '@/lib/errors/app-error';
import { uuidSchema } from '@/lib/validation/schemas';

export function requireRoomId(params: { roomId: string }): string {
  const parsed = uuidSchema.safeParse(params.roomId);
  if (!parsed.success) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return parsed.data;
}
