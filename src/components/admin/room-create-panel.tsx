'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { Select } from '@/components/shared/Select';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { JoinUrlPanel } from '@/components/admin/join-url-panel';
import { PublishIssueList, parsePublishIssues } from '@/components/admin/publish-issue-list';
import { rememberJoinUrl } from '@/components/admin/join-url-store';
import { DRAW_LIST_KIND_LABELS, drawKindsForMode } from '@/domain/draw/draw-list';
import type { PublishIssue } from '@/domain/quiz/publish-validation';
import {
  ROOM_MODES,
  ROOM_MODE_DESCRIPTIONS,
  ROOM_MODE_LABELS,
  type RoomMode,
} from '@/domain/room/room-mode';
import { apiGet, apiPost, isApiClientError } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import type {
  CreateRoomResponse,
  DrawListsResponse,
  QuizListItem,
  QuizListResponse,
} from '@/types/api';

/**
 * ルーム作成。
 *
 * - **最初にモードを選ぶ**。モードはルームを作るときにしか決められない（あとから変えられない）ので、
 *   選んだモードで以降の入力欄ごと切り替える。
 * - クイズ: 公開済みクイズだけを選べる（下書き・アーカイブはサーバー側でも弾かれる）。
 *   作成直後にだけ平文の参加 URL が返る。ここで二次元コードを表示し、
 *   sessionStorage へ一時保管して司会画面へ引き継ぐ。
 * - 抽選会・ビンゴ: 参加者のスマートフォンを使わないため、参加人数の上限も参加 URL も出さない。
 *   代わりに司会画面と投影画面への導線を出す。
 * - ルームコードは発行しない。参加は二次元コードの URL 直行のみ。
 */

const MAX_PARTICIPANTS_MIN = 2;
const MAX_PARTICIPANTS_MAX = 1000;
const MAX_PARTICIPANTS_DEFAULT = '500';

/**
 * 抽選リスト一覧の 1 件。
 *
 * 型の出どころは server-only のリポジトリなので、画面からは直接 import せず
 * 応答の型から取り出す（クライアントの import 元をサーバー専用モジュールへ広げない）。
 */
type DrawListItem = DrawListsResponse['lists'][number];

/** POST /api/rooms の本文。モードによって要るものが違う。 */
type CreateRoomRequest =
  | { mode: 'quiz'; quizId: string; maxParticipants: number }
  | { mode: Exclude<RoomMode, 'quiz'>; drawListId: string };

const MODE_OPTIONS = ROOM_MODES.map((mode) => ({
  value: mode,
  label: ROOM_MODE_LABELS[mode],
  description: ROOM_MODE_DESCRIPTIONS[mode],
}));

export type RoomCreatePanelProps = {
  /** クイズ一覧から遷移してきたときの初期選択。 */
  initialQuizId: string | null;
  /** 抽選リスト画面などから「このモードで作る」と指定して来たときの初期モード。 */
  initialMode: RoomMode;
};

export function RoomCreatePanel({ initialQuizId, initialMode }: RoomCreatePanelProps) {
  const [mode, setMode] = useState<RoomMode>(initialMode);
  const [quizzes, setQuizzes] = useState<QuizListItem[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [drawLists, setDrawLists] = useState<DrawListItem[] | null>(null);
  const [drawLoadError, setDrawLoadError] = useState<unknown>(null);
  const [selectedQuizId, setSelectedQuizId] = useState(initialQuizId ?? '');
  const [selectedDrawListId, setSelectedDrawListId] = useState('');
  const [maxParticipants, setMaxParticipants] = useState(MAX_PARTICIPANTS_DEFAULT);
  const [maxParticipantsError, setMaxParticipantsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  /** 公開条件の不足。details に「第3問: ...」の形で返ってくる。 */
  const [publishIssues, setPublishIssues] = useState<PublishIssue[]>([]);
  const [created, setCreated] = useState<CreateRoomResponse | null>(null);

  /** 1 つずつ引くモードのときだけ値が入る。drawKindsForMode へ渡すために絞っておく。 */
  const drawMode = mode === 'quiz' ? null : mode;

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<QuizListResponse>('/api/admin/quizzes');
      setQuizzes(response.quizzes);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  const loadDrawLists = useCallback(async () => {
    try {
      const response = await apiGet<DrawListsResponse>('/api/admin/draw-lists');
      setDrawLists(response.lists);
      setDrawLoadError(null);
    } catch (caught) {
      setDrawLoadError(caught);
    }
  }, []);

  useEffect(() => {
    // マウント時の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  /** 抽選リストが要るモードか。抽選会とビンゴで同じ一覧を使うので、切り替えでは取り直さない。 */
  const needsDrawLists = drawMode !== null;

  useEffect(() => {
    // クイズだけを開く人に抽選リストの取得をさせないため、モードを選んでから読む。
    if (!needsDrawLists) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void loadDrawLists();
  }, [needsDrawLists, loadDrawLists]);

  const publishedQuizzes = useMemo(
    () => (quizzes ?? []).filter((quiz) => quiz.status === 'published'),
    [quizzes],
  );

  const options = useMemo(
    () =>
      publishedQuizzes.map((quiz) => ({
        value: quiz.id,
        label: `${quiz.title}（${formatCount(quiz.questionCount, '問')}）`,
      })),
    [publishedQuizzes],
  );

  const drawOptions = useMemo(() => {
    if (drawMode === null) {
      return [];
    }
    const allowed = drawKindsForMode(drawMode);
    return (drawLists ?? []).map((list) => {
      const kindLabel = DRAW_LIST_KIND_LABELS[list.kind];
      const usable = allowed.includes(list.kind);
      return {
        value: list.id,
        // 使えないリストも理由を添えて残す。黙って消すと「作ったはずのリストが無い」と見える。
        label: usable
          ? `${list.title}｜${kindLabel}｜${formatCount(list.entryCount, '件')}`
          : `${list.title}｜${kindLabel}｜${ROOM_MODE_LABELS[drawMode]}では使えません`,
        disabled: !usable,
      };
    });
  }, [drawLists, drawMode]);

  const usableDrawCount = useMemo(
    () => drawOptions.filter((option) => !option.disabled).length,
    [drawOptions],
  );

  const drawKindHint =
    drawMode === null
      ? null
      : `${ROOM_MODE_LABELS[drawMode]}では「${drawKindsForMode(drawMode)
          .map((kind) => DRAW_LIST_KIND_LABELS[kind])
          .join('」「')}」のリストを使えます。`;

  const handleModeChange = useCallback((next: RoomMode) => {
    setMode(next);
    // モードが変われば入力欄の意味も変わる。前のモードのエラーを残さない。
    setCreateError(null);
    setPublishIssues([]);
    setMaxParticipantsError(null);
    // 抽選会で使える名簿はビンゴでは使えない。選び直してもらう。
    setSelectedDrawListId('');
  }, []);

  const handleCreate = useCallback(async () => {
    let body: CreateRoomRequest;

    if (drawMode === null) {
      if (selectedQuizId.length === 0) {
        setCreateError('クイズを選んでください');
        return;
      }
      const normalized = maxParticipants.normalize('NFKC').trim();
      if (!/^\d+$/.test(normalized)) {
        setMaxParticipantsError('人数を数字で入力してください');
        return;
      }
      const parsed = Number.parseInt(normalized, 10);
      if (parsed < MAX_PARTICIPANTS_MIN || parsed > MAX_PARTICIPANTS_MAX) {
        setMaxParticipantsError(
          `参加人数の上限は${MAX_PARTICIPANTS_MIN}〜${MAX_PARTICIPANTS_MAX}で入力してください`,
        );
        return;
      }
      body = { mode: 'quiz', quizId: selectedQuizId, maxParticipants: parsed };
    } else {
      if (selectedDrawListId.length === 0) {
        setCreateError('抽選リストを選んでください');
        return;
      }
      // 参加者が来ないモードなので参加人数の上限は送らない（サーバー側で 0 にする）。
      body = { mode: drawMode, drawListId: selectedDrawListId };
    }

    setMaxParticipantsError(null);
    setCreateError(null);
    setPublishIssues([]);
    setCreating(true);
    try {
      const response = await apiPost<CreateRoomResponse>('/api/rooms', body);
      // 平文トークンはここでしか手に入らない。司会画面へ引き継ぐため一時保管する。
      // 抽選会・ビンゴのルームには参加 URL が無い。
      if (response.joinUrl) {
        rememberJoinUrl(response.roomId, response.joinUrl);
      }
      setCreated(response);
    } catch (caught) {
      // 公開条件の不足は「どこを直せばよいか」まで返ってくる。
      // 見出しだけ出して details を捨てると、利用者は原因に辿り着けない。
      if (isApiClientError(caught) && caught.code === 'QUIZ_PUBLISH_VALIDATION_FAILED') {
        setPublishIssues(parsePublishIssues(caught.details));
        setCreateError(null);
      } else {
        setPublishIssues([]);
        setCreateError(caught);
      }
    } finally {
      setCreating(false);
    }
  }, [drawMode, maxParticipants, selectedDrawListId, selectedQuizId]);

  if (created !== null) {
    const createdMode = created.mode;
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success" title="ルームを作成しました">
          「{created.quizTitle}」の進行を始められます。
        </Alert>

        {createdMode === 'quiz' ? (
          <Card
            title="参加用の二次元コード"
            description="会場のスクリーンや掲示物でこの二次元コードを提示してください。"
          >
            <JoinUrlPanel joinUrl={created.joinUrl} qrSize={280} />
          </Card>
        ) : null}

        <Card title="次の操作">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/host/${created.roomId}`}
              className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              司会画面を開く
            </Link>
            {createdMode === 'quiz' ? null : (
              // 投影は別の画面（プロジェクタ側）で開くため、司会画面を閉じない別タブにする。
              <Link
                href={`/present/${created.roomId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-700 font-bold hover:underline"
              >
                投影画面を開く
              </Link>
            )}
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ルーム一覧
            </Link>
            {createdMode === 'quiz' ? (
              <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
                クイズ一覧へ戻る
              </Link>
            ) : null}
          </div>
          {createdMode === 'quiz' ? (
            <p className="mt-3 text-sm text-slate-600">
              参加URLはこの画面を離れると再表示できません。必要なら今のうちにコピーしてください
              （失った場合は司会画面から再発行できます）。
            </p>
          ) : (
            <p className="mt-3 text-sm text-slate-600">
              {ROOM_MODE_LABELS[createdMode]}
              は参加者のスマートフォンを使わないため、参加用の二次元コードはありません。
              別の端末へ投影するときは、司会画面で投影用リンクを発行してください。
            </p>
          )}
        </Card>
      </div>
    );
  }

  /** クイズモードの入力欄。読み込み・未公開・通常の 3 通り。 */
  const renderQuizSection = () => {
    if (quizzes === null) {
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

    if (publishedQuizzes.length === 0) {
      return (
        <Card>
          <p className="text-sm text-slate-700">
            公開済みのクイズがありません。クイズを編集して公開してからルームを作成してください。
          </p>
          <p className="mt-3">
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              クイズ一覧へ
            </Link>
          </p>
        </Card>
      );
    }

    return (
      <Card title="ルームの設定">
        <div className="flex flex-col gap-4">
          <Select
            label="使用するクイズ"
            required
            placeholder="クイズを選んでください"
            options={options}
            value={selectedQuizId}
            onChange={(event) => {
              setSelectedQuizId(event.currentTarget.value);
            }}
          />

          <TextInput
            label="参加人数の上限"
            inputMode="numeric"
            autoComplete="off"
            value={maxParticipants}
            error={maxParticipantsError ?? undefined}
            hint={`${MAX_PARTICIPANTS_MIN}〜${MAX_PARTICIPANTS_MAX}人。上限に達すると新しい参加を受け付けません。`}
            onChange={(event) => {
              setMaxParticipants(event.currentTarget.value);
              if (maxParticipantsError !== null) {
                setMaxParticipantsError(null);
              }
            }}
          />

          <div>
            <Button size="lg" loading={creating} onClick={() => void handleCreate()}>
              ルームを作成する
            </Button>
            <p className="mt-2 text-xs text-slate-600">
              作成すると参加用の二次元コードが表示されます。
            </p>
          </div>
        </div>
      </Card>
    );
  };

  /** 抽選会・ビンゴの入力欄。引くものの一覧（抽選リスト）だけを選ぶ。 */
  const renderDrawSection = () => {
    if (drawMode === null) {
      return null;
    }

    if (drawLists === null) {
      return (
        <Card>
          {drawLoadError !== null ? (
            <ErrorMessage error={drawLoadError} onRetry={() => void loadDrawLists()} />
          ) : (
            <div className="flex items-center gap-3 text-slate-600">
              <Spinner />
              <span>読み込んでいます</span>
            </div>
          )}
        </Card>
      );
    }

    if (usableDrawCount === 0) {
      return (
        <Card title="使える抽選リストがありません">
          <p className="text-sm text-slate-700">
            {drawLists.length === 0
              ? '引くものの一覧（抽選リスト）がまだありません。先に抽選リストを作ってください。'
              : `${drawKindHint}この種類の抽選リストを作ってから、ルームを作成してください。`}
          </p>
          <p className="mt-3">
            <Link href="/admin/draw-lists/new" className="text-brand-700 font-bold hover:underline">
              抽選リストを作る
            </Link>
          </p>
        </Card>
      );
    }

    return (
      <Card title="ルームの設定">
        <div className="flex flex-col gap-4">
          <Select
            label="使用する抽選リスト"
            required
            placeholder="抽選リストを選んでください"
            options={drawOptions}
            value={selectedDrawListId}
            hint={drawKindHint ?? undefined}
            onChange={(event) => {
              setSelectedDrawListId(event.currentTarget.value);
            }}
          />

          <div>
            <Button size="lg" loading={creating} onClick={() => void handleCreate()}>
              ルームを作成する
            </Button>
            <p className="mt-2 text-xs text-slate-600">
              作成した時点のリストの中身をルームへ写し取ります。あとからリストを直しても、
              進行中のルームの中身は変わりません。参加用の二次元コードは発行しません。
            </p>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {createError !== null ? <ErrorMessage error={createError} /> : null}
      {publishIssues.length > 0 ? (
        <PublishIssueList
          issues={publishIssues}
          title={`このクイズではルームを作成できません（${publishIssues.length}件）`}
        />
      ) : null}

      <Card
        title="何を開きますか"
        description="作成したあとはモードを変えられません（作り直しになります）。"
      >
        <RadioGroup
          name="room-mode"
          legend="モード"
          required
          // 作成中に切り替えても送った内容は変わらない。取り違えを生むので触れなくする。
          disabled={creating}
          options={MODE_OPTIONS}
          value={mode}
          onChange={handleModeChange}
        />
      </Card>

      {drawMode === null ? renderQuizSection() : renderDrawSection()}
    </div>
  );
}
