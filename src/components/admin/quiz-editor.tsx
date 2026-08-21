'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge, type BadgeVariant } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { Checkbox } from '@/components/shared/Checkbox';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { SaveStatus } from '@/components/shared/SaveStatus';
import { Spinner } from '@/components/shared/Spinner';
import { TextArea } from '@/components/shared/TextArea';
import { TextInput } from '@/components/shared/TextInput';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { PublishIssueList, parsePublishIssues } from '@/components/admin/publish-issue-list';
import { QuizSharePanel } from '@/components/admin/quiz-share-panel';
import { QuestionCard } from '@/components/admin/question-card';
import { buildDuplicatePayload } from '@/components/admin/question-draft';
import { useAutosave } from '@/components/admin/use-autosave';
import type { PublishIssue } from '@/domain/quiz/publish-validation';
import type { QuestionType } from '@/domain/quiz/question';
import { apiDelete, apiGet, apiPatch, apiPost, isApiClientError } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import type {
  AdminQuestion,
  AdminQuizDetail,
  PublishResponse,
  QuestionResponse,
  QuizDetailResponse,
} from '@/types/api';

/**
 * クイズ編集画面の中枢。
 *
 * - 問題ごとの入力は各カードが自動保存する。
 *   並べ替え・複製・削除・公開の前には、全カードの保存を待ってから実行する。
 * - 画像アップロード中は公開できない（未反映の画像で公開されるのを防ぐ）。
 * - 公開チェックの結果はサーバーの検証結果をそのまま「第N問: …」の形で並べる。
 */

const STATUS_LABEL: Record<AdminQuizDetail['status'], string> = {
  draft: '下書き',
  published: '公開済み',
  archived: 'アーカイブ',
};

const STATUS_VARIANT: Record<AdminQuizDetail['status'], BadgeVariant> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
};

const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 2000;

type SettingsDraft = {
  title: string;
  description: string;
  showLeaderboard: boolean;
  showTotalQuestions: boolean;
  showQuestionBeforeOpen: boolean;
  alwaysShowJoinCode: boolean;
};

type PendingDialog = { kind: 'delete-question'; questionId: string; position: number } | null;

export type QuizEditorProps = {
  quizId: string;
};

export function QuizEditor({ quizId }: QuizEditorProps) {
  const [quiz, setQuiz] = useState<AdminQuizDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [structureBusy, setStructureBusy] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [uploadingIds, setUploadingIds] = useState<readonly string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishIssues, setPublishIssues] = useState<readonly PublishIssue[]>([]);
  const [publishError, setPublishError] = useState<unknown>(null);
  const [publishedNotice, setPublishedNotice] = useState(false);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog>(null);

  const flushMapRef = useRef(new Map<string, () => Promise<void>>());

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<QuizDetailResponse>(`/api/admin/quizzes/${quizId}`);
      setQuiz(response.quiz);
      setSettings(
        (previous) =>
          previous ?? {
            title: response.quiz.title,
            description: response.quiz.description ?? '',
            showLeaderboard: response.quiz.showLeaderboard,
            showTotalQuestions: response.quiz.showTotalQuestions,
            showQuestionBeforeOpen: response.quiz.showQuestionBeforeOpen,
            alwaysShowJoinCode: response.quiz.alwaysShowJoinCode,
          },
      );
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [quizId]);

  useEffect(() => {
    // マウント時（およびクイズ切り替え時）の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  // ---------------------------------------------------------------------
  // クイズ設定の自動保存
  // ---------------------------------------------------------------------

  const saveSettings = useCallback(async () => {
    if (!settings) {
      return;
    }
    const title = settings.title.trim();
    if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
      throw new Error('QUIZ_TITLE_INVALID');
    }
    const response = await apiPatch<QuizDetailResponse>(`/api/admin/quizzes/${quizId}`, {
      title,
      description: settings.description.trim().length > 0 ? settings.description : null,
      showLeaderboard: settings.showLeaderboard,
      showTotalQuestions: settings.showTotalQuestions,
      showQuestionBeforeOpen: settings.showQuestionBeforeOpen,
      alwaysShowJoinCode: settings.alwaysShowJoinCode,
    });
    setQuiz((previous) =>
      previous
        ? {
            ...previous,
            title: response.quiz.title,
            description: response.quiz.description,
            showLeaderboard: response.quiz.showLeaderboard,
            status: response.quiz.status,
            updatedAt: response.quiz.updatedAt,
          }
        : response.quiz,
    );
  }, [quizId, settings]);

  const settingsAutosave = useAutosave(saveSettings);
  const {
    schedule: scheduleSettings,
    flush: flushSettings,
    status: settingsStatus,
    savedAtLabel: settingsSavedAt,
  } = settingsAutosave;

  const patchSettings = useCallback(
    (patch: Partial<SettingsDraft>) => {
      setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
      scheduleSettings();
    },
    [scheduleSettings],
  );

  // ---------------------------------------------------------------------
  // 問題カードとの連携
  // ---------------------------------------------------------------------

  const registerFlush = useCallback((questionId: string, flush: (() => Promise<void>) | null) => {
    if (flush === null) {
      flushMapRef.current.delete(questionId);
      return;
    }
    flushMapRef.current.set(questionId, flush);
  }, []);

  const flushAll = useCallback(async () => {
    await flushSettings();
    await Promise.all([...flushMapRef.current.values()].map((flush) => flush()));
  }, [flushSettings]);

  const handleQuestionSaved = useCallback((question: AdminQuestion) => {
    setQuiz((previous) =>
      previous
        ? {
            ...previous,
            questions: previous.questions.map((item) =>
              item.id === question.id ? question : item,
            ),
          }
        : previous,
    );
  }, []);

  const handleUploadingChange = useCallback((questionId: string, uploading: boolean) => {
    setUploadingIds((previous) => {
      const has = previous.includes(questionId);
      if (uploading && !has) {
        return [...previous, questionId];
      }
      if (!uploading && has) {
        return previous.filter((id) => id !== questionId);
      }
      return previous;
    });
  }, []);

  // ---------------------------------------------------------------------
  // 問題の追加・並べ替え・複製・削除
  // ---------------------------------------------------------------------

  const runStructureAction = useCallback(
    async (action: () => Promise<void>) => {
      setStructureBusy(true);
      setStructureError(null);
      setPublishIssues([]);
      setPublishedNotice(false);
      try {
        await flushAll();
        await action();
      } catch (caught) {
        setStructureError(toUserErrorMessage(caught));
      } finally {
        setStructureBusy(false);
      }
    },
    [flushAll],
  );

  const handleAddQuestion = useCallback(
    (type: QuestionType) => {
      void runStructureAction(async () => {
        const response = await apiPost<QuestionResponse>(`/api/admin/quizzes/${quizId}/questions`, {
          type,
        });
        // 末尾へ足すだけなので、既存カードの下書きは触らない（revision を上げない）。
        setQuiz((previous) =>
          previous
            ? { ...previous, questions: [...previous.questions, response.question] }
            : previous,
        );
      });
    },
    [quizId, runStructureAction],
  );

  const handleMoveQuestion = useCallback(
    (questionId: string, direction: -1 | 1) => {
      void runStructureAction(async () => {
        const current = quiz;
        if (!current) {
          return;
        }
        const ids = current.questions.map((question) => question.id);
        const index = ids.indexOf(questionId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= ids.length) {
          return;
        }
        const moved = ids[index];
        const swapped = ids[target];
        if (moved === undefined || swapped === undefined) {
          return;
        }
        ids[index] = swapped;
        ids[target] = moved;

        const response = await apiPost<QuizDetailResponse>(`/api/admin/quizzes/${quizId}/reorder`, {
          questionIds: ids,
        });
        setQuiz(response.quiz);
        setRevision((value) => value + 1);
      });
    },
    [quiz, quizId, runStructureAction],
  );

  const handleDuplicateQuestion = useCallback(
    (questionId: string) => {
      void runStructureAction(async () => {
        const current = quiz;
        const source = current?.questions.find((question) => question.id === questionId);
        if (!current || !source) {
          return;
        }
        const created = await apiPost<QuestionResponse>(
          `/api/admin/quizzes/${quizId}/questions`,
          buildDuplicatePayload(source),
        );

        // 複製は元の問題のすぐ後ろへ置く。
        const ids: string[] = [];
        for (const question of current.questions) {
          ids.push(question.id);
          if (question.id === questionId) {
            ids.push(created.question.id);
          }
        }
        const response = await apiPost<QuizDetailResponse>(`/api/admin/quizzes/${quizId}/reorder`, {
          questionIds: ids,
        });
        setQuiz(response.quiz);
        setRevision((value) => value + 1);
      });
    },
    [quiz, quizId, runStructureAction],
  );

  const handleDeleteQuestion = useCallback(() => {
    const target = pendingDialog;
    if (target?.kind !== 'delete-question') {
      return;
    }
    void runStructureAction(async () => {
      await apiDelete(`/api/admin/questions/${target.questionId}`);
      // 削除後は position が詰め直されるため、必ず取り直す。
      const response = await apiGet<QuizDetailResponse>(`/api/admin/quizzes/${quizId}`);
      setQuiz(response.quiz);
      setRevision((value) => value + 1);
      setPendingDialog(null);
    });
  }, [pendingDialog, quizId, runStructureAction]);

  // ---------------------------------------------------------------------
  // 公開
  // ---------------------------------------------------------------------

  const uploading = uploadingIds.length > 0;

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setPublishIssues([]);
    setPublishError(null);
    setPublishedNotice(false);
    try {
      await flushAll();
      const response = await apiPost<PublishResponse>(`/api/admin/quizzes/${quizId}/publish`);
      if (response.published) {
        setPublishedNotice(true);
        const latest = await apiGet<QuizDetailResponse>(`/api/admin/quizzes/${quizId}`);
        setQuiz(latest.quiz);
      } else {
        setPublishIssues(response.issues);
      }
    } catch (caught) {
      if (isApiClientError(caught) && caught.code === 'QUIZ_PUBLISH_VALIDATION_FAILED') {
        setPublishIssues(parsePublishIssues(caught.details));
      } else {
        setPublishError(caught);
      }
    } finally {
      setPublishing(false);
    }
  }, [flushAll, quizId]);

  const questionSummary = useMemo(() => {
    if (!quiz) {
      return { total: 0, choice: 0, number: 0 };
    }
    return {
      total: quiz.questions.length,
      choice: quiz.questions.filter((question) => question.type === 'choice').length,
      number: quiz.questions.filter((question) => question.type === 'number').length,
    };
  }, [quiz]);

  if (quiz === null || settings === null) {
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

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-30 -mx-4 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[quiz.status]} size="md">
              {STATUS_LABEL[quiz.status]}
            </Badge>
            <span className="text-sm text-slate-600">
              全{questionSummary.total}問（選択式 {questionSummary.choice}問 / 数値式{' '}
              {questionSummary.number}問）
            </span>
            <SaveStatus status={settingsStatus} savedAtLabel={settingsSavedAt} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {quiz.status === 'published' ? (
              <Link
                href={`/admin/rooms/new?quizId=${quiz.id}`}
                className="border-brand-300 text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-600 inline-flex min-h-11 items-center rounded-xl border bg-white px-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                ルームを作成
              </Link>
            ) : null}
            <Button
              size="md"
              loading={publishing}
              disabled={structureBusy || uploading}
              title={uploading ? '画像のアップロードが終わるまで公開できません' : undefined}
              onClick={() => void handlePublish()}
            >
              {quiz.status === 'published' ? '公開内容を更新' : '公開する'}
            </Button>
          </div>
        </div>
        {uploading ? (
          <p className="mt-2 text-xs font-bold text-slate-600">
            画像をアップロードしています。完了するまで公開できません。
          </p>
        ) : null}
      </div>

      {quiz !== null && quiz.owned === false ? (
        // 共有されたクイズ。サーバー側でも更新は所有者に限られている。
        <Alert variant="info" title="共有されたクイズです">
          内容の確認とルーム作成ができます。編集・公開・削除は所有者だけが行えます。
        </Alert>
      ) : null}

      {publishedNotice ? (
        <Alert variant="success" title="公開しました">
          このクイズからルームを作成できます。
        </Alert>
      ) : null}
      {publishError !== null ? <ErrorMessage error={publishError} /> : null}
      <PublishIssueList issues={publishIssues} />
      {structureError !== null ? <Alert variant="error">{structureError}</Alert> : null}
      {loadError !== null ? <ErrorMessage error={loadError} onRetry={() => void load()} /> : null}

      <QuizSharePanel quizId={quizId} owned={quiz?.owned !== false} />

      <Card title="クイズの設定">
        <div className="flex flex-col gap-4">
          <TextInput
            label="クイズタイトル"
            required
            maxLength={TITLE_MAX_LENGTH}
            value={settings.title}
            error={settings.title.trim().length === 0 ? 'タイトルを入力してください' : undefined}
            onChange={(event) => {
              patchSettings({ title: event.currentTarget.value });
            }}
          />
          <TextArea
            label="説明（任意・運営メモ）"
            rows={2}
            maxLength={DESCRIPTION_MAX_LENGTH}
            showCounter
            value={settings.description}
            onChange={(event) => {
              patchSettings({ description: event.currentTarget.value });
            }}
          />
          <Checkbox
            label="ランキングを表示する"
            checked={settings.showLeaderboard}
            hint="オフにすると、参加者・投影画面へ順位表を出しません。"
            onChange={(event) => {
              patchSettings({ showLeaderboard: event.currentTarget.checked });
            }}
          />

          <Checkbox
            label="全問数を表示する"
            checked={settings.showTotalQuestions}
            hint="オンで「第3問 / 全6問」、オフで「第3問」とだけ表示します。"
            onChange={(event) => {
              patchSettings({ showTotalQuestions: event.currentTarget.checked });
            }}
          />

          <Checkbox
            label="回答受付を始める前に問題を見せる"
            checked={settings.showQuestionBeforeOpen}
            hint="オフ（既定）だと「まもなく出題」だけを出し、受付開始と同時に問題を表示します。"
            onChange={(event) => {
              patchSettings({ showQuestionBeforeOpen: event.currentTarget.checked });
            }}
          />

          <Checkbox
            label="参加用の二次元コードをずっと表示する"
            checked={settings.alwaysShowJoinCode}
            hint="オンにすると、投影画面の隅に参加用の二次元コードを出し続けます。途中から来た人がその場で参加できます（受付を締め切っている間は出ません）。"
            onChange={(event) => {
              patchSettings({ alwaysShowJoinCode: event.currentTarget.checked });
            }}
          />
        </div>
      </Card>

      {quiz.questions.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-700">
            まだ問題がありません。下のボタンから最初の問題を追加してください。
          </p>
        </Card>
      ) : (
        quiz.questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            quizId={quiz.id}
            question={question}
            revision={revision}
            index={index}
            totalQuestions={quiz.questions.length}
            busy={structureBusy}
            onSaved={handleQuestionSaved}
            onRegisterFlush={registerFlush}
            onUploadingChange={handleUploadingChange}
            onMove={handleMoveQuestion}
            onDuplicate={handleDuplicateQuestion}
            onDelete={(questionId) => {
              setPendingDialog({
                kind: 'delete-question',
                questionId,
                position: question.position,
              });
            }}
          />
        ))
      )}

      <Card title="問題を追加">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={structureBusy}
            onClick={() => {
              handleAddQuestion('choice');
            }}
          >
            選択式の問題を追加
          </Button>
          <Button
            variant="secondary"
            loading={structureBusy}
            onClick={() => {
              handleAddQuestion('number');
            }}
          >
            数値式の問題を追加
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={pendingDialog?.kind === 'delete-question'}
        title="この問題を削除しますか？"
        description={
          <>
            <p>第{pendingDialog?.position ?? 0}問を削除します。元に戻せません。</p>
            <p className="mt-2">削除すると、後ろの問題の番号が繰り上がります。</p>
          </>
        }
        confirmLabel="削除する"
        busy={structureBusy}
        onConfirm={handleDeleteQuestion}
        onCancel={() => {
          setPendingDialog(null);
        }}
      />
    </div>
  );
}
