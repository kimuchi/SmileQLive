'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { TextInput } from '@/components/shared/TextInput';
import { useEnsureAnonymousSession } from '@/hooks/use-anonymous-session';
import { ApiClientError, apiGet, apiPost } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import type { JoinRegisterResponse, JoinResolveResponse } from '@/types/api';

/**
 * 二次元コードから直行した参加者のロビー画面。
 *
 * 守ること:
 * - ルームコードの入力欄を作らない。参加は QR の URL 直行のみ。
 * - 参加トークンは props で受け取り、API のパスにしか使わない。画面へ出さない。
 * - 登録に成功したら replace 遷移で URL からトークンを取り除く。
 * - 音・振動を一切扱わない。
 */

const NICKNAME_MAX_LENGTH = 20;

const INVALID_LINK_TITLE = '参加できませんでした';
/** 会場での案内文はひとつの文として出す（読み上げでも分断されないようにする）。 */
const INVALID_LINK_DESCRIPTION =
  'この参加URLは無効または期限切れです。司会者に新しい二次元コードを確認してください';

/** 参加できない理由の表示（受付終了・満員など）。 */
type BlockedNotice = { title: string; description: string };

const BLOCKED_NOTICES: Record<string, BlockedNotice> = {
  ROOM_FULL: {
    title: '参加人数が上限に達しました',
    description: '恐れ入りますが、会場スタッフへお知らせください',
  },
  JOIN_CLOSED: {
    title: 'このクイズは参加受付を終了しています',
    description: 'すでにクイズが始まっている可能性があります。会場スタッフへお知らせください',
  },
  ROOM_FINISHED: {
    title: 'このクイズはすでに終了しています',
    description: 'ご参加ありがとうございました',
  },
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'redirecting' }
  | { kind: 'invalid' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'ready'; info: JoinResolveResponse };

/** 参加 URL そのものが使えないエラーか。 */
function isInvalidLinkError(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.code === 'JOIN_LINK_INVALID' || error.code === 'JOIN_LINK_REVOKED')
  );
}

/** 409 NICKNAME_TAKEN の details から候補名を安全に取り出す。 */
function readSuggestedNickname(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const value = (details as { suggestedNickname?: unknown }).suggestedNickname;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 入力されたニックネームを送信前にそろえる（全角空白の除去・NFKC 正規化）。 */
function normalizeNickname(value: string): string {
  return value.normalize('NFKC').trim();
}

export function JoinScreen({ joinToken }: { joinToken: string }) {
  const router = useRouter();
  const ensureAnonymousSession = useEnsureAnonymousSession();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const [nickname, setNickname] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [suggestedNickname, setSuggestedNickname] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<BlockedNotice | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  // 購読し直さずに最新の関数を使うための参照。
  const ensureSessionRef = useRef(ensureAnonymousSession);
  useEffect(() => {
    ensureSessionRef.current = ensureAnonymousSession;
  }, [ensureAnonymousSession]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // 参加者にログインは求めない。
      // Firestore の購読（Security Rules）とサーバー API の認可のため、
      // 匿名認証 → セッションクッキーだけを用意する。
      //
      // 認証と参加URLの確認は**並行して**行う。
      // resolve は認証を必要としないため、認証を待ってから確認すると
      // 会場で回線が遅いときに待ち時間が二重に積み上がり、
      // 「このURLは無効」ということすら伝えられないまま画面が止まる。
      // 認証が要るのは参加登録の時点で、そこで改めてセッションを確保する。
      const sessionPromise = ensureSessionRef.current();
      void sessionPromise.catch(() => false);
      try {
        const info = await apiGet<JoinResolveResponse>(
          `/api/join/${encodeURIComponent(joinToken)}/resolve`,
        );
        if (cancelled) {
          return;
        }
        if (info.alreadyJoinedNickname !== null) {
          // 再訪・再読込。同じ参加者として進行画面へ戻す（URL からトークンを外す）。
          setState({ kind: 'redirecting' });
          router.replace(`/play/${info.roomId}`);
          return;
        }
        setState({ kind: 'ready', info });
      } catch (caught) {
        if (cancelled) {
          return;
        }
        setState(
          isInvalidLinkError(caught) ? { kind: 'invalid' } : { kind: 'failed', error: caught },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [joinToken, router, reloadKey]);

  const handleReload = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadKey((previous) => previous + 1);
  }, []);

  const handleRegisterError = useCallback((error: unknown) => {
    if (isInvalidLinkError(error)) {
      setState({ kind: 'invalid' });
      return;
    }

    if (error instanceof ApiClientError) {
      if (error.code === 'NICKNAME_TAKEN') {
        setNicknameError('同じ名前がすでに使われています。別の名前にしてください');
        setSuggestedNickname(readSuggestedNickname(error.details));
        return;
      }
      if (error.code === 'NICKNAME_INVALID') {
        setNicknameError('ニックネームは1〜20文字で入力してください');
        return;
      }
      const notice = BLOCKED_NOTICES[error.code];
      if (notice) {
        setBlocked(notice);
        return;
      }
    }

    setSubmitError(error);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      const normalized = normalizeNickname(nickname);
      if (normalized.length === 0) {
        setNicknameError('ニックネームを入力してください');
        return;
      }
      if (normalized.length > NICKNAME_MAX_LENGTH) {
        setNicknameError('ニックネームは20文字以内で入力してください');
        return;
      }

      setNicknameError(null);
      setSuggestedNickname(null);
      setSubmitError(null);
      setSubmitting(true);

      try {
        // Cookie に匿名セッションが無い場合に備えて、送信直前にもう一度確認する。
        await ensureSessionRef.current();
        const registered = await apiPost<JoinRegisterResponse>(
          `/api/join/${encodeURIComponent(joinToken)}/register`,
          { nickname: normalized },
        );
        // 成功。URL から参加トークンを消すため replace で遷移する（戻る操作でも復帰しない）。
        setState({ kind: 'redirecting' });
        router.replace(`/play/${registered.roomId}`);
      } catch (caught) {
        setSubmitting(false);
        handleRegisterError(caught);
      }
    },
    [handleRegisterError, joinToken, nickname, router, submitting],
  );

  if (state.kind === 'loading') {
    return <FullScreenMessage title="読み込んでいます" loading tone="info" />;
  }

  if (state.kind === 'redirecting') {
    return <FullScreenMessage title="クイズ画面へ移動しています" loading tone="info" />;
  }

  if (state.kind === 'invalid') {
    return (
      <FullScreenMessage
        title={INVALID_LINK_TITLE}
        description={INVALID_LINK_DESCRIPTION}
        tone="error"
      />
    );
  }

  if (state.kind === 'failed') {
    return (
      <FullScreenMessage
        title="読み込めませんでした"
        description="電波状況を確認して、もう一度お試しください"
        tone="error"
        actions={
          <Button variant="secondary" size="lg" onClick={handleReload}>
            もう一度試す
          </Button>
        }
      />
    );
  }

  const { info } = state;
  const isFull = info.participantCount >= info.maxParticipants;
  const notice =
    blocked ??
    (!info.joinOpen
      ? BLOCKED_NOTICES.JOIN_CLOSED
      : isFull
        ? BLOCKED_NOTICES.ROOM_FULL
        : undefined) ??
    null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
      <header className="text-center">
        <p className="text-brand-700 text-sm font-bold tracking-wide">SmileQ Live</p>
        <h1 className="mt-1 text-2xl leading-snug font-bold text-slate-900">{info.quizTitle}</h1>
      </header>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <Badge variant={info.joinOpen && !isFull ? 'success' : 'warning'} size="md">
            {info.joinOpen && !isFull ? '参加を受け付けています' : '参加受付は終了しました'}
          </Badge>
          <span className="text-sm text-slate-600">
            {formatCount(info.participantCount)}が参加中
          </span>
        </div>

        {notice ? (
          <Alert variant="warning" title={notice.title} className="mt-4">
            {notice.description}
          </Alert>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4" noValidate>
            <TextInput
              label="ニックネーム"
              required
              value={nickname}
              onChange={(event) => {
                setNickname(event.target.value);
                setNicknameError(null);
              }}
              maxLength={NICKNAME_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="例: たろう"
              hint="1〜20文字。ランキングに表示されます"
              error={nicknameError ?? undefined}
              disabled={submitting}
            />

            {suggestedNickname ? (
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => {
                  setNickname(suggestedNickname);
                  setNicknameError(null);
                  setSuggestedNickname(null);
                }}
              >
                「{suggestedNickname}」で参加する
              </Button>
            ) : null}

            {submitError !== null ? <ErrorMessage error={submitError} /> : null}

            <Button type="submit" size="lg" fullWidth loading={submitting}>
              参加する
            </Button>
          </form>
        )}
      </Card>

      <p className="text-center text-xs leading-relaxed text-slate-500">
        この画面の URL は、あなた専用の参加リンクです。
        <br />
        ほかの人へ共有しないでください。
      </p>
    </main>
  );
}
