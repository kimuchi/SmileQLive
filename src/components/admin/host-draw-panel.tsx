'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import {
  drawUnit,
  drawnStageEntries,
  latestStageEntry,
  type StageDraw,
} from '@/domain/draw/draw-stage';
import { removesDrawnEntries, type RoomMode } from '@/domain/room/room-mode';
import {
  ROOM_PHASE_LABELS,
  nextStep,
  roomActionLabel,
  type RoomAction,
  type RoomPhase,
} from '@/domain/room/state-machine';
import { formatCount, formatRank } from '@/lib/format';

/**
 * 司会画面の抽選操作（抽選会・ビンゴ・ルーレット）。
 *
 * 守っている約束:
 * - 出せる操作は Snapshot の availableActions だけ。文言は roomActionLabel でモードへ合わせる。
 * - **次に何が出るかはこの画面に無い。** 引く操作を受けた瞬間にサーバーが決める。
 * - 取り消し・リセットは引いた記録が消える。押した瞬間には実行せず、必ず確認を挟む。
 * - 押しても必ず失敗するボタンは出さない（1 件も引いていないときの取り消し・リセット）。
 * - 効果音はこの画面では鳴らさない（音は投影画面の責務）。
 */

export type HostDrawPanelProps = {
  mode: RoomMode;
  phase: RoomPhase;
  draw: StageDraw;
  availableActions: readonly RoomAction[];
  /** 実行中の操作。押した 1 つだけを処理中にするために使う。 */
  busyAction: RoomAction | null;
  /** ほかの欄も含めて処理中か。二重送信を防ぐため、その間は全ボタンを無効にする。 */
  busy: boolean;
  onRunAction: (action: RoomAction) => void;
};

/**
 * 「そのほかの操作」へ並べる操作。
 *
 * 引く操作そのものは大きな 1 ボタンに任せ、ここには事故からの復帰と終了だけを置く。
 */
const SECONDARY_ACTIONS = ['undo_draw', 'reset_draws', 'finish_room', 'reopen_room'] as const;

/** 確認を挟む操作。どれも会場へ発表済みの結果を動かすため、押した瞬間には実行しない。 */
const CONFIRM_ACTIONS = ['undo_draw', 'reset_draws', 'finish_room'] as const;

type ConfirmAction = (typeof CONFIRM_ACTIONS)[number];

function needsConfirm(action: RoomAction): action is ConfirmAction {
  return (CONFIRM_ACTIONS as readonly RoomAction[]).includes(action);
}

/**
 * 何番目に引いたものかを示す文言。投影画面と同じ言い方に揃える。
 *
 * 数え方の単位は引くものの種類で決まる（名簿は「人」、数字の球は「個」、景品は「件」）。
 * 司会がそのまま会場へ読み上げられる言葉にする。
 */
function ordinalLabel(order: number, mode: RoomMode, draw: StageDraw): string {
  const counted = formatCount(order, drawUnit(draw.kind));
  return mode === 'lottery' ? `${counted}目の当選` : `${counted}目`;
}

export function HostDrawPanel({
  mode,
  phase,
  draw,
  availableActions,
  busyAction,
  busy,
  onRunAction,
}: HostDrawPanelProps) {
  const [pending, setPending] = useState<ConfirmAction | null>(null);

  const isLottery = mode === 'lottery';
  const unit = drawUnit(draw.kind);
  /*
    ルーレットは引いたものを母集団から外さない。
    「残り」という言い方が成り立たないので、件数の見せ方を変える。
  */
  const counts = removesDrawnEntries(mode)
    ? `残り ${formatCount(draw.remainingCount, unit)} / 全 ${formatCount(draw.entries.length, unit)}`
    : `全 ${formatCount(draw.entries.length, '項目')}`;

  const history = useMemo(() => drawnStageEntries(draw), [draw]);
  const latest = useMemo(() => latestStageEntry(draw), [draw]);

  /**
   * ふつうの進行で次に押す操作。
   *
   * 司会は本番中に会場を見ながら操作する。抽選会もビンゴも
   * 「引く」を繰り返すだけで終わりまで進めるようにしている。
   */
  const step = useMemo(
    () =>
      nextStep({
        phase,
        mode,
        nextQuestionPosition: null,
        remainingDrawCount: draw.remainingCount,
      }),
    [draw.remainingCount, mode, phase],
  );

  /**
   * そのほかの操作。
   *
   * 大きなボタンと同じ操作は重ねて出さない。
   * 1 件も引いていないうちは取り消し・リセットも出さない
   * （サーバーが必ず断るので、押せるのに何も起きないボタンになる）。
   */
  const secondaryActions = useMemo(
    () =>
      SECONDARY_ACTIONS.filter((action) => {
        if (!availableActions.includes(action) || action === step?.action) {
          return false;
        }
        if (action === 'undo_draw' || action === 'reset_draws') {
          return draw.drawn.length > 0;
        }
        return true;
      }),
    [availableActions, draw.drawn.length, step?.action],
  );

  const handleRunAction = useCallback(
    (action: RoomAction) => {
      if (needsConfirm(action)) {
        setPending(action);
        return;
      }
      onRunAction(action);
    },
    [onRunAction],
  );

  const confirm = pending === null ? null : confirmContentOf(pending, mode, draw);

  return (
    <>
      <Card title="進行操作" description="ふつうはこの大きなボタンを押していくだけで進みます。">
        {step !== null ? (
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              variant={step.action === 'finish_room' ? 'danger' : 'primary'}
              className="min-h-16 w-full text-xl"
              loading={busyAction === step.action}
              disabled={busy && busyAction !== step.action}
              onClick={() => {
                handleRunAction(step.action);
              }}
            >
              {step.label}
            </Button>
            <p className="text-xs text-slate-600">
              いまは「{ROOM_PHASE_LABELS[phase]}」です。
              {!removesDrawnEntries(mode)
                ? `${counts}。何度でも出ます。`
                : draw.remainingCount === 0 && draw.drawn.length > 0
                  ? '引くものは残っていません。'
                  : `残り ${formatCount(draw.remainingCount, unit)}。`}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {phase === 'finished'
              ? `終了しています。下の「${roomActionLabel('reopen_room', mode)}」から続きを再開できます。`
              : '進められる操作がありません。抽選リストの中身をご確認ください。'}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          {secondaryActions.length === 0 ? (
            <p className="text-sm text-slate-600">個別に選べる操作はありません。</p>
          ) : null}
          {secondaryActions.map((action) => (
            <Button
              key={action}
              size="md"
              variant={
                action === 'finish_room' || action === 'reset_draws' ? 'danger' : 'secondary'
              }
              loading={busyAction === action}
              disabled={busy && busyAction !== action}
              onClick={() => {
                handleRunAction(action);
              }}
            >
              {roomActionLabel(action, mode)}
            </Button>
          ))}
        </div>
      </Card>

      <Card title={isLottery ? '直近の当選' : '直近に引いたもの'} description={counts}>
        {latest === null ? (
          <p className="text-sm text-slate-600">
            まだ 1 件も引いていません。「{step?.label ?? roomActionLabel('draw_next', mode)}
            」を押すとここに出ます。
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            {latest.image !== null ? (
              // next/image は署名付き外部 URL の設定が要るため、司会画面では素の img を使う。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={latest.image.url}
                alt={latest.image.alt}
                width={latest.image.width}
                height={latest.image.height}
                className="block h-24 w-auto max-w-full rounded-xl border border-slate-200"
              />
            ) : null}
            <div className="min-w-0">
              <Badge variant="brand" size="md">
                {ordinalLabel(latest.order, mode, draw)}
              </Badge>
              <p className="mt-2 text-4xl leading-tight font-bold break-words text-slate-900">
                {latest.label}
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card
        title={isLottery ? '当選者' : '出たもの'}
        description={`引いた順に並びます（${formatCount(history.length, unit)}）。`}
      >
        {history.length === 0 ? (
          <p className="text-sm text-slate-600">
            引いたものがここに残ります。会場から聞かれたときに読み上げてください。
          </p>
        ) : (
          <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-slate-50"
              >
                <Badge variant={isLottery && entry.order <= 3 ? 'brand' : 'neutral'}>
                  {isLottery ? formatRank(entry.order) : `${entry.order}${unit}目`}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-bold text-slate-900">
                  {entry.label}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? null}
        confirmLabel={confirm?.confirmLabel ?? '実行する'}
        busy={pending !== null && busyAction === pending}
        onConfirm={() => {
          if (pending === null) {
            return;
          }
          const action = pending;
          setPending(null);
          onRunAction(action);
        }}
        onCancel={() => {
          setPending(null);
        }}
      />
    </>
  );
}

type ConfirmContent = {
  title: string;
  /** 何が失われるかを具体的に書く。会場では取り返しがつかない。 */
  description: ReactNode;
  confirmLabel: string;
};

function confirmContentOf(action: ConfirmAction, mode: RoomMode, draw: StageDraw): ConfirmContent {
  const isLottery = mode === 'lottery';
  const unit = drawUnit(draw.kind);

  if (action === 'undo_draw') {
    const latest = latestStageEntry(draw);
    return {
      title: isLottery ? '直前の当選を取り消しますか？' : '直前の1件を取り消しますか？',
      description:
        latest === null ? (
          <p>直前に引いた 1 件を取り消します。</p>
        ) : (
          <>
            <p>
              「{latest.label}」（{ordinalLabel(latest.order, mode, draw)}）を取り消します。
            </p>
            <p className="mt-2">
              取り消したものは、もう一度引ける状態へ戻ります。会場へ発表済みの場合は
              言い直しが必要です。
            </p>
          </>
        ),
      confirmLabel: '取り消す',
    };
  }

  if (action === 'reset_draws') {
    return {
      title: isLottery ? '当選をすべてリセットしますか？' : '出たものをすべてリセットしますか？',
      description: (
        <>
          <p>これまでに引いた {formatCount(draw.drawn.length, unit)} の記録をすべて消します。</p>
          <p className="mt-2">
            <strong className="font-bold">元には戻せません。</strong>
            会場へ発表済みの結果も無かったことになります。
          </p>
        </>
      ),
      confirmLabel: 'リセットする',
    };
  }

  return {
    title: isLottery ? '抽選会を終了しますか？' : 'ビンゴを終了しますか？',
    description: (
      <>
        <p>終了すると引けなくなり、投影画面は終了の表示へ切り替わります。</p>
        <p className="mt-2">
          終了したあとでも「{roomActionLabel('reopen_room', mode)}
          」から続きを再開できます（引いた記録は残ります）。
        </p>
      </>
    ),
    confirmLabel: '終了する',
  };
}
