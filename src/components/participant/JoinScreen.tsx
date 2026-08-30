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
import { isPollMode, ROOM_MODE_LABELS, type RoomMode } from '@/domain/room/room-mode';
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
 *
 * **投票のルームでは名前を聞かない。** 読み込んだらその場で参加登録し、
 * 投票画面まで送る。会場で 200 人にニックネームを打たせると、
 * 打ち終わるまでの数十秒がまるごと待ち時間になるうえ、
 * 投票では名前をどこにも出さない（順位表が無い）ので聞く意味がない。
 * 表示名はサーバーが割り当てる。
 */

const NICKNAME_MAX_LENGTH = 20;

const INVALID_LINK_TITLE = '参加できませんでした';
/** 会場での案内文はひとつの文として出す（読み上げでも分断されないようにする）。 */
const INVALID_LINK_DESCRIPTION =
  'この参加URLは無効または期限切れです。司会者に新しい二次元コードを確認してください';

/** 参加できない理由の表示（受付終了・満員など）。 */
type BlockedNotice = { title: string; description: string };

/** 参加を諦めてもらう必要があるエラー。文言はモードで変わるので、コードだけ覚える。 */
const BLOCKED_CODES = ['ROOM_FULL', 'JOIN_CLOSED', 'ROOM_FINISHED'];

/**
 * 参加できない理由の文言。
 *
 * 「このクイズは終了しています」と投票の参加者へ出すと、
 * 別の催しの二次元コードを読んだのかと思わせてしまう。モードの呼び名を使う。
 */
function blockedNotices(mode: RoomMode): Record<string, BlockedNotice> {
  const label = ROOM_MODE_LABELS[mode];
  return {
    ROOM_FULL: {
      title: '参加人数が上限に達しました',
      description: '恐れ入りますが、会場スタッフへお知らせください',
    },
    JOIN_CLOSED: {
      title: `この${label}は参加受付を終了しています`,
      description: `すでに${label}が始まっている可能性があります。会場スタッフへお知らせください`,
    },
    ROOM_FINISHED: {
      title: `この${label}はすでに終了しています`,
      description: 'ご参加ありがとうございました',
    },
  };
}

/** 遷移先の呼び名。 */
function playScreenLabel(mode: RoomMode): string {
  return isPollMode(mode) ? '投票画面' : 'クイズ画面';
}

type LoadState =
  | { kind: 'loading' }
  /** 名前を聞かないルームで、読み込んだ流れのまま参加登録している最中。 */
  | { kind: 'joining'; mode: RoomMode }
  | { kind: 'redirecting'; mode: RoomMode }
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

/** いま参加を受け付けているか（受付終了・満員でないか）。 */
function acceptingNow(info: JoinResolveResponse): boolean {
  return info.joinOpen && info.participantCount < info.maxParticipants;
}

export function JoinScreen({ joinToken }: { joinToken: string }) {
  const router = useRouter();
  const ensureAnonymousSession = useEnsureAnonymousSession();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const [nickname, setNickname] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [suggestedNickname, setSuggestedNickname] = useState<string | null>(null);
  const [blockedCode, setBlockedCode] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * 名前を聞かない参加登録を、もう始めたか。
   *
   * 下の副作用は**書き込みを伴う**。読み込みだけなら二度走っても困らないが、
   * 参加登録は送るたびにレート制限を食う。親の再描画などで副作用が
   * もう一度走っても送り直さないよう、開始したことをここに残す。
   * 戻すのは「もう一度試す」を押したときだけ。
   */
  const autoJoinStartedRef = useRef(false);

  // 購読し直さずに最新の関数を使うための参照。
  const ensureSessionRef = useRef(ensureAnonymousSession);
  useEffect(() => {
    ensureSessionRef.current = ensureAnonymousSession;
  }, [ensureAnonymousSession]);

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
      if (BLOCKED_CODES.includes(error.code)) {
        setBlockedCode(error.code);
        return;
      }
    }

    setSubmitError(error);
  }, []);

  /**
   * 名前を聞かずに参加する（投票）。
   *
   * 失敗しても入り口は残す。電波が悪くて一度落ちただけのことがあるので、
   * ロビーへ戻して押し直せるようにする（二重登録にはならない。
   * 同じ匿名利用者なら既存の参加者行がそのまま返る）。
   */
  const joinWithoutNickname = useCallback(
    async (info: JoinResolveResponse) => {
      setSubmitError(null);
      setSubmitting(true);
      try {
        await ensureSessionRef.current();
        const registered = await apiPost<JoinRegisterResponse>(
          `/api/join/${encodeURIComponent(joinToken)}/register`,
          {},
        );
        setState({ kind: 'redirecting', mode: info.mode });
        router.replace(`/play/${registered.roomId}`);
      } catch (caught) {
        setSubmitting(false);
        setState({ kind: 'ready', info });
        handleRegisterError(caught);
      }
    },
    [handleRegisterError, joinToken, router],
  );

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
          setState({ kind: 'redirecting', mode: info.mode });
          router.replace(`/play/${info.roomId}`);
          return;
        }

        if (isPollMode(info.mode) && acceptingNow(info)) {
          // 投票では名前を聞かない。読み込んだ流れのまま参加登録して投票画面へ送る。
          // 受付終了・満員のときだけロビーへ止めて理由を出す。
          if (autoJoinStartedRef.current) {
            return;
          }
          autoJoinStartedRef.current = true;
          setState({ kind: 'joining', mode: info.mode });
          await joinWithoutNickname(info);
          return;
        }

        // ここまでの resolve は認証と**並行**に走らせている。
        // セッションクッキーがまだ張られていないと、参加済みでも
        // alreadyJoinedNickname は null になる（サーバーが本人を特定できないため）。
        // 同じ端末で同じ二次元コードを読み直したときに、
        // ニックネーム入力からやり直させないよう、認証が整ってから一度だけ確かめ直す。
        setState({ kind: 'ready', info });

        const authed = await sessionPromise.catch(() => false);
        if (cancelled || !authed) {
          return;
        }

        try {
          const recheck = await apiGet<JoinResolveResponse>(
            `/api/join/${encodeURIComponent(joinToken)}/resolve`,
          );
          if (cancelled || recheck.alreadyJoinedNickname === null) {
            return;
          }
          setState({ kind: 'redirecting', mode: recheck.mode });
          router.replace(`/play/${recheck.roomId}`);
        } catch {
          // 確かめ直しに失敗しても、ニックネーム入力からの参加は続けられる。
          // 二重登録にはならない（同じ匿名利用者なら既存の参加者行が返る）。
        }
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
  }, [joinToken, joinWithoutNickname, router, reloadKey]);

  const handleReload = useCallback(() => {
    autoJoinStartedRef.current = false;
    setState({ kind: 'loading' });
    setReloadKey((previous) => previous + 1);
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
        setState((previous) => ({
          kind: 'redirecting',
          mode: previous.kind === 'ready' ? previous.info.mode : 'quiz',
        }));
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

  if (state.kind === 'joining') {
    return <FullScreenMessage title="参加しています" loading tone="info" />;
  }

  if (state.kind === 'redirecting') {
    return (
      <FullScreenMessage
        title={`${playScreenLabel(state.mode)}へ移動しています`}
        loading
        tone="info"
      />
    );
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
  const notices = blockedNotices(info.mode);
  const notice =
    (blockedCode !== null ? notices[blockedCode] : undefined) ??
    (!info.joinOpen ? notices.JOIN_CLOSED : isFull ? notices.ROOM_FULL : undefined) ??
    null;
  const asksNickname = !isPollMode(info.mode);

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
        ) : asksNickname ? (
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
        ) : (
          // 名前を聞かないルーム。ふつうは読み込んだ流れで自動的に通り過ぎる場所で、
          // ここが見えているのは登録に失敗したとき。押し直せるようにしておく。
          <div className="mt-4 flex flex-col gap-4">
            <p className="text-sm text-slate-600">お名前の入力は要りません。</p>

            {submitError !== null ? <ErrorMessage error={submitError} /> : null}

            <Button
              size="lg"
              fullWidth
              loading={submitting}
              onClick={() => void joinWithoutNickname(info)}
            >
              投票にすすむ
            </Button>
          </div>
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
