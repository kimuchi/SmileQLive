'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { SaveStatus, type SaveState } from '@/components/shared/SaveStatus';
import { Select } from '@/components/shared/Select';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { ImageField } from '@/components/admin/image-field';
import { useAutosave } from '@/components/admin/use-autosave';
import {
  BALLOT_GROUP_MAX_COUNT,
  BALLOT_LABEL_MAX_LENGTH,
  BALLOT_OPTION_MAX_COUNT,
  BALLOT_STRUCTURES,
  BALLOT_STRUCTURE_HINTS,
  BALLOT_STRUCTURE_LABELS,
  RANK_DEPTH_MAX,
  RANK_DEPTH_MIN,
  RANK_POINTS_MAX,
  RANK_POINTS_MIN,
  REVEAL_DEPTH_MAX,
  normalizePoints,
  rankLabel,
  type BallotStructure,
} from '@/domain/poll/ballot';
import { DRAW_FONT_SIZE_MAX, DRAW_FONT_SIZE_MIN } from '@/domain/draw/draw-list';
import { apiGet, apiPatch } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import { formatClockTime, formatCount } from '@/lib/format';
import type { AdminMediaRef, PollBallotDetailResponse } from '@/types/api';

/**
 * 投票用紙の編集。
 *
 * 保存の仕方を 2 つに分けている（抽選リストの編集と同じ考え方）。
 * - 名前・選び方・点数・発表の設定 … 1 つの書き込みで済むので**自動保存**する。
 * - 区分と選択肢の一覧 … 保存は「今の全件を送って丸ごと入れ替える」ため、
 *   打鍵のたびに送ると入力中の空欄が落ちる。**押したときだけ**送る。
 *   代わりに、未保存のまま画面を離れないよう状態を常に見せる。
 *
 * 並べ替え・削除・追加もすべて手元の一覧を組み替えるだけにし、
 * 「保存する」で初めてサーバーへ渡す。
 */

type BallotDetail = PollBallotDetailResponse['ballot'];

const TITLE_MAX_LENGTH = 120;

const STRUCTURE_OPTIONS = BALLOT_STRUCTURES.map((structure) => ({
  value: structure,
  label: BALLOT_STRUCTURE_LABELS[structure],
  description: BALLOT_STRUCTURE_HINTS[structure],
}));

type GroupDraft = { id: string; label: string };
type OptionDraft = { id: string; label: string; note: string; groupId: string | null };

type SettingsDraft = {
  title: string;
  structure: BallotStructure;
  rankDepth: number;
  /** 順位ごとの点数。文字で持つのは、入力中の「1」→「」→「10」を壊さないため。 */
  points: string[];
  revealDepth: number;
  resultFontSize: string;
  backgroundAssetId: string | null;
};

function toGroupDrafts(ballot: BallotDetail): GroupDraft[] {
  return ballot.groups.map((group) => ({ id: group.id, label: group.label }));
}

function toOptionDrafts(ballot: BallotDetail): OptionDraft[] {
  return ballot.options.map((option) => ({
    id: option.id,
    label: option.label,
    note: option.note ?? '',
    groupId: option.groupId,
  }));
}

function toSettingsDraft(ballot: BallotDetail): SettingsDraft {
  return {
    title: ballot.title,
    structure: ballot.structure,
    rankDepth: ballot.settings.rankDepth,
    points: ballot.settings.points.map((value) => String(value)),
    revealDepth: ballot.settings.revealDepth,
    resultFontSize: String(ballot.settings.resultFontSize),
    backgroundAssetId: ballot.settings.backgroundAssetId,
  };
}

/** 全角で入力された数字も受け取る（会場の PC は日本語入力のままのことが多い）。 */
function parseIntegerInput(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 点数の並びを何位まで選ぶかに合わせる。既定は「1 位ほど高い」。 */
function resizePoints(points: readonly string[], rankDepth: number): string[] {
  const numbers = points.map((value) => parseIntegerInput(value));
  return normalizePoints(
    numbers.map((value) => value ?? Number.NaN),
    rankDepth,
  ).map((value, index) => {
    const kept = numbers[index];
    return kept === null || kept === undefined ? String(value) : String(kept);
  });
}

export type PollBallotEditorProps = {
  ballotId: string;
};

export function PollBallotEditor({ ballotId }: PollBallotEditorProps) {
  const [ballot, setBallot] = useState<BallotDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [listDirty, setListDirty] = useState(false);
  const [listStatus, setListStatus] = useState<SaveState>('idle');
  const [listSavedAt, setListSavedAt] = useState<string | undefined>(undefined);
  const [listError, setListError] = useState<string | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<AdminMediaRef | null>(null);
  const [backgroundAlt, setBackgroundAlt] = useState('');

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<PollBallotDetailResponse>(
        `/api/admin/poll-ballots/${ballotId}`,
      );
      setBallot(response.ballot);
      // 入力中の下書きは上書きしない（再取得で打った文字を消さない）。
      setSettings((previous) => previous ?? toSettingsDraft(response.ballot));
      setGroups((previous) => (previous.length > 0 ? previous : toGroupDrafts(response.ballot)));
      setOptions((previous) => (previous.length > 0 ? previous : toOptionDrafts(response.ballot)));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [ballotId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  // ---------------------------------------------------------------------
  // 名前・点数・発表の設定（自動保存）
  // ---------------------------------------------------------------------

  const saveSettings = useCallback(async () => {
    if (!settings) {
      return;
    }
    const title = settings.title.trim();
    if (title.length === 0) {
      // 直し方は入力欄のエラーに出している。直るまで送らない。
      throw new Error('POLL_BALLOT_DRAFT_INVALID');
    }
    const resultFontSize = parseIntegerInput(settings.resultFontSize);
    if (
      resultFontSize === null ||
      resultFontSize < DRAW_FONT_SIZE_MIN ||
      resultFontSize > DRAW_FONT_SIZE_MAX
    ) {
      throw new Error('POLL_BALLOT_DRAFT_INVALID');
    }

    const response = await apiPatch<PollBallotDetailResponse>(
      `/api/admin/poll-ballots/${ballotId}`,
      {
        title,
        structure: settings.structure,
        settings: {
          rankDepth: settings.rankDepth,
          // 空欄や読めない値は既定へ寄せる。入力中に保存されても壊れない。
          points: normalizePoints(
            settings.points.map((value) => parseIntegerInput(value) ?? Number.NaN),
            settings.rankDepth,
          ),
          revealDepth: settings.revealDepth,
          resultFontSize,
          backgroundAssetId: settings.backgroundAssetId,
        },
      },
    );
    setBallot(response.ballot);
  }, [ballotId, settings]);

  const {
    schedule: scheduleSettings,
    saveNow: saveSettingsNow,
    status: settingsStatus,
    savedAtLabel,
  } = useAutosave(saveSettings);

  const patchSettings = useCallback(
    (patch: Partial<SettingsDraft>) => {
      setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
      scheduleSettings();
    },
    [scheduleSettings],
  );

  // ---------------------------------------------------------------------
  // 区分と選択肢（保存は押したときだけ）
  // ---------------------------------------------------------------------

  const markListDirty = useCallback(() => {
    setListDirty(true);
    setListStatus('idle');
  }, []);

  const addGroup = useCallback(() => {
    setGroups((previous) => [...previous, { id: crypto.randomUUID(), label: '' }]);
    markListDirty();
  }, [markListDirty]);

  const patchGroup = useCallback(
    (id: string, patch: Partial<GroupDraft>) => {
      setGroups((previous) =>
        previous.map((group) => (group.id === id ? { ...group, ...patch } : group)),
      );
      markListDirty();
    },
    [markListDirty],
  );

  const removeGroup = useCallback(
    (id: string) => {
      setGroups((previous) => previous.filter((group) => group.id !== id));
      // 消した区分に属していた選択肢は宙に浮く。選び直してもらうため外しておく。
      setOptions((previous) =>
        previous.map((option) => (option.groupId === id ? { ...option, groupId: null } : option)),
      );
      markListDirty();
    },
    [markListDirty],
  );

  const addOption = useCallback(() => {
    setOptions((previous) => [
      ...previous,
      { id: crypto.randomUUID(), label: '', note: '', groupId: null },
    ]);
    markListDirty();
  }, [markListDirty]);

  const patchOption = useCallback(
    (id: string, patch: Partial<OptionDraft>) => {
      setOptions((previous) =>
        previous.map((option) => (option.id === id ? { ...option, ...patch } : option)),
      );
      markListDirty();
    },
    [markListDirty],
  );

  const removeOption = useCallback(
    (id: string) => {
      setOptions((previous) => previous.filter((option) => option.id !== id));
      markListDirty();
    },
    [markListDirty],
  );

  const moveOption = useCallback(
    (index: number, direction: -1 | 1) => {
      setOptions((previous) => {
        const target = index + direction;
        if (target < 0 || target >= previous.length) {
          return previous;
        }
        const next = [...previous];
        const current = next[index];
        const swapped = next[target];
        if (!current || !swapped) {
          return previous;
        }
        next[index] = swapped;
        next[target] = current;
        return next;
      });
      markListDirty();
    },
    [markListDirty],
  );

  const handleSaveList = useCallback(async () => {
    const structure = settings?.structure ?? 'flat';

    const emptyGroup = groups.findIndex((group) => group.label.trim().length === 0);
    if (structure === 'nested' && emptyGroup >= 0) {
      setListError(`区分の${emptyGroup + 1}行目が空です。名前を入れるか、削除してください。`);
      setListStatus('error');
      return;
    }

    const emptyOption = options.findIndex((option) => option.label.trim().length === 0);
    if (emptyOption >= 0) {
      // 空の行を黙って落とすと「入れたのに出てこない」事故になる。
      setListError(`選択肢の${emptyOption + 1}行目が空です。名前を入れるか、削除してください。`);
      setListStatus('error');
      return;
    }

    if (structure === 'nested') {
      const orphan = options.findIndex((option) => option.groupId === null);
      if (orphan >= 0) {
        // 区分に属していない選択肢は参加者が選べない。当日に気づくのでは遅い。
        setListError(
          `選択肢の${orphan + 1}行目に区分が選ばれていません。2段階の投票では全部に区分が要ります。`,
        );
        setListStatus('error');
        return;
      }
    }

    if (options.length > BALLOT_OPTION_MAX_COUNT) {
      setListError(
        `1つの用紙に入れられるのは${formatCount(BALLOT_OPTION_MAX_COUNT, '件')}までです。`,
      );
      setListStatus('error');
      return;
    }

    setListError(null);
    setListStatus('saving');
    try {
      const response = await apiPatch<PollBallotDetailResponse>(
        `/api/admin/poll-ballots/${ballotId}`,
        {
          structure,
          groups: groups.map((group) => ({ id: group.id, label: group.label.trim() })),
          options: options.map((option) => ({
            id: option.id,
            label: option.label.trim(),
            groupId: structure === 'nested' ? option.groupId : null,
            note: option.note.trim().length > 0 ? option.note.trim() : null,
          })),
        },
      );
      setBallot(response.ballot);
      setGroups(toGroupDrafts(response.ballot));
      setOptions(toOptionDrafts(response.ballot));
      setListDirty(false);
      setListSavedAt(formatClockTime(new Date(), { withSeconds: false }));
      setListStatus('saved');
    } catch (caught) {
      setListError(toUserErrorMessage(caught));
      setListStatus('error');
    }
  }, [ballotId, groups, options, settings?.structure]);

  if (!ballot || !settings) {
    return (
      <Card>
        {loadError !== null ? (
          <ErrorMessage error={loadError} onRetry={() => void load()} />
        ) : (
          <div className="flex items-center gap-3 text-slate-600">
            <Spinner />
            <span>読み込んでいます</span>
          </div>
        )}
      </Card>
    );
  }

  const nested = settings.structure === 'nested';
  const groupOptions = groups.map((group) => ({
    value: group.id,
    label: group.label.trim().length > 0 ? group.label : '（名前なし）',
  }));

  return (
    <div className="flex flex-col gap-6">
      {loadError !== null ? <ErrorMessage error={loadError} onRetry={() => void load()} /> : null}

      <Card
        title="基本の設定"
        actions={<SaveStatus status={settingsStatus} savedAtLabel={savedAtLabel} showWhenIdle />}
      >
        <div className="flex flex-col gap-5">
          <TextInput
            label="投票の名前"
            required
            maxLength={TITLE_MAX_LENGTH}
            value={settings.title}
            error={settings.title.trim().length === 0 ? '名前を入力してください' : undefined}
            hint="投影画面の見出しに使います。"
            onChange={(event) => {
              patchSettings({ title: event.currentTarget.value });
            }}
          />

          <RadioGroup<BallotStructure>
            name="poll-ballot-structure"
            legend="選び方"
            options={STRUCTURE_OPTIONS}
            value={settings.structure}
            hint="2段階にすると、区分ごとに選択肢を分けられます。候補が多いときに選びやすくなります。"
            onChange={(value) => {
              patchSettings({ structure: value });
              // 選び方が変わると選択肢の保存の仕方も変わる。押し忘れないよう未保存にする。
              markListDirty();
            }}
          />
        </div>
      </Card>

      <Card title="何位まで選ぶか・点数">
        <div className="flex flex-col gap-5">
          <Select
            label="投票する人が選ぶ順位"
            value={String(settings.rankDepth)}
            options={Array.from({ length: RANK_DEPTH_MAX - RANK_DEPTH_MIN + 1 }, (_, index) => {
              const depth = RANK_DEPTH_MIN + index;
              return {
                value: String(depth),
                label: depth === 1 ? '1位だけを選ぶ' : `${depth}位まで選ぶ`,
              };
            })}
            hint="1位だけの会も、3位まで選んで重みを付ける会もあります。"
            onChange={(event) => {
              const rankDepth = Number.parseInt(event.currentTarget.value, 10);
              patchSettings({
                rankDepth,
                points: resizePoints(settings.points, rankDepth),
              });
            }}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-bold text-slate-900">順位ごとの点数</legend>
            <p className="text-sm text-slate-600">
              その順位に選ばれると入る点数です。合計が高いものから順位が付きます。
              0点にすると「選べるが点は入らない」になります。
            </p>
            <div className="flex flex-wrap gap-3">
              {settings.points.map((value, index) => (
                <TextInput
                  key={`points-${String(index)}`}
                  label={`${rankLabel(index + 1)}の点数`}
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-32"
                  value={value}
                  error={
                    (parseIntegerInput(value) ?? -1) < RANK_POINTS_MIN ||
                    (parseIntegerInput(value) ?? RANK_POINTS_MAX + 1) > RANK_POINTS_MAX
                      ? `${RANK_POINTS_MIN}〜${RANK_POINTS_MAX}`
                      : undefined
                  }
                  onChange={(event) => {
                    const next = [...settings.points];
                    next[index] = event.currentTarget.value;
                    patchSettings({ points: next });
                  }}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </Card>

      <Card title="結果発表">
        <div className="flex flex-col gap-5">
          <Select
            label="何位まで発表するか"
            value={String(settings.revealDepth)}
            options={Array.from({ length: REVEAL_DEPTH_MAX }, (_, index) => {
              const depth = index + 1;
              return {
                value: String(depth),
                label: depth === 1 ? '1位だけ発表する' : `${depth}位から順に発表する`,
              };
            })}
            hint="選ぶ順位とは別に決められます。3位まで選ばせて1位だけ発表する、という使い方もできます。発表は下の順位から1つずつ出します。"
            onChange={(event) => {
              patchSettings({ revealDepth: Number.parseInt(event.currentTarget.value, 10) });
            }}
          />

          <TextInput
            label="結果の文字の大きさ"
            inputMode="numeric"
            autoComplete="off"
            className="w-40"
            value={settings.resultFontSize}
            hint={`1920×1080 の投影での px。${DRAW_FONT_SIZE_MIN}〜${DRAW_FONT_SIZE_MAX}。`}
            error={
              ((parseIntegerInput(settings.resultFontSize) ?? -1) < DRAW_FONT_SIZE_MIN ||
                (parseIntegerInput(settings.resultFontSize) ?? DRAW_FONT_SIZE_MAX + 1) >
                  DRAW_FONT_SIZE_MAX) &&
              settings.resultFontSize.length > 0
                ? `${DRAW_FONT_SIZE_MIN}〜${DRAW_FONT_SIZE_MAX}の範囲で入力してください`
                : undefined
            }
            onChange={(event) => {
              patchSettings({ resultFontSize: event.currentTarget.value });
            }}
          />

          <ImageField
            label="投影の背景"
            scope={{ kind: 'pollBallot', ballotId }}
            usage="stageBackground"
            image={backgroundImage}
            alt={backgroundAlt}
            hint="結果発表の背景に敷きます。選ばなければ既定の背景です。"
            onImageChange={(image) => {
              setBackgroundImage(image);
              patchSettings({ backgroundAssetId: image?.assetId ?? null });
              // 画像は「選んだ」時点で確定させる。押し忘れで背景だけ消えるのを避ける。
              void saveSettingsNow();
            }}
            onAltChange={setBackgroundAlt}
          />
        </div>
      </Card>

      {nested ? (
        <Card
          title="区分（1段階目）"
          actions={
            <SaveStatus status={listStatus} savedAtLabel={listSavedAt} showWhenIdle={listDirty} />
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">
              まずここから選び、その中の選択肢を選ぶ形になります（例: 部署・チーム）。
              {formatCount(BALLOT_GROUP_MAX_COUNT, '件')}まで。
            </p>
            {groups.length === 0 ? (
              <Alert variant="warning">
                区分がまだありません。2段階の投票では、区分を作ってから選択肢に割り当てます。
              </Alert>
            ) : null}
            {groups.map((group, index) => (
              <div key={group.id} className="flex items-end gap-2">
                <TextInput
                  label={`区分 ${String(index + 1)}`}
                  className="flex-1"
                  maxLength={BALLOT_LABEL_MAX_LENGTH}
                  value={group.label}
                  onChange={(event) => {
                    patchGroup(group.id, { label: event.currentTarget.value });
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    removeGroup(group.id);
                  }}
                >
                  削除
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={groups.length >= BALLOT_GROUP_MAX_COUNT}
                onClick={addGroup}
              >
                区分を追加
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card
        title={nested ? '選択肢（2段階目）' : '選択肢'}
        actions={
          <SaveStatus status={listStatus} savedAtLabel={listSavedAt} showWhenIdle={listDirty} />
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            投票の対象です。{formatCount(BALLOT_OPTION_MAX_COUNT, '件')}まで。
            並び順は、同点だったときの順番にも使います。
          </p>

          {listError !== null ? (
            <p role="alert" className="text-sm font-bold text-red-700">
              {listError}
            </p>
          ) : null}

          {options.length === 0 ? (
            <Alert variant="warning">
              選択肢がまだありません。1件も無い用紙ではルームを作れません。
            </Alert>
          ) : null}

          {options.map((option, index) => (
            <div
              key={option.id}
              className="flex flex-col gap-2 rounded-xl border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-end gap-2">
                <TextInput
                  label={`選択肢 ${String(index + 1)}`}
                  className="min-w-56 flex-1"
                  maxLength={BALLOT_LABEL_MAX_LENGTH}
                  value={option.label}
                  onChange={(event) => {
                    patchOption(option.id, { label: event.currentTarget.value });
                  }}
                />
                <TextInput
                  label="補足"
                  className="min-w-40 flex-1"
                  maxLength={BALLOT_LABEL_MAX_LENGTH}
                  value={option.note}
                  hint="発表者名など。空でも構いません。"
                  onChange={(event) => {
                    patchOption(option.id, { note: event.currentTarget.value });
                  }}
                />
                {nested ? (
                  <Select
                    label="区分"
                    className="min-w-40"
                    placeholder="選んでください"
                    value={option.groupId ?? ''}
                    options={groupOptions}
                    error={option.groupId === null ? '区分を選んでください' : undefined}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      patchOption(option.id, { groupId: value.length > 0 ? value : null });
                    }}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => {
                    moveOption(index, -1);
                  }}
                >
                  上へ
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === options.length - 1}
                  onClick={() => {
                    moveOption(index, 1);
                  }}
                >
                  下へ
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    removeOption(option.id);
                  }}
                >
                  削除
                </Button>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={options.length >= BALLOT_OPTION_MAX_COUNT}
              onClick={addOption}
            >
              選択肢を追加
            </Button>
            <Button
              loading={listStatus === 'saving'}
              disabled={!listDirty}
              onClick={() => void handleSaveList()}
            >
              区分と選択肢を保存する
            </Button>
            {listDirty ? (
              <span className="text-sm font-bold text-amber-700">
                未保存の変更があります。押すまでサーバーへ反映されません。
              </span>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
