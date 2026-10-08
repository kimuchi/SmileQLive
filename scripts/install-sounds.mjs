#!/usr/bin/env node
/**
 * 効果音ラボ（https://soundeffect-lab.info/）の音源を取り込む。
 *
 *   npm run sounds:install                      … 何をどこから入手するかを表示
 *   npm run sounds:install -- --from ~/Downloads … そのフォルダから取り込む
 *   npm run sounds:install -- --revert           … プレースホルダへ戻す
 *
 * **ダウンロードはこのスクリプトでは行いません。**
 * 効果音ラボの利用規約は「素材そのものの再配布」と「効果音ファイルの直リンク」を
 * 禁じています（商用利用は無料・クレジット表記は不要）。
 * そのため、
 *   * 音源をこのリポジトリへ同梱しない（public/sounds/*.mp3 は .gitignore 済み）
 *   * スクリプトが配布元へ直接アクセスしない
 * という形にし、ダウンロードは利用者がブラウザで行います。
 * このスクリプトは「どれを落とすか」の案内と、落とした後の取り込み・記録を担当します。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { flags } = parseArgs(process.argv.slice(2));
const SOUNDS_DIR = join('public', 'sounds');
const SOURCE_NAME = '効果音ラボ';
const SOURCE_URL = 'https://soundeffect-lab.info/';

/**
 * SmileQ Live が鳴らす 9 音と、その用途に合う効果音ラボの素材。
 *
 * `file` は配布元でのファイル名。利用者がダウンロードした際の名前と一致する。
 */
const RECOMMENDED = [
  {
    name: 'question-start',
    purpose: '出題の合図',
    label: 'クイズ出題1（デデン）',
    file: 'question1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'tick',
    purpose: '残り時間のカウント',
    label: '制限時間タイマー',
    file: 'quiz-timer1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'answer-lock',
    purpose: '回答締切',
    label: 'クイズ早押しボタン1',
    file: 'quiz-button1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'answer-reveal',
    purpose: '正解発表',
    label: 'クイズ正解1（ピンポンピンポン）',
    file: 'correct1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'ranking',
    purpose: 'ランキング発表前のため',
    label: 'ドラムロール',
    file: 'drum-roll1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'fanfare',
    purpose: 'ランキングが出た瞬間',
    label: 'ファンファーレ',
    file: 'fanfare1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'finish',
    purpose: '終了',
    label: 'ジャジャーン',
    file: 'jajean1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    // 回している間ずっと繰り返すため、ranking のドラムロールとは別の素材を割り当てる
    // （ranking は途中で速くなる「ため」の音なので、繰り返すと拍が崩れる）。
    name: 'draw-spin',
    purpose: '抽選のルーレット中',
    label: 'ティンパニロール（ドドドド）',
    file: 'tympani-roll1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'draw-win',
    purpose: '当選が確定した瞬間',
    label: 'ラッパのファンファーレ',
    file: 'trumpet1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    // 200 人が一斉に押す場面で鳴る。長い素材だと重なって鳴りっぱなしになる。
    name: 'poll-vote',
    purpose: '投票が 1 票入った瞬間',
    label: '決定ボタンを押す',
    file: 'decision1.mp3',
    page: 'https://soundeffect-lab.info/sound/button/',
  },
  {
    // 順位が出るまで繰り返す。draw-spin と同じ理由で、途中で速くなる素材は避ける。
    name: 'poll-drumroll',
    purpose: '投票結果を出すまでのため',
    label: 'ティンパニロール（ドドドド）',
    file: 'tympani-roll1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
  {
    name: 'poll-result',
    purpose: '投票結果の順位が出た瞬間',
    label: 'ジャーン',
    file: 'jaan1.mp3',
    page: 'https://soundeffect-lab.info/sound/anime/',
  },
];

/** 音声ファイルかどうかを先頭バイトで確かめる（拡張子を信用しない）。 */
function detectAudio(buffer) {
  if (buffer.length < 12) {
    return null;
  }
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') {
    return 'mp3';
  }
  // MPEG フレーム同期。
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'wav';
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'OggS') {
    return 'ogg';
  }
  return null;
}

// ---------------------------------------------------------------------------
if (flags.has('revert')) {
  heading('効果音を同梱音へ戻す');
  const { run } = await import('./lib/proc.mjs');
  run('node', ['scripts/generate-sounds.mjs'], { capture: false });
  process.exit(0);
}

const fromDir = typeof flags.get('from') === 'string' ? resolve(flags.get('from')) : '';

// ---------------------------------------------------------------------------
if (!fromDir) {
  heading('効果音の入手手順');

  info(`${SOURCE_NAME}（${SOURCE_URL}）から次の ${RECOMMENDED.length} つをダウンロードしてください。`);
  console.log('');
  console.log(`  ${'用途'.padEnd(14)} ${'素材名'.padEnd(28)} ファイル名`);
  console.log(`  ${'-'.repeat(14)} ${'-'.repeat(28)} ${'-'.repeat(20)}`);
  for (const entry of RECOMMENDED) {
    console.log(`  ${entry.purpose.padEnd(14)} ${entry.label.padEnd(28)} ${color.bold(entry.file)}`);
  }
  console.log('');
  console.log(`  配布ページ: ${color.bold(RECOMMENDED[0].page)}`);
  console.log('');

  info('ダウンロードしたら、そのフォルダを指定して取り込みます。');
  console.log('');
  console.log('  Windows : npm run sounds:install -- --from "%USERPROFILE%\\Downloads"');
  console.log('  macOS   : npm run sounds:install -- --from ~/Downloads');
  console.log('');

  info(`${SOURCE_NAME}の規約（要点）:`);
  console.log('    * 商用利用も無料。クレジット表記は不要（任意）');
  console.log('    * 素材そのものの再配布は禁止');
  console.log('    * 効果音ファイルへの直リンクは禁止');
  console.log('');
  console.log(
    `  ${color.dim('このため音源はリポジトリへ含めず、ダウンロードも自動化していません。')}`,
  );
  console.log(
    `  ${color.dim('取り込んだ音源は public/sounds/ 直下に置かれ、Git には入りません（同梱音より優先されます）。')}`,
  );
  console.log('');
  info('取り込まなくても、同梱の自家生成音がそのまま鳴ります。作り直す場合:');
  console.log('    npm run sounds:generate');
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------------------
heading('効果音を取り込む');
info(`取り込み元: ${fromDir}`);

if (!existsSync(fromDir)) {
  fatal(`フォルダが見つかりません: ${fromDir}`);
}

mkdirSync(SOUNDS_DIR, { recursive: true });

// 大文字小文字やブラウザが付ける連番 (correct1(1).mp3) の揺れを吸収する。
const availableFiles = readdirSync(fromDir);
function findDownloaded(expected) {
  const stem = expected.replace(/\.[^.]+$/, '').toLowerCase();
  return availableFiles.find((candidate) => {
    const name = basename(candidate).toLowerCase();
    return name === expected.toLowerCase() || name.replace(/\s*\(\d+\)/, '') === expected.toLowerCase() || name.startsWith(`${stem}.`);
  });
}

step('ファイルを確認');

const installed = [];
const missing = [];

for (const entry of RECOMMENDED) {
  const found = findDownloaded(entry.file);
  if (!found) {
    missing.push(entry);
    continue;
  }

  const sourcePath = join(fromDir, found);
  const buffer = readFileSync(sourcePath);
  const kind = detectAudio(buffer);
  if (!kind) {
    warn(`${found} は音声ファイルとして認識できませんでした。飛ばします。`);
    missing.push(entry);
    continue;
  }

  const targetName = `${entry.name}.${kind}`;
  copyFileSync(sourcePath, join(SOUNDS_DIR, targetName));
  installed.push({ ...entry, targetName, sourceFile: found, bytes: buffer.length });
  success(`${entry.name.padEnd(15)} ← ${found} (${Math.round(buffer.length / 1024)} KB)`);
}

if (missing.length > 0) {
  console.log('');
  warn(`${missing.length} 件が見つかりませんでした。`);
  for (const entry of missing) {
    console.log(`    ${entry.name.padEnd(15)} ${entry.file}（${entry.label}）`);
  }
  info(`  配布ページ: ${RECOMMENDED[0].page}`);
}

if (installed.length === 0) {
  fatal(
    '取り込めた音源がありません。',
    'ダウンロード先のフォルダを --from で指定してください。',
  );
}

// ---------------------------------------------------------------------------
step('manifest.json を更新');

// 取り込めなかった音は既存の指定（プレースホルダ）を残す。無音より鳴るほうがよい。
const manifestPath = join(SOUNDS_DIR, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
for (const entry of installed) {
  manifest[entry.name] = entry.targetName;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
success(`${installed.length} 件を manifest.json へ反映しました`);

// ---------------------------------------------------------------------------
step('ライセンス記録を更新');

// 出典を残さないまま会場で使うと、後から権利確認ができなくなる。
const today = new Date().toISOString().slice(0, 10);
const rows = RECOMMENDED.map((entry) => {
  const done = installed.find((item) => item.name === entry.name);
  if (!done) {
    return `| ${entry.name} | （未取得） | — | — | — | — | — |`;
  }
  return `| ${entry.name} | \`${done.targetName}\` | ${SOURCE_NAME}（${entry.label}） | ${SOURCE_URL} | 可 | 不要 | ${today} |`;
});

const licensePath = join(SOUNDS_DIR, 'LICENSE.md');
const license = [
  '# 効果音のライセンス記録',
  '',
  `このファイルは \`npm run sounds:install\` が更新します。`,
  '',
  '## 現在の音源',
  '',
  '| 名前 | ファイル | 出典 | 配布元 | 商用利用 | クレジット表記 | 取得日 |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  '## 配布元の規約（取得時点の要点）',
  '',
  `- 商用利用を含めて無料（${SOURCE_NAME}）`,
  '- クレジット表記は任意（不要）',
  '- **素材そのものの再配布は禁止**',
  '- **効果音ファイルへの直リンクは禁止**',
  '',
  `最新の条件は ${SOURCE_URL}agreement/ を確認してください。`,
  '',
  '## リポジトリに音源を含めない理由',
  '',
  '再配布禁止のため、`public/sounds/` の音源は `.gitignore` 済みです。',
  '別の環境へ配置するときは、その環境で `npm run sounds:install` を実行してください。',
  '',
  '## 別の音源に差し替える場合',
  '',
  '1. `public/sounds/` へファイルを置く',
  '2. `manifest.json` のファイル名を更新する',
  '3. 上の表へ出典・ライセンス・取得日を記録する',
  '',
  '**記録が空のまま公開イベントで使用しないこと。**',
  '',
].join('\n');

writeFileSync(licensePath, license);
success('LICENSE.md へ出典を記録しました');

// ---------------------------------------------------------------------------
// 取り込んだだけでは公開先に載らない。ここを飛ばすと会場で無音になる。
heading('この先が必要です');

warn('取り込んだ音源は Git に入りません（再配布禁止のため .gitignore 済み）。');
console.log('  そのため、次のどちらかをしないと**公開中のサイトでは鳴りません**。');
console.log('');
console.log(`  ${color.bold('1. この端末から配信する')}`);
console.log('     npm run deploy -- production');
console.log('');
console.log(`  ${color.bold('2. 同梱音のまま使う（差し替えをやめる）')}`);
console.log('     npm run sounds:generate');
console.log('');

info('配信したあと、公開先に音源が載っているか確かめられます:');
console.log('    npm run sounds:check -- --url https://<公開URL>');
console.log('');

// ---------------------------------------------------------------------------
heading('会場での確認方法');
console.log('  1. 投影画面を開く（効果音はこの画面だけで鳴ります）');
console.log('  2. 「音声テスト」を押す（結果が画面に出ます）');
console.log('  3. 「投影を開始」すると、読み込めた件数が画面に表示されます');
console.log('');
info('参加者のスマートフォンからは音は出ません（設計上の約束）。');
console.log('');
