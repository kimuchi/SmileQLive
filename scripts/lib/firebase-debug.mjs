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
 */
export function extractApiError(logText) {
  const text = String(logText ?? '');
  const status = text.match(/HTTP Error:\s*(\d{3})/g)?.pop() ?? '';
  const body = text.match(/\{"error":\{[^\n]*\}\}/g)?.pop() ?? '';
  return { status, body, text: `${status}\n${body}\n${text}` };
}

/**
 * エラー本文から、対処が変わる原因を分類する。
 *
 * 403 は「権限不足」以外でも返るため、ここを分けないと案内が的外れになる。
 */
export function classifyApiError(text) {
  const source = String(text ?? '');
  return {
    serviceDisabled: /SERVICE_DISABLED/i.test(source) || /has not been used in project/i.test(source),
    insufficientScopes: /insufficient authentication scopes/i.test(source) || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(source),
    permissionDenied:
      /PERMISSION_DENIED/i.test(source) ||
      /does not have permission/i.test(source) ||
      /HTTP Error:\s*403/i.test(source),
    notFound: /HTTP Error:\s*404/i.test(source) || /Firebase project .* not found/i.test(source),
  };
}
