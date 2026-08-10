import { redactPath } from '@/lib/crypto/tokens';

/**
 * Cloud Logging 前提の構造化ログ。
 *
 * - stdout / stderr へ 1 行 JSON を書き出す。
 * - `severity` は Cloud Logging の LogSeverity へ合わせる。
 * - 参加トークン・Secret Key・Auth トークン・正解データを出力しない。
 */

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

const LEVEL_ORDER: Record<LogSeverity, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

function configuredThreshold(): number {
  switch (process.env.LOG_LEVEL) {
    case 'debug':
      return LEVEL_ORDER.DEBUG;
    case 'warn':
      return LEVEL_ORDER.WARNING;
    case 'error':
      return LEVEL_ORDER.ERROR;
    default:
      return LEVEL_ORDER.INFO;
  }
}

export type LogFields = {
  requestId?: string;
  route?: string;
  method?: string;
  userId?: string | null;
  roomId?: string | null;
  quizId?: string | null;
  questionId?: string | null;
  action?: string;
  stateVersion?: number | null;
  result?: 'ok' | 'error';
  errorCode?: string;
  durationMs?: number;
  [key: string]: unknown;
};

/** 出力してはいけないキー（万一渡されても落とす）。 */
const FORBIDDEN_KEYS = new Set([
  'token',
  'joinToken',
  'join_token',
  'presentationToken',
  'presentation_token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'supabaseSecretKey',
  'SUPABASE_SECRET_KEY',
  'password',
  'isCorrect',
  'correctValue',
  'correctChoiceId',
  'numberRaw',
]);

function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string' && (key === 'path' || key === 'url' || key === 'route')) {
      out[key] = redactPath(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function write(severity: LogSeverity, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[severity] < configuredThreshold()) {
    return;
  }

  const entry = {
    severity,
    timestamp: new Date().toISOString(),
    service: 'smileq-live',
    environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'local',
    message,
    ...sanitize(fields),
  };

  const line = JSON.stringify(entry);
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write('DEBUG', message, fields),
  info: (message: string, fields?: LogFields) => write('INFO', message, fields),
  warn: (message: string, fields?: LogFields) => write('WARNING', message, fields),
  error: (message: string, fields?: LogFields) => write('ERROR', message, fields),
  critical: (message: string, fields?: LogFields) => write('CRITICAL', message, fields),
};

export function createRequestId(): string {
  return crypto.randomUUID();
}

/** 例外を安全にログ用フィールドへ変換する（スタックは残すが利用者には返さない）。 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: process.env.APP_ENV === 'production' ? undefined : error.stack,
    };
  }
  return { errorMessage: String(error) };
}
