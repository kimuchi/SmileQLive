'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { SaveStatus } from '@/components/shared/SaveStatus';
import { Select } from '@/components/shared/Select';
import { TextArea } from '@/components/shared/TextArea';
import { TextInput } from '@/components/shared/TextInput';
import { ChoiceEditor } from '@/components/admin/choice-editor';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ImageField } from '@/components/admin/image-field';
import { NumberRuleEditor } from '@/components/admin/number-rule-editor';
import {
  EXPLANATION_TEXT_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  buildQuestionPayload,
  buildTypeSwitchPayload,
  toQuestionDraft,
  type ChoiceDraft,
  type QuestionDraft,
  type QuestionDraftErrors,
} from '@/components/admin/question-draft';
import { useAutosave } from '@/components/admin/use-autosave';
import {
  TIME_LIMIT_MAX_SECONDS,
  TIME_LIMIT_MIN_SECONDS,
  POINTS_MAX,
  POINTS_MIN,
  type QuestionType,
} from '@/domain/quiz/question';
import { apiDelete, apiPatch, apiPost } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import type { AdminMediaRef, AdminQuestion, QuestionResponse } from '@/types/api';

/**
 * 1 問分の編集カード。
 *
 * - 入力は下書き（文字列）で保持し、800ms の debounce で自動保存する。
 * - 保存に失敗しても入力は消さない。SaveStatus と項目別エラーで理由を伝える。
 * - 選択肢の追加・削除はサーバー側で position を詰め直すため、
 *   先に下書きを確定保存してから実行し、応答で下書きを作り直す。
 */

/** 検証で止めたことを示す内部例外（利用者向けの文言は項目別に出す）。 */
class DraftValidationError extends Error {
  constructor() {
    super('DRAFT_VALIDATION');
    this.name = 'DraftValidationError';
  }
}

const TYPE_OPTIONS = [
  { value: 'choice', label: '選択式（選択肢から選ぶ）' },
  { value: 'number', label: '数値式（数値を入力する）' },
] as const;

export type QuestionCardProps = {
  quizId: string;
  question: AdminQuestion;
  /** 値が変わると下書きをサーバーの内容で作り直す。 */
  revision: number;
  index: number;
  totalQuestions: number;
  disabled?: boolean;
  busy?: boolean;
  onSaved: (question: AdminQuestion) => void;
  onRegisterFlush: (questionId: string, flush: (() => Promise<void>) | null) => void;
  onUploadingChange: (questionId: string, uploading: boolean) => void;
  onMove: (questionId: string, direction: -1 | 1) => void;
  onDuplicate: (questionId: string) => void;
  onDelete: (questionId: string) => void;
};

export function QuestionCard({
  quizId,
  question,
  revision,
  index,
  totalQuestions,
  disabled = false,
  busy = false,
  onSaved,
  onRegisterFlush,
  onUploadingChange,
  onMove,
  onDuplicate,
  onDelete,
}: QuestionCardProps) {
  const [draft, setDraft] = useState<QuestionDraft>(() => toQuestionDraft(question));
  const [errors, setErrors] = useState<QuestionDraftErrors>({});
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingType, setPendingType] = useState<QuestionType | null>(null);
  const [switchingType, setSwitchingType] = useState(false);

  // 並べ替え・複製などでサーバー側の内容が変わったら、下書きを作り直す。
  // effect ではなくレンダー中に調整して、古い内容が 1 フレーム見えるのを防ぐ。
  const [lastRevision, setLastRevision] = useState(revision);
  if (lastRevision !== revision) {
    setLastRevision(revision);
    setDraft(toQuestionDraft(question));
    setErrors({});
    setActionError(null);
  }

  /** 下書きを検証して保存する。検証に落ちたら null を返し、保存しない。 */
  const persistDraft = useCallback(async (): Promise<AdminQuestion | null> => {
    const built = buildQuestionPayload(draft);
    if (!built.ok) {
      setErrors(built.errors);
      return null;
    }
    setErrors({});
    const response = await apiPatch<QuestionResponse>(
      `/api/admin/questions/${question.id}`,
      built.payload,
    );
    onSaved(response.question);
    return response.question;
  }, [draft, onSaved, question.id]);

  const save = useCallback(async () => {
    const saved = await persistDraft();
    if (!saved) {
      throw new DraftValidationError();
    }
  }, [persistDraft]);

  const autosave = useAutosave(save);
  const { schedule, flush, cancel, status, savedAtLabel, error: autosaveError } = autosave;

  // 親（公開・並べ替え）が保存の完了を待てるように flush を登録する。
  useEffect(() => {
    onRegisterFlush(question.id, flush);
    return () => {
      onRegisterFlush(question.id, null);
    };
  }, [flush, onRegisterFlush, question.id]);

  const patchDraft = useCallback(
    (patch: Partial<QuestionDraft>) => {
      setDraft((previous) => ({ ...previous, ...patch }));
      schedule();
    },
    [schedule],
  );

  const handleChoicesChange = useCallback(
    (choices: ChoiceDraft[]) => {
      patchDraft({ choices });
    },
    [patchDraft],
  );

  const handleAddChoice = useCallback(async () => {
    cancel();
    setActionError(null);
    setChoiceBusy(true);
    try {
      const saved = await persistDraft();
      if (!saved) {
        setActionError('入力内容を確認してから選択肢を追加してください');
        return;
      }
      const response = await apiPost<QuestionResponse>(
        `/api/admin/questions/${question.id}/choices`,
      );
      setDraft(toQuestionDraft(response.question));
      onSaved(response.question);
    } catch (caught) {
      setActionError(toUserErrorMessage(caught));
    } finally {
      setChoiceBusy(false);
    }
  }, [cancel, onSaved, persistDraft, question.id]);

  const handleDeleteChoice = useCallback(
    async (choiceId: string) => {
      cancel();
      setActionError(null);
      setChoiceBusy(true);
      try {
        const saved = await persistDraft();
        if (!saved) {
          setActionError('入力内容を確認してから選択肢を削除してください');
          return;
        }
        const response = await apiDelete<QuestionResponse>(`/api/admin/choices/${choiceId}`);
        setDraft(toQuestionDraft(response.question));
        onSaved(response.question);
      } catch (caught) {
        setActionError(toUserErrorMessage(caught));
      } finally {
        setChoiceBusy(false);
      }
    },
    [cancel, onSaved, persistDraft],
  );

  const handleTypeSwitch = useCallback(async () => {
    if (pendingType === null) {
      return;
    }
    cancel();
    setActionError(null);
    setSwitchingType(true);
    try {
      const response = await apiPatch<QuestionResponse>(
        `/api/admin/questions/${question.id}`,
        buildTypeSwitchPayload(draft, pendingType),
      );
      setDraft(toQuestionDraft(response.question));
      setErrors({});
      onSaved(response.question);
      setPendingType(null);
    } catch (caught) {
      setActionError(toUserErrorMessage(caught));
    } finally {
      setSwitchingType(false);
    }
  }, [cancel, draft, onSaved, pendingType, question.id]);

  const handleUploadingChange = useCallback(
    (uploading: boolean) => {
      onUploadingChange(question.id, uploading);
    },
    [onUploadingChange, question.id],
  );

  const locked = disabled || busy || switchingType;
  const showGenericSaveError =
    autosaveError !== null &&
    autosaveError !== undefined &&
    !(autosaveError instanceof DraftValidationError);

  return (
    <Card
      className="scroll-mt-24"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="brand" size="md">
            第{question.position}問
          </Badge>
          <span className="text-slate-500">{draft.type === 'choice' ? '選択式' : '数値式'}</span>
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <SaveStatus status={status} savedAtLabel={savedAtLabel} />
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || index === 0}
            aria-label={`第${question.position}問を上へ移動`}
            onClick={() => {
              onMove(question.id, -1);
            }}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || index === totalQuestions - 1}
            aria-label={`第${question.position}問を下へ移動`}
            onClick={() => {
              onMove(question.id, 1);
            }}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              onDuplicate(question.id);
            }}
          >
            複製
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              onDelete(question.id);
            }}
          >
            削除
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {showGenericSaveError ? (
          <ErrorMessage error={autosaveError} onRetry={() => void flush()} />
        ) : null}
        {status === 'error' && !showGenericSaveError ? (
          <Alert variant="warning" title="保存していません">
            未入力または不正な項目があります。赤い説明の項目を直すと自動で保存されます。
          </Alert>
        ) : null}
        {actionError !== null ? <Alert variant="error">{actionError}</Alert> : null}

        <Select
          label="回答形式"
          value={draft.type}
          options={TYPE_OPTIONS}
          disabled={locked}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value !== 'choice' && value !== 'number') {
              return;
            }
            if (value === draft.type) {
              return;
            }
            setPendingType(value);
          }}
        />

        <TextArea
          label="問題文"
          rows={3}
          maxLength={QUESTION_TEXT_MAX_LENGTH}
          showCounter
          value={draft.text}
          disabled={locked}
          hint="問題文か問題画像のどちらかは必ず必要です。"
          onChange={(event) => {
            patchDraft({ text: event.currentTarget.value });
          }}
        />

        <ImageField
          label="問題画像（任意）"
          quizId={quizId}
          usage="question"
          image={draft.image}
          alt={draft.imageAlt}
          disabled={locked}
          onImageChange={(image: AdminMediaRef | null) => {
            patchDraft({ image, ...(image === null ? { imageAlt: '' } : {}) });
          }}
          onAltChange={(value) => {
            patchDraft({ imageAlt: value });
          }}
          onUploadingChange={handleUploadingChange}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="制限時間（秒）"
            inputMode="numeric"
            autoComplete="off"
            value={draft.timeLimitSeconds}
            disabled={locked}
            error={errors.timeLimitSeconds ?? undefined}
            hint={`${TIME_LIMIT_MIN_SECONDS}〜${TIME_LIMIT_MAX_SECONDS}秒`}
            onChange={(event) => {
              patchDraft({ timeLimitSeconds: event.currentTarget.value });
            }}
          />
          <TextInput
            label="配点"
            inputMode="numeric"
            autoComplete="off"
            value={draft.points}
            disabled={locked}
            error={errors.points ?? undefined}
            hint={`${POINTS_MIN}〜${POINTS_MAX}。正解でこの点数が入ります。`}
            onChange={(event) => {
              patchDraft({ points: event.currentTarget.value });
            }}
          />
        </div>

        {draft.type === 'choice' ? (
          <ChoiceEditor
            quizId={quizId}
            questionId={question.id}
            choices={draft.choices}
            disabled={locked}
            busy={choiceBusy}
            error={errors.choices ?? undefined}
            onChoicesChange={handleChoicesChange}
            onAddChoice={() => void handleAddChoice()}
            onDeleteChoice={(choiceId) => void handleDeleteChoice(choiceId)}
            onUploadingChange={handleUploadingChange}
          />
        ) : (
          <NumberRuleEditor draft={draft} errors={errors} disabled={locked} onPatch={patchDraft} />
        )}

        <hr className="border-slate-100" />

        <TextArea
          label="解説（任意）"
          rows={3}
          maxLength={EXPLANATION_TEXT_MAX_LENGTH}
          showCounter
          value={draft.explanation}
          disabled={locked}
          hint="正解発表のときだけ表示されます。参加者には正解発表前に届きません。"
          onChange={(event) => {
            patchDraft({ explanation: event.currentTarget.value });
          }}
        />

        <ImageField
          label="正解・解説画像（任意）"
          quizId={quizId}
          usage="reveal"
          image={draft.revealImage}
          alt={draft.revealImageAlt}
          disabled={locked}
          hint="正解発表のときだけ表示されます。JPEG・PNG・WebP、8MB以下。"
          onImageChange={(image: AdminMediaRef | null) => {
            patchDraft({ revealImage: image, ...(image === null ? { revealImageAlt: '' } : {}) });
          }}
          onAltChange={(value) => {
            patchDraft({ revealImageAlt: value });
          }}
          onUploadingChange={handleUploadingChange}
        />
      </div>

      <ConfirmDialog
        open={pendingType !== null}
        title="回答形式を変更しますか？"
        description={
          pendingType === 'number' ? (
            <>
              <p>選択式から数値式へ変更すると、この問題の選択肢はすべて削除されます。</p>
              <p className="mt-2">
                変更後、判定方法と正解値を入力してください（暫定値 0 が入ります）。
              </p>
            </>
          ) : (
            <>
              <p>
                数値式から選択式へ変更すると、正解値・許容誤差・範囲・単位などの数値条件は削除されます。
              </p>
              <p className="mt-2">選択肢は初期状態（2件）で作り直されます。</p>
            </>
          )
        }
        confirmLabel="変更する"
        busy={switchingType}
        onConfirm={() => void handleTypeSwitch()}
        onCancel={() => {
          setPendingType(null);
        }}
      />
    </Card>
  );
}
