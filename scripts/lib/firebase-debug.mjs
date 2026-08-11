/**
 * firebase CLI の失敗理由を firebase-debug.log から取り出す。
 *
 * CLI は画面には「See firebase-debug.log for more info」としか出さず、
 * 実際の HTTP ステータスと API の応答本文はログにしか書かない。
 * ここを読まないと 403 の理由（権限不足・API 無効・スコープ不足・組織ポリシー）を
 * 区別できず、案内を誤る。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJsonObjectAt } from './cli-json.mjs';

/**
 * 直近のデバッグログを読む。
 *
 * @param {string[]} dirs      探索するディレクトリ（先頭を優先）
 * @param {number} [maxLines]  末尾から読む行数
 */
export function readDebugLogTail(dirs, maxLines = 400) {
  const names = ['firebase-debug.log', 'firebase-debug.log.1'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = dir ? join(dir, name) : name;
      if (!existsSync(file)) {
        continue;
      }
      try {
        return readFileSync(file, 'utf8').split(/\r?\n/).slice(-maxLines).join('\n');
      } catch {
        // 読めなければ次の候補へ（診断のための処理で失敗を増やさない）。
      }
    }
  }
  return '';
}

/**
 * デバッグログから HTTP ステータスとエラー本文を抽出する。
 * 直近のものを採るため、いずれも最後の一致を使う。
 *
 * firebase CLI のログは形が一定でない。
 *   HTTP Error: 403, The caller does not have permission
 *   <<< [apiv2][status] GET https://firebase.googleapis.com/... 403
 *   <<< [apiv2][body] GET https://... {"error": { ... 改行を含む ... }}
 * どれか 1 つの形だけを見ると取りこぼすため、複数の手掛かりを併用する。
 */
/** firebase CLI が出す HTTP ステータス行（`<<< [apiv2][status] GET <url> 403`）。 */
const HTTP_STATUS_LINE = /\[apiv2\]\[status\][^\n]*?\s(\d{3})\s*$/gm;

/** 正規表現の最後の一致の捕捉グループを返す（直近のエラーを採るため）。 */
function lastCapture(text, pattern) {
  let value = '';
  for (const match of text.matchAll(pattern)) {
    value = match[1] ?? '';
  }
  return value;
}

export function extractApiError(logText) {
  const text = String(logText ?? '');

  const status = lastCapture(text, /HTTP Error:\s*(\d{3})/g) || lastCapture(text, HTTP_STATUS_LINE);

  // {"error": { ... }} は整形されて複数行になることがある。波括弧の対応で切り出す。
  let body = '';
  const marker = /\{\s*"error"\s*:/g;
  let match;
  let lastIndex = -1;
  while ((match = marker.exec(text)) !== null) {
    lastIndex = match.index;
  }
  if (lastIndex >= 0) {
    const parsed = extractJsonObjectAt(text, lastIndex);
    if (parsed) {
      body = JSON.stringify(parsed);
    }
  }

  return { status, body, text: `${status}\n${body}\n${text}` };
}

/**
 * デバッグログのうち、原因に関係しそうな行だけを返す。
 *
 * 構造化された error 本文が取れないログもあるため、
 * 最後の手段として「読める形」で利用者へ見せる。
 */
export function relevantLogLines(logText, count = 12) {
  const interesting = /error|denied|forbidden|unauthorized|401|403|404|429|500|\[apiv2\]\[status\]/i;
  return String(logText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && interesting.test(line))
    .slice(-count);
}

/**
 * エラー本文から、対処が変わる原因を分類する。
 *
 * 403 は「権限不足」以外でも返るため、ここを分けないと案内が的外れになる。
 */
export function classifyApiError(text) {
  const source = String(text ?? '');
  /** ステータス行と "HTTP Error: NNN" のどちらの形でも拾う。 */
  const hasStatus = (code) =>
    new RegExp(`HTTP Error:\\s*${code}`, 'i').test(source) ||
    new RegExp(`\\[apiv2\\]\\[status\\][^\\n]*?\\s${code}\\s*$`, 'im').test(source);

  return {
    serviceDisabled:
      /SERVICE_DISABLED/i.test(source) || /has not been used in project/i.test(source),
    insufficientScopes:
      /insufficient authentication scopes/i.test(source) ||
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(source),
    permissionDenied:
      /PERMISSION_DENIED/i.test(source) ||
      /does not have permission/i.test(source) ||
      hasStatus(403),
    unauthenticated:
      /UNAUTHENTICATED/i.test(source) ||
      /invalid_grant/i.test(source) ||
      /Failed to authenticate/i.test(source) ||
      hasStatus(401),
    notFound: hasStatus(404) || /Firebase project .* not found/i.test(source),
  };
}
