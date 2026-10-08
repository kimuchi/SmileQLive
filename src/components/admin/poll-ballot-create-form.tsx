'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { TextInput } from '@/components/shared/TextInput';
import {
  BALLOT_STRUCTURES,
  BALLOT_STRUCTURE_HINTS,
  BALLOT_STRUCTURE_LABELS,
  type BallotStructure,
} from '@/domain/poll/ballot';
import { apiPost } from '@/lib/client/api-client';
import type { PollBallotDetailResponse } from '@/types/api';

/** 投票用紙の新規作成。作成後はそのまま選択肢の編集画面へ進む。 */

const TITLE_MAX_LENGTH = 120;

const STRUCTURE_OPTIONS = BALLOT_STRUCTURES.map((structure) => ({
  value: structure,
  label: BALLOT_STRUCTURE_LABELS[structure],
  description: BALLOT_STRUCTURE_HINTS[structure],
}));

export function PollBallotCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [structure, setStructure] = useState<BallotStructure>('flat');
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
        setTitleError('投票の名前を入力してください');
        return;
      }
      setTitleError(null);
      setError(null);
      setSubmitting(true);
      try {
        const response = await apiPost<PollBallotDetailResponse>('/api/admin/poll-ballots', {
          title: trimmedTitle,
          structure,
        });
        router.push(`/admin/poll-ballots/${response.ballot.id}/edit`);
      } catch (caught) {
        setError(caught);
        setSubmitting(false);
      }
    },
    [router, structure, submitting, title],
  );

  return (
    <Card title="投票の基本情報">
      <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
        {error !== null ? <ErrorMessage error={error} /> : null}

        <TextInput
          label="投票の名前"
          required
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          error={titleError ?? undefined}
          hint="投影画面の見出しにも使います（例: 出し物コンテスト）。"
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            if (titleError !== null) {
              setTitleError(null);
            }
          }}
        />

        <RadioGroup<BallotStructure>
          name="ballot-structure"
          legend="選び方"
          required
          options={STRUCTURE_OPTIONS}
          value={structure}
          hint="あとから変えられます。2段階にすると、まず区分を選んでから中身を選ぶ形になります。"
          onChange={setStructure}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" loading={submitting}>
            作成して選択肢を編集する
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              router.push('/admin/poll-ballots');
            }}
          >
            一覧へ戻る
          </Button>
        </div>
      </form>
    </Card>
  );
}
