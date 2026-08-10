'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { TextArea } from '@/components/shared/TextArea';
import { TextInput } from '@/components/shared/TextInput';
import { apiPost } from '@/lib/client/api-client';
import type { QuizDetailResponse } from '@/types/api';

/** クイズの新規作成。作成後はそのまま問題編集画面へ進む。 */

const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 2000;

export function QuizCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      const trimmedTitle = title.trim();
      if (trimmedTitle.length === 0) {
        setTitleError('クイズタイトルを入力してください');
        return;
      }
      setTitleError(null);
      setError(null);
      setSubmitting(true);
      try {
        const response = await apiPost<QuizDetailResponse>('/api/admin/quizzes', {
          title: trimmedTitle,
          description: description.trim().length > 0 ? description : null,
        });
        router.push(`/admin/quizzes/${response.quiz.id}/edit`);
      } catch (caught) {
        setError(caught);
        setSubmitting(false);
      }
    },
    [description, router, submitting, title],
  );

  return (
    <Card title="クイズの基本情報">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {error !== null ? <ErrorMessage error={error} /> : null}

        <TextInput
          label="クイズタイトル"
          required
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          error={titleError ?? undefined}
          hint="投影画面・参加者画面に表示されます。"
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            if (titleError !== null) {
              setTitleError(null);
            }
          }}
        />

        <TextArea
          label="説明（任意）"
          rows={3}
          maxLength={DESCRIPTION_MAX_LENGTH}
          showCounter
          value={description}
          hint="運営メモとして使えます。参加者へは表示されません。"
          onChange={(event) => {
            setDescription(event.currentTarget.value);
          }}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" loading={submitting}>
            作成して問題を編集する
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              router.push('/admin/quizzes');
            }}
          >
            一覧へ戻る
          </Button>
        </div>
      </form>
    </Card>
  );
}
