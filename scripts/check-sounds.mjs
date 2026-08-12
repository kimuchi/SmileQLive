#!/usr/bin/env node
/**
 * 効果音がちゃんと配信されるかを確かめる。
 *
 *   npm run sounds:check                              手元のファイルを検査する
 *   npm run sounds:check -- --url https://example.com 公開中のサイトを検査する
 *
 * なぜ要るか:
 *   「音が鳴らない」の原因のほとんどは、音源がサーバーに載っていないことだった。
 *   投影画面は manifest.json を読んでから音源を取りに行くため、
 *   manifest とファイルが食い違っていると、画面上は何も起きずに無音になる。
 *   その食い違いを 1 コマンドで見つけられるようにする。
 *
 *   とくに `npm run sounds:install` で取り込んだ音源は **Git に入らない**（再配布禁止のため）。
 *   その状態で別の端末や CI からデプロイすると、manifest だけが新しく、音源が無い状態になる。
 *   --url を付けると公開中のサイトに対して同じ検査ができる。
 *
 * 方針:
 *   - 追加の依存パッケージを使わない（Node.js の標準モジュールだけ）。
 *   - Windows / macOS / Linux で同じコマンドが動くよう、シェル機能に依存しない。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { parseArgs } from './lib/config.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

/** 投影画面が鳴らす 6 種類。projector-audio-manager.ts の SOUND_NAMES と一致させる。 */
const SOUND_NAMES = [
  'question-start',
  'tick',
  'answer-lock',
  'answer-reveal',
  'ranking',
  'finish',
];

const SOUNDS_DIR = join('public', 'sounds');

/** 音声ファイルとして妥当か、先頭のバイト列で判定する（拡張子は信用しない）。 */
function detectAudioKind(buffer) {
  if (buffer.length < 12) {
    return null;
  }
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WAVE') {
    return 'wav';
  }
  if (head === 'OggS') {
    return 'ogg';
  }
  if (head.startsWith('ID3')) {
    return 'mp3';
  }
  // MPEG フレーム同期（ID3 タグの無い mp3）。
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return null;
}

const { flags } = parseArgs(process.argv.slice(2));
const baseUrl = typeof flags.get('url') === 'string' ? String(flags.get('url')).replace(/\/+$/, '') : '';

heading(baseUrl ? '効果音の確認（公開中のサイト）' : '効果音の確認（手元のファイル）');
if (baseUrl) {
  info(`対象: ${baseUrl}`);
} else {
  info(`対象: ${SOUNDS_DIR}`);
  info(color.dim('公開中のサイトを調べるには --url https://example.com を付けてください。'));
}

// ---------------------------------------------------------------------------
step('manifest.json を読む');

let manifest;
if (baseUrl) {
  const manifestUrl = `${baseUrl}/sounds/manifest.json`;
  let response;
  try {
    response = await fetch(manifestUrl, { redirect: 'follow' });
  } catch (error) {
    fatal(
      `${manifestUrl} を取得できませんでした。`,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    fatal(
      `${manifestUrl} が ${response.status} を返しました。`,
      'デプロイに public/sounds が含まれているか確認してください。',
    );
  }
  manifest = await response.json();
} else {
  const manifestPath = join(SOUNDS_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fatal(
      `${manifestPath} がありません。`,
      'npm run sounds:generate で同梱音を作り直してください。',
    );
  }
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
}
success('manifest.json を読み込みました');

// ---------------------------------------------------------------------------
step('音源を 1 件ずつ確かめる');

const problems = [];
let okCount = 0;

for (const name of SOUND_NAMES) {
  const fileName = manifest[name];

  if (typeof fileName !== 'string' || fileName.trim().length === 0) {
    problems.push(`${name}: manifest.json に指定がありません`);
    warn(`${name.padEnd(15)} manifest.json に指定がありません`);
    continue;
  }

  if (baseUrl) {
    // 投影画面と同じ解決（manifest.json からの相対）。
    const url = new URL(fileName, `${baseUrl}/sounds/manifest.json`).toString();
    let response;
    try {
      response = await fetch(url, { redirect: 'follow' });
    } catch (error) {
      problems.push(`${name}: ${url} を取得できません（${error instanceof Error ? error.message : error}）`);
      warn(`${name.padEnd(15)} 取得できません ${url}`);
      continue;
    }
    if (!response.ok) {
      problems.push(`${name}: ${url} が ${response.status} を返しました`);
      warn(`${name.padEnd(15)} ${response.status} ${url}`);
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const kind = detectAudioKind(buffer);
    if (!kind) {
      problems.push(`${name}: ${url} は音声ファイルではありません`);
      warn(`${name.padEnd(15)} 音声ファイルとして認識できません ${url}`);
      continue;
    }
    okCount += 1;
    success(`${name.padEnd(15)} ${kind} ${(buffer.length / 1024).toFixed(0)}KB  ${fileName}`);
    continue;
  }

  const filePath = join(SOUNDS_DIR, fileName);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    problems.push(`${name}: ${filePath} がありません`);
    warn(`${name.padEnd(15)} ファイルがありません ${filePath}`);
    continue;
  }
  const buffer = readFileSync(filePath);
  const kind = detectAudioKind(buffer);
  if (!kind) {
    problems.push(`${name}: ${filePath} は音声ファイルではありません`);
    warn(`${name.padEnd(15)} 音声ファイルとして認識できません ${filePath}`);
    continue;
  }
  okCount += 1;
  success(`${name.padEnd(15)} ${kind} ${(buffer.length / 1024).toFixed(0)}KB  ${fileName}`);
}

// ---------------------------------------------------------------------------
if (!baseUrl) {
  step('デプロイへ含まれるかを確かめる');

  // public/sounds/ 直下は .gitignore 済み（再配布できない素材の置き場）。
  // ここを使っている場合、Git 経由のデプロイには音源が乗らない。
  const trackedOutside = SOUND_NAMES.filter((name) => {
    const fileName = manifest[name];
    return typeof fileName === 'string' && !fileName.includes('/');
  });

  if (trackedOutside.length > 0) {
    warn(`${trackedOutside.length} 件が public/sounds/ 直下の音源を指しています。`);
    info('直下の音源は .gitignore 済みで、Git には入りません。');
    info('  * この端末から npm run deploy する場合は、そのまま配信されます。');
    info('  * 別の端末や CI からデプロイする場合、音源が無い状態になります。');
    info('  デプロイ後の確認: npm run sounds:check -- --url https://<公開URL>');
  } else {
    success('同梱音 (public/sounds/default/) を使っています。どこからデプロイしても配信されます。');
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (problems.length > 0) {
  fatal(
    `${problems.length} 件の問題があります（${okCount} / ${SOUND_NAMES.length} 件は正常）。`,
    baseUrl
      ? '公開中のサイトに音源が載っていません。音源を用意した端末から npm run deploy を実行してください。'
      : 'npm run sounds:generate で同梱音へ戻すか、npm run sounds:install で音源を取り込んでください。',
  );
}

success(`効果音 ${okCount} 件すべて確認できました。`);
if (!baseUrl) {
  console.log(
    `  ${color.dim('公開中のサイトも確認する: npm run sounds:check -- --url https://<公開URL>')}`,
  );
}
console.log('');
