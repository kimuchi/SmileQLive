'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';

/**
 * ステージ中央の短い案内。
 *
 * 画面を空にしないための表示。進行中の内容を消してこれに切り替えないこと
 * （問題や結果を出せるときは、必ずそちらを優先する）。
 */
export function StageNotice({ title, description }: { title: string; description?: string }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center text-center text-white"
      style={{ gap: stageSize(24) }}
    >
      <p className="font-bold" style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.2 }}>
        {title}
      </p>
      {description !== undefined ? (
        <p className="text-white/70" style={{ fontSize: stageSize(STAGE_FONT.heading) }}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
