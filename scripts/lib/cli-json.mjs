/**
 * firebase CLI の `--json` 出力を「終了コードではなく中身」で判定するための道具。
 *
 * 背景:
 *   firebase CLI は正しい結果を JSON で出力しながら 0 以外で終了することがある
 *   （npx / pnpm dlx ラッパー経由の終了コード伝播、作業ディレクトリの firebase.json
 *   検証、後片付けの失敗など）。終了コードだけで失敗と決めると、
 *   **すでに取得できている正しい設定を捨てて「取得できませんでした」と言ってしまう**。
 *
 *   一方 `--json` は失敗時に {"status":"error","error":...} を返すため、
 *   成否は出力内容から確実に判別できる。判定はそちらを正とする。
 */

/**
 * 文字列から最初の JSON オブジェクトを取り出す。
 *
 * npx / pnpm dlx 経由だと npm の警告やダウンロード表示が stdout に混ざることがあり、
 * 出力全体を JSON.parse できない。波括弧の対応を取りながら 1 個だけ切り出す。
 * 文字列リテラル内の波括弧・エスケープされた引用符は数えない。
 *
 * @param {unknown} text
 * @returns {any | null} 解釈できた最初のオブジェクト。無ければ null。
 */
export function extractJsonObject(text) {
  const source = String(text ?? '');
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            break; // この '{' からは解釈できない。次の候補を試す。
          }
        }
      }
    }
  }
  return null;
}

/**
 * `run()` の戻り値から firebase CLI の JSON 結果を取り出す。
 *
 * @param {{stdout?: string, ok?: boolean, status?: number|null}} cmdResult
 * @returns {{ok: boolean, result: any, message: string}}
 *   ok      … 使える結果が得られたか（終了コードは見ない）
 *   result  … payload.result（無ければ payload 自身）
 *   message … CLI が返したエラー本文（失敗時のみ）
 */
export function cliJson(cmdResult) {
  const payload = extractJsonObject(cmdResult?.stdout);
  if (!payload || typeof payload !== 'object') {
    return { ok: false, result: null, message: '' };
  }
  if (payload.status === 'error') {
    const message =
      typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error ?? {});
    return { ok: false, result: null, message };
  }
  return { ok: true, result: 'result' in payload ? payload.result : payload, message: '' };
}
