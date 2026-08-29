'use client';

import { useCallback, useMemo, useState } from 'react';
import { NoticePanel } from '@/components/participant/NoticePanel';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { optionsOfGroup, rankLabel, type BallotOption } from '@/domain/poll/ballot';
import type { PollResult, PollStage } from '@/domain/poll/poll-stage';
import type { RoomPhase } from '@/domain/room/state-machine';
import { apiPost, isApiClientError } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/client/cn';
import type { SubmitVoteResponse } from '@/types/api';

/**
 * 参加者の投票画面。
 *
 * 守ること:
 * - **1 台につき 1 票**。送ったあとは選び直せない。押す前に選んだ内容を必ず見せる。
 * - 受付中は票数も順位も出さない（サーバーがそもそも送ってこない）。
 * - 音・振動は扱わない（効果音は投影画面だけの責務）。
 * - 締切と重複の最終判定はサーバー。ここでの判定は押し間違いを減らすためのもの。
 */

export type PollVotePanelProps = {
  roomId: string;
  phase: RoomPhase;
  poll: PollStage;
  /** すでに入れた票（選んだ順）。まだなら null。 */
  myVote: readonly string[] | null;
  /** 発表済みの順位。まだなら null。 */
  result: PollResult | null;
  /** 送信後に Snapshot を取り直す。 */
  onVoted: () => void;
};

export function PollVotePanel({
  roomId,
  phase,
  poll,
  myVote,
  result,
  onVoted,
}: PollVotePanelProps) {
  /** 選んだ順の選択肢 ID。先頭が 1 位。 */
  const [choices, setChoices] = useState<string[]>([]);
  /** 2 段階のとき、いま開いている区分。 */
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  /** 送信が通った直後。Snapshot が届くまでのあいだ「投票済み」を見せる。 */
  const [justVoted, setJustVoted] = useState<string[] | null>(null);

  const rankDepth = poll.settings.rankDepth;
  const nested = poll.structure === 'nested';
  const voted = myVote !== null || justVoted !== null;
  const votedChoices = myVote ?? justVoted ?? [];

  const optionById = useMemo(
    () => new Map(poll.options.map((option) => [option.id, option])),
    [poll.options],
  );
  const groupLabelById = useMemo(
    () => new Map(poll.groups.map((group) => [group.id, group.label])),
    [poll.groups],
  );

  const visibleOptions = useMemo<BallotOption[]>(
    () => (nested ? optionsOfGroup(poll, openGroupId) : poll.options),
    [nested, openGroupId, poll],
  );

  const toggle = useCallback(
    (optionId: string) => {
      setSubmitError(null);
      setChoices((previous) => {
        if (previous.includes(optionId)) {
          return previous.filter((id) => id !== optionId);
        }
        if (rankDepth === 1) {
          // 1 位だけを選ぶ会では、押すたびに選び直しになる。
          return [optionId];
        }
        if (previous.length >= rankDepth) {
          return previous;
        }
        return [...previous, optionId];
      });
    },
    [rankDepth],
  );

  const handleSubmit = useCallback(async () => {
    if (choices.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiPost<SubmitVoteResponse>(`/api/rooms/${roomId}/vote`, { choices });
      // 成功応答を受け取ってから初めて「投票済み」にする。
      setJustVoted(response.choices);
      onVoted();
    } catch (caught) {
      // すでに入れていた場合は、この端末の票をサーバーから取り直して見せる。
      if (isApiClientError(caught) && caught.code === 'ALREADY_VOTED') {
        setJustVoted(choices);
        onVoted();
      } else {
        setSubmitError(caught);
      }
    } finally {
      setSubmitting(false);
    }
  }, [choices, onVoted, roomId, submitting]);

  // -------------------------------------------------------------------------
  // 発表
  // -------------------------------------------------------------------------

  if (result !== null && result.entries.length > 0) {
    return (
      <div className="flex flex-col gap-4">
        <NoticePanel title="結果発表" description="会場のスクリーンをご覧ください" tone="brand" />
        <ol className="flex flex-col gap-2">
          {result.entries.map((entry) => (
            <li
              key={entry.optionId}
              className={cn(
                'flex flex-col gap-1 rounded-2xl border p-4 shadow-sm',
                entry.rank === 1
                  ? 'border-brand-300 bg-brand-50 text-brand-900'
                  : 'border-slate-200 bg-white text-slate-900',
              )}
            >
              <span className="flex items-center gap-2">
                <Badge variant={entry.rank === 1 ? 'brand' : 'info'} size="md">
                  {rankLabel(entry.rank)}
                </Badge>
                {votedChoices.includes(entry.optionId) ? (
                  <Badge variant="success">あなたが選んだもの</Badge>
                ) : null}
              </span>
              <span className="text-xl font-bold">{entry.label}</span>
              {entry.groupLabel !== null || entry.note !== null ? (
                <span className="text-sm opacity-80">
                  {[entry.groupLabel, entry.note].filter((value) => value !== null).join('／')}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 投票済み・受付前・締切後
  // -------------------------------------------------------------------------

  if (voted) {
    return (
      <div className="flex flex-col gap-4">
        <NoticePanel
          title="投票を受け付けました"
          description={
            phase === 'poll_open'
              ? '締め切りまでこの画面のままお待ちください'
              : '結果の発表をお待ちください'
          }
          tone="brand"
        >
          <p className="mt-1 text-xs opacity-80">1台につき1票のため、選び直しはできません。</p>
        </NoticePanel>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold text-slate-700">あなたが入れた票</h2>
          <ol className="mt-2 flex flex-col gap-2">
            {votedChoices.map((optionId, index) => {
              const option = optionById.get(optionId);
              return (
                <li key={optionId} className="flex items-center gap-2">
                  {rankDepth > 1 ? <Badge variant="brand">{rankLabel(index + 1)}</Badge> : null}
                  <span className="font-bold text-slate-900">{option?.label ?? '（不明）'}</span>
                  {option?.groupId ? (
                    <span className="text-xs text-slate-600">
                      {groupLabelById.get(option.groupId) ?? ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    );
  }

  if (phase !== 'poll_open') {
    return (
      <NoticePanel
        title={phase === 'lobby' ? 'まもなく投票がはじまります' : '投票は締め切られました'}
        description={
          phase === 'lobby' ? 'この画面のままお待ちください' : '結果の発表をお待ちください'
        }
        waiting
        tone={phase === 'lobby' ? 'brand' : 'muted'}
      />
    );
  }

  // -------------------------------------------------------------------------
  // 投票する
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">{poll.title}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {rankDepth === 1
            ? 'いちばん良かったものを1つ選んでください。'
            : `良かった順に${rankDepth}つまで選べます。押した順が順位になります。`}
        </p>
        <p className="mt-1 text-xs text-slate-500">1台につき1票です。送ると選び直せません。</p>
      </section>

      {choices.length > 0 ? (
        <section className="border-brand-200 bg-brand-50 rounded-2xl border p-4 shadow-sm">
          <h2 className="text-brand-900 text-sm font-bold">選んだもの</h2>
          <ol className="mt-2 flex flex-col gap-2">
            {choices.map((optionId, index) => (
              <li key={optionId} className="flex items-center gap-2">
                {rankDepth > 1 ? <Badge variant="brand">{rankLabel(index + 1)}</Badge> : null}
                <span className="text-brand-900 min-w-0 flex-1 truncate font-bold">
                  {optionById.get(optionId)?.label ?? ''}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toggle(optionId);
                  }}
                >
                  取り消す
                </Button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {nested ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-bold text-slate-700">
            {openGroupId === null ? 'まず区分を選んでください' : '選ぶものを選んでください'}
          </h2>
          {openGroupId === null ? (
            <ul className="flex flex-col gap-2">
              {poll.groups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    className="focus-visible:outline-brand-600 flex min-h-14 w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 text-left text-base font-bold text-slate-900 shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => {
                      setOpenGroupId(group.id);
                    }}
                  >
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="ml-2 shrink-0 text-xs font-normal text-slate-600">
                      {formatCount(optionsOfGroup(poll, group.id).length, '件')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => {
                  setOpenGroupId(null);
                }}
              >
                ← 区分を選び直す
              </Button>
              <p className="text-xs font-bold text-slate-600">
                {groupLabelById.get(openGroupId) ?? ''}
              </p>
              <OptionList
                options={visibleOptions}
                choices={choices}
                rankDepth={rankDepth}
                onToggle={toggle}
              />
            </>
          )}
        </section>
      ) : (
        <OptionList
          options={visibleOptions}
          choices={choices}
          rankDepth={rankDepth}
          onToggle={toggle}
        />
      )}

      {submitError !== null ? <ErrorMessage error={submitError} /> : null}

      <div className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <Button
          size="lg"
          className="w-full"
          loading={submitting}
          disabled={choices.length === 0}
          onClick={() => void handleSubmit()}
        >
          {choices.length === 0
            ? '選んでから投票できます'
            : rankDepth === 1
              ? 'この内容で投票する'
              : `${formatCount(choices.length, '件')}で投票する`}
        </Button>
        <p className="mt-1 text-center text-xs text-slate-600">
          送ると選び直せません。内容を確かめてから押してください。
        </p>
      </div>
    </div>
  );
}

function OptionList({
  options,
  choices,
  rankDepth,
  onToggle,
}: {
  options: readonly BallotOption[];
  choices: readonly string[];
  rankDepth: number;
  onToggle: (optionId: string) => void;
}) {
  const full = choices.length >= rankDepth;

  return (
    <ul className="flex flex-col gap-2">
      {options.map((option) => {
        const index = choices.indexOf(option.id);
        const selected = index >= 0;
        // 上限まで選んだあとは、選んでいないものを押せなくする
        // （押しても何も起きない状態にすると、壊れたように見える）。
        const disabled = !selected && full && rankDepth > 1;
        return (
          <li key={option.id}>
            <button
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              className={cn(
                'focus-visible:outline-brand-600 flex min-h-16 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2',
                selected
                  ? 'border-brand-400 bg-brand-50 text-brand-900'
                  : 'border-slate-200 bg-white text-slate-900',
                disabled && 'opacity-50',
              )}
              onClick={() => {
                onToggle(option.id);
              }}
            >
              {selected && rankDepth > 1 ? (
                <Badge variant="brand" size="md">
                  {rankLabel(index + 1)}
                </Badge>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block text-base font-bold">{option.label}</span>
                {option.note !== null ? (
                  <span className="block text-xs opacity-80">{option.note}</span>
                ) : null}
              </span>
              {selected && rankDepth === 1 ? <Badge variant="brand">選択中</Badge> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
