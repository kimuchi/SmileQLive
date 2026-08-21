'use client';

import type { AudioStatus } from '@/components/presentation/use-projector-audio';

/**
 * 「まだ音が出せません」の案内。
 *
 * ブラウザは操作なしの再生を止めることがある。ただし**画面を止めてまで**
 * 操作を求めない。止めてしまうと、押し忘れたときに「動いているように見えて
 * 何も起きない画面」になり、会場でいちばん困る形になる。
 *
 * そこで:
 *   - 投影そのものは最初から動かす（アニメーションも進行も止めない）。
 *   - 音が出せないときだけ、下にこの帯を出す。
 *   - どこをクリックしても解除されるので、この帯は「押さないと駄目なボタン」ではない。
 *
 * 会場で音が出ない原因を切り分けられるよう、鳴らせる音の数もここに出す。
 */
export function PresentAudioHint({
  status,
  testResult,
  onEnable,
  onFullscreen,
  onDismiss,
}: {
  /** 何件鳴らせるか・何が足りないか。 */
  status: AudioStatus;
  /** 音声テストの結果。 */
  testResult: string | null;
  /** クリックイベント内で音を有効にし、テスト音を鳴らす。 */
  onEnable: () => void;
  /** クリックイベント内で全画面へ入る。 */
  onFullscreen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4"
    >
      <div className="bg-stage-950/90 pointer-events-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-amber-300/50 px-5 py-3 text-white shadow-2xl">
        <p className="text-base font-bold text-amber-100">
          <span aria-hidden="true">🔇</span> 効果音はまだ鳴りません
        </p>
        <p className="text-sm text-white/75">
          画面のどこかをクリックすると鳴るようになります。投影はこのままでも進みます。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onEnable}
            className="text-stage-950 inline-flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-bold hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            音を出してテスト
          </button>
          <button
            type="button"
            onClick={onFullscreen}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/30 px-4 text-sm font-bold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            全画面にする
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-bold text-white/70 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            閉じる
          </button>
        </div>

        <AudioStatusLine status={status} />

        {testResult !== null ? <p className="w-full text-sm text-white/80">{testResult}</p> : null}
      </div>
    </div>
  );
}

/**
 * 鳴らせる音の件数。
 *
 * 「音が出ない」とだけ分かっても原因にたどり着けないため、
 * 素材が読めているのかどうかをその場で見せる。
 */
export function AudioStatusLine({ status }: { status: AudioStatus }) {
  if (status.kind === 'idle') {
    return null;
  }
  if (status.kind === 'loading') {
    return <p className="w-full text-sm text-white/60">効果音を読み込んでいます…</p>;
  }
  if (status.kind === 'ready') {
    return (
      <p className="w-full text-sm text-white/60">効果音 {status.count} 件を読み込みました。</p>
    );
  }
  return (
    <div className="w-full text-sm text-amber-100">
      <p className="font-bold">
        効果音 {status.count} / {status.total} 件だけ鳴らせます
      </p>
      <ul className="mt-1 list-disc pl-5 text-white/75">
        {status.problems.slice(0, 4).map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}
