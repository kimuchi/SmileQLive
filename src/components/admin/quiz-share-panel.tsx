'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { apiGet, apiPut } from '@/lib/client/api-client';
import type { QuizShareResponse, QuizShareTarget } from '@/types/api';

/**
 * クイズの共有設定。
 *
 * 守ること:
 * - 共有できるのは**所有者だけ**（サーバー側でも requireQuizOwner で担保）。
 * - 共有相手は**司会者として登録済み**の利用者に限る。
 *   未登録の相手へ共有しても管理画面へ入れないため、サーバーが弾く。
 * - 共有された側にできるのは「内容を見る」と「ルーム作成」まで。
 *   編集・削除・公開・共有設定はできない。画面上でもそう明記する。
 */

export type QuizSharePanelProps = {
  quizId: string;
  /** 所有者でなければ設定させない（表示もしない）。 */
  owned: boolean;
};

function label(target: QuizShareTarget): string {
  return target.email ?? target.displayName ?? target.uid;
}

export function QuizSharePanel({ quizId, owned }: QuizSharePanelProps) {
  const [shares, setShares] = useState<QuizShareTarget[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await apiGet<QuizShareResponse>(`/api/admin/quizzes/${quizId}/share`);
      setShares(response.shares);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [quizId]);

  useEffect(() => {
    if (!owned) {
      return;
    }
    // マウント時の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load, owned]);

  /** 一覧をそのまま置き換える API なので、変更後の全体を送る。 */
  const save = useCallback(
    async (next: QuizShareTarget[]) => {
      setSaveError(null);
      setSaving(true);
      try {
        const response = await apiPut<QuizShareResponse>(`/api/admin/quizzes/${quizId}/share`, {
          emails: next.map((target) => target.email).filter((value): value is string => value !== null),
        });
        setShares(response.shares);
        return true;
      } catch (caught) {
        setSaveError(caught);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [quizId],
  );

  const handleAdd = useCallback(async () => {
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length === 0 || shares === null) {
      return;
    }
    if (shares.some((target) => target.email === trimmed)) {
      setEmail('');
      return;
    }
    // 追加分は uid が未確定。サーバーが解決して正式な一覧を返す。
    const ok = await save([...shares, { uid: '', email: trimmed, displayName: null }]);
    if (ok) {
      setEmail('');
    }
  }, [email, save, shares]);

  const handleRemove = useCallback(
    async (target: QuizShareTarget) => {
      if (shares === null) {
        return;
      }
      await save(shares.filter((entry) => entry.uid !== target.uid));
    },
    [save, shares],
  );

  if (!owned) {
    return null;
  }

  return (
    <Card
      title="ほかの司会者と共有"
      description="共有された相手は内容を見てルームを作成できます。編集・削除・公開はできません。"
    >
      <div className="flex flex-col gap-4">
        {loadError !== null ? <ErrorMessage error={loadError} onRetry={() => void load()} /> : null}
        {saveError !== null ? <ErrorMessage error={saveError} /> : null}

        {shares === null && loadError === null ? (
          <Spinner label="読み込んでいます" />
        ) : (
          <>
            {shares !== null && shares.length === 0 ? (
              <p className="text-sm text-slate-600">まだ誰にも共有していません。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(shares ?? []).map((target) => (
                  <li
                    key={target.uid || label(target)}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">
                      {label(target)}
                      {target.displayName !== null && target.email !== null ? (
                        <span className="ml-2 text-xs text-slate-500">{target.displayName}</span>
                      ) : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => void handleRemove(target)}
                    >
                      解除
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <TextInput
                  label="共有する相手のメールアドレス"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="host@example.com"
                />
              </div>
              <Button
                variant="secondary"
                loading={saving}
                disabled={email.trim().length === 0}
                onClick={() => void handleAdd()}
              >
                共有する
              </Button>
            </div>

            <Alert variant="info" title="相手は先に司会者登録が必要です">
              登録されていないアドレスへは共有できません。運営管理者に
              <span className="font-mono"> npm run host:add </span>
              での登録を依頼してください。
            </Alert>
          </>
        )}
      </div>
    </Card>
  );
}
