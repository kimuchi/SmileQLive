'use client';

import { Button } from '@/components/shared/Button';
import type { AudioStatus } from '@/components/presentation/use-projector-audio';

/**
 * 投影開始前のオーバーレイ。
 *
 * ブラウザは「利用者の操作なしに音を鳴らすこと」を禁じている。
 * そこで会場の操作者に一度だけクリックしてもらい、そのイベントの中で
 * AudioContext の生成・音源の先読み・テスト音・全画面要求をまとめて行う。
 *
 * **この操作より前に音は一切鳴らさない。**
 * 画面の表示や Snapshot の取得だけで音が出る経路を作らないこと。
 */
export function PresentSetupOverlay({
  quizTitle,
  previouslyEnabled,
  warning,
  status,
  testResult,
  onTest,
  onStart,
}: {
  quizTitle: string | null;
  /** このタブで既に一度音を有効にしていたか（再読込した場合）。 */
  previouslyEnabled: boolean;
  warning: string | null;
  /** 何件鳴らせるか。会場で「音が出ない」原因を切り分けるために必ず出す。 */
  status: AudioStatus;
  /** 音声テストの結果。 */
  testResult: string | null;
  /** クリックイベント内で音を有効にし、テスト音を鳴らす。 */
  onTest: () => void;
  /** クリックイベント内で音を有効にし、全画面へ入る。 */
  onStart: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="present-setup-title"
      className="stage-root fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-8 text-center"
    >
      <p className="text-brand-200 text-base font-bold">SmileQ Live</p>

      <h1 id="present-setup-title" className="text-3xl font-bold text-white sm:text-5xl">
        投影準備
      </h1>

      {quizTitle !== null ? (
        <p className="max-w-3xl truncate text-xl font-bold text-white/80">{quizTitle}</p>
      ) : null}

      <p className="max-w-2xl text-lg leading-relaxed text-white/80">
        この画面から効果音を再生します。
        <br />
        会場のスピーカーへ音が出ることを確認してから、投影を開始してください。
      </p>

      {previouslyEnabled ? (
        <p className="max-w-2xl text-base text-amber-200">
          画面を読み込み直したため、効果音を鳴らすにはもう一度この操作が必要です。
        </p>
      ) : null}

      {warning !== null ? (
        <p role="status" className="max-w-2xl text-base font-bold text-amber-200">
          {warning}
        </p>
      ) : null}

      <AudioStatusPanel status={status} testResult={testResult} />

      <div className="mt-2 flex flex-wrap items-center justify-center gap-4">
        <Button variant="secondary" size="lg" onClick={onTest}>
          音声テスト
        </Button>
        <Button variant="primary" size="lg" onClick={onStart}>
          投影を開始して全画面へ
        </Button>
      </div>

      <p className="max-w-2xl text-sm text-white/50">
        全画面にできない環境でも投影は続けられます。画面右下の操作から音量・全画面をやり直せます。
      </p>
    </div>
  );
}

/**
 * 効果音の準備状況。
 *
 * 「音が鳴らない」は会場でいちばん困る不具合なのに、原因が画面から見えなかった。
 * 何件用意できたか、できなかったものは何が原因かをここで必ず示す。
 */
function AudioStatusPanel({
  status,
  testResult,
}: {
  status: AudioStatus;
  testResult: string | null;
}) {
  if (status.kind === 'idle' && testResult === null) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="max-w-2xl rounded-2xl border border-white/20 bg-white/5 px-6 py-4 text-left"
    >
      {status.kind === 'loading' ? (
        <p className="text-base text-white/80">効果音を読み込んでいます…</p>
      ) : null}

      {status.kind === 'ready' ? (
        <p className="text-base font-bold text-emerald-200">
          効果音 {status.count} 件を読み込みました。
        </p>
      ) : null}

      {status.kind === 'partial' ? (
        <div className="flex flex-col gap-2">
          <p className="text-base font-bold text-amber-200">
            {status.count > 0
              ? `効果音 ${status.count} / ${status.total} 件しか読み込めませんでした。`
              : '効果音を読み込めませんでした。音なしで進行します。'}
          </p>
          <ul className="list-disc pl-5 text-sm text-white/70">
            {status.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="text-sm text-white/50">
            サーバーに音源が入っていない可能性があります。運営担当者へ
            <span className="font-mono"> npm run sounds:check </span>
            の実行を依頼してください。
          </p>
        </div>
      ) : null}

      {testResult !== null ? (
        <p className="mt-2 text-base font-bold text-white/90">{testResult}</p>
      ) : null}
    </div>
  );
}
