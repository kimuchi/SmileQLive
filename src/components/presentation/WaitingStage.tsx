'use client';

import { useState, type FormEvent } from 'react';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { QrCode } from '@/components/shared/QrCode';
import { cn } from '@/lib/client/cn';
import { formatInteger } from '@/lib/format';

/**
 * 開始前の待機画面。
 *
 * ここが参加の唯一の入口。二次元コードを読むだけで参加できることを大きく示す。
 * ルームコードや参加コードの入力案内は表示しない（そもそも入力する仕組みを作らない）。
 *
 * 参加 URL には参加トークンが含まれるため:
 * - 文字列としては画面に出さない（二次元コードとしてだけ提示する）。
 * - 参加 URL が変わったときは古い二次元コードを一切残さない（key を変えて作り直す）。
 */
export function WaitingStage({
  quizTitle,
  joinUrl,
  joinOpen,
  participantCount,
  onSetJoinUrl,
}: {
  quizTitle: string;
  /** 司会端末で保管された参加 URL。別端末投影などで不明なこともある。 */
  joinUrl: string | null;
  joinOpen: boolean;
  participantCount: number;
  /** 参加 URL を手元で設定する（同一ブラウザの sessionStorage に保管する）。 */
  onSetJoinUrl: (value: string) => boolean;
}) {
  return (
    <div className="flex h-full w-full items-center" style={{ gap: stageSize(64) }}>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: stageSize(32) }}>
        <h1
          className="font-bold break-words text-white"
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.15 }}
        >
          {quizTitle}
        </h1>

        <p
          className="font-bold text-brand-200"
          style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
        >
          二次元コードを読んで参加
        </p>

        <p className="text-white/70" style={{ fontSize: stageSize(STAGE_FONT.body), lineHeight: 1.5 }}>
          スマートフォンのカメラで読み取ると、そのまま参加できます。
          <br />
          アプリのインストールは不要です。
        </p>

        <div className="flex items-baseline" style={{ gap: stageSize(20) }}>
          <span
            className="font-bold text-white/60"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            参加中
          </span>
          <span
            className="font-bold text-white tabular-nums"
            style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1 }}
          >
            {formatInteger(participantCount)}
          </span>
          <span
            className="font-bold text-white/60"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            人
          </span>
        </div>

        {!joinOpen ? (
          <p
            className="inline-flex w-fit items-center rounded-full border-2 border-amber-300/70 bg-amber-300/15 font-bold text-amber-100"
            style={{
              paddingInline: stageSize(28),
              paddingBlock: stageSize(12),
              fontSize: stageSize(STAGE_FONT.small),
            }}
          >
            現在、新しい参加を締め切っています
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-center" style={{ gap: stageSize(20) }}>
        {joinUrl ? (
          <QrCode
            // 参加 URL が変わったら、古いコードを DOM ごと作り直して残さない。
            key={joinUrl}
            value={joinUrl}
            size={640}
            title="参加用の二次元コード"
            className="w-full"
          />
        ) : (
          <JoinUrlFallback onSetJoinUrl={onSetJoinUrl} />
        )}
      </div>
    </div>
  );
}

/**
 * 参加 URL が分からないときの案内。
 *
 * 平文の参加トークンはルーム作成・再発行の応答にしか現れないため、
 * 別端末で投影を始めた場合はこの端末に保管されていない。
 * 会場で詰まらないよう、司会端末からコピーした参加 URL をその場で貼り付けられるようにする。
 * 貼り付けた値は sessionStorage にだけ置き、画面には二次元コードとしてしか出さない。
 */
function JoinUrlFallback({ onSetJoinUrl }: { onSetJoinUrl: (value: string) => boolean }) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accepted = onSetJoinUrl(value.trim());
    setInvalid(!accepted);
    if (accepted) {
      setValue('');
    }
  };

  return (
    <div
      className="flex flex-col rounded-3xl border-4 border-dashed border-white/30 bg-white/5 text-white"
      style={{ padding: stageSize(36), gap: stageSize(20), width: stageSize(640) }}
    >
      <p className="font-bold" style={{ fontSize: stageSize(STAGE_FONT.body) }}>
        参加用の二次元コードがまだ設定されていません
      </p>
      <p className="text-white/70" style={{ fontSize: stageSize(STAGE_FONT.caption), lineHeight: 1.6 }}>
        司会画面で発行した参加 URL を貼り付けてください。
        <br />
        この端末のタブ内にだけ保管し、画面には二次元コードとしてのみ表示します。
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: stageSize(14) }}>
        <label className="sr-only" htmlFor="present-join-url">
          参加 URL
        </label>
        <input
          id="present-join-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          placeholder="https://example.com/j/..."
          className={cn(
            'w-full rounded-xl border-2 bg-stage-950/60 px-4 py-3 text-white placeholder:text-white/40',
            invalid ? 'border-red-300' : 'border-white/30',
          )}
        />
        {invalid ? (
          <p className="font-bold text-red-200" style={{ fontSize: stageSize(STAGE_FONT.caption) }}>
            この画面と同じサイトの参加 URL を貼り付けてください
          </p>
        ) : null}
        <button
          type="submit"
          className="rounded-xl bg-white px-5 py-3 font-bold text-stage-950"
        >
          二次元コードを表示する
        </button>
      </form>
    </div>
  );
}
