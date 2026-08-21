/**
 * アプリケーション共通エラー。
 *
 * - 内部コード → HTTP ステータス → 利用者向け日本語メッセージを 1 箇所で管理する。
 * - SQL エラー・スタックトレースを利用者画面へ出さない。
 */

export const APP_ERROR_DEFINITIONS = {
  // 認証・認可
  UNAUTHENTICATED: { status: 401, message: 'ログインが必要です' },
  FORBIDDEN: { status: 403, message: 'この操作を行う権限がありません' },
  HOST_ONLY: { status: 403, message: '司会者のみが実行できる操作です' },
  NOT_A_PARTICIPANT: { status: 403, message: 'このルームの参加者として登録されていません' },

  // 参加 URL
  JOIN_LINK_INVALID: { status: 404, message: 'この参加URLは無効です' },
  JOIN_LINK_REVOKED: {
    status: 410,
    message: 'この参加URLは更新されています。会場の二次元コードを読み直してください',
  },
  JOIN_CLOSED: { status: 403, message: 'このクイズは参加受付を終了しています' },
  ROOM_FULL: { status: 409, message: '参加人数が上限に達しました' },
  NICKNAME_TAKEN: { status: 409, message: '同じ名前が使われています' },
  NICKNAME_INVALID: { status: 400, message: 'ニックネームは1〜20文字で入力してください' },

  // 投影リンク
  PRESENTATION_LINK_INVALID: { status: 404, message: 'この投影URLは無効です' },
  PRESENTATION_LINK_EXPIRED: { status: 410, message: 'この投影URLは期限切れです' },

  // 回答
  ANSWER_ALREADY_EXISTS: { status: 409, message: 'この問題には回答済みです' },
  ANSWER_DEADLINE_PASSED: { status: 409, message: '回答時間が終了しました' },
  ANSWER_NOT_OPEN: { status: 409, message: 'まだ回答を受け付けていません' },
  ANSWER_QUESTION_MISMATCH: { status: 409, message: '表示中の問題が切り替わりました' },
  INVALID_CHOICE: { status: 400, message: '選択肢を選び直してください' },
  ANSWER_TYPE_MISMATCH: { status: 400, message: '回答形式が正しくありません' },
  INVALID_NUMBER_FORMAT: { status: 422, message: '数値だけを入力してください' },
  INVALID_NUMBER_LENGTH: { status: 422, message: '数値を入力してください' },
  NUMBER_TOO_LARGE: { status: 422, message: '入力できる桁数を超えています' },
  NUMBER_TOO_MANY_DECIMALS: { status: 422, message: '小数点以下は10桁までです' },

  // 状態遷移
  STATE_VERSION_CONFLICT: { status: 409, message: '画面を最新状態へ更新しました' },
  INVALID_TRANSITION: { status: 409, message: 'この操作は現在の進行状況では実行できません' },
  QUESTION_NOT_FOUND: { status: 404, message: '指定された問題が見つかりません' },
  ROOM_NOT_FOUND: { status: 404, message: 'ルームが見つかりません' },
  ROOM_FINISHED: { status: 409, message: 'このクイズはすでに終了しています' },

  // クイズ編集
  QUIZ_NOT_FOUND: { status: 404, message: 'クイズが見つかりません' },
  QUIZ_PUBLISH_VALIDATION_FAILED: { status: 422, message: '公開条件を満たしていません' },
  QUIZ_NOT_PUBLISHED: { status: 422, message: '公開済みのクイズだけルームを作成できます' },
  CHOICE_LIMIT_REACHED: { status: 422, message: '選択肢は最大5個までです' },
  CHOICE_MINIMUM_REACHED: { status: 422, message: '選択肢は最低2個必要です' },

  // 抽選会・ビンゴ
  DRAW_LIST_NOT_FOUND: { status: 404, message: '抽選リストが見つかりません' },
  DRAW_LIST_EMPTY: { status: 422, message: '抽選リストが空です。1件以上登録してください' },
  DRAW_LIST_TOO_LARGE: { status: 422, message: '抽選リストの件数が多すぎます' },
  DRAW_LIST_RANGE_INVALID: { status: 422, message: '数字の範囲が正しくありません' },
  DRAW_LIST_KIND_MISMATCH: {
    status: 422,
    message: 'このモードでは使えない種類の抽選リストです',
  },
  DRAW_POOL_EMPTY: { status: 409, message: 'もう引けるものがありません' },
  DRAW_NOTHING_TO_UNDO: { status: 409, message: '取り消せる抽選がありません' },
  ROOM_MODE_MISMATCH: { status: 409, message: 'このルームでは実行できない操作です' },

  // 画像
  MEDIA_TOO_LARGE: { status: 422, message: '画像は8MB以下にしてください' },
  MEDIA_UNSUPPORTED_TYPE: { status: 422, message: 'JPEG・PNG・WebP の画像を指定してください' },
  MEDIA_PROCESSING_FAILED: { status: 422, message: '画像を処理できませんでした' },
  MEDIA_NOT_FOUND: { status: 404, message: '画像が見つかりません' },
  MEDIA_IN_USE: { status: 409, message: 'この画像は使用中のため削除できません' },

  // 共通
  VALIDATION_FAILED: { status: 400, message: '入力内容を確認してください' },
  RATE_LIMITED: { status: 429, message: '操作が多すぎます。しばらく待ってから再度お試しください' },
  CAPTCHA_FAILED: { status: 403, message: '本人確認に失敗しました。もう一度お試しください' },
  ORIGIN_NOT_ALLOWED: { status: 403, message: '不正なリクエストです' },
  CONFIGURATION_ERROR: { status: 500, message: 'サーバー設定に問題があります' },
  INTERNAL_ERROR: { status: 500, message: '処理に失敗しました。時間をおいて再度お試しください' },
} as const satisfies Record<string, { status: number; message: string }>;

export type AppErrorCode = keyof typeof APP_ERROR_DEFINITIONS;

export function isAppErrorCode(value: string): value is AppErrorCode {
  return Object.prototype.hasOwnProperty.call(APP_ERROR_DEFINITIONS, value);
}

export function statusForCode(code: AppErrorCode): number {
  return APP_ERROR_DEFINITIONS[code].status;
}

export function userMessageForCode(code: AppErrorCode): string {
  return APP_ERROR_DEFINITIONS[code].message;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly details: unknown;

  constructor(code: AppErrorCode, options: { details?: unknown; cause?: unknown } = {}) {
    super(code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = statusForCode(code);
    this.userMessage = userMessageForCode(code);
    this.details = options.details;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError('INTERNAL_ERROR', { cause: error });
}

/** Realtime 切断など、HTTP 以外の利用者向け通知文言。 */
export const CLIENT_NOTICES = {
  REALTIME_DISCONNECTED: '再接続しています',
  REALTIME_RECONNECTED: '接続が回復しました',
} as const;
