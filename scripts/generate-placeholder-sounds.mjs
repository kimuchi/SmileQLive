#!/usr/bin/env node
/**
 * 投影画面の効果音プレースホルダを生成する。
 *
 *   node scripts/generate-placeholder-sounds.mjs
 *   node scripts/generate-placeholder-sounds.mjs --keep-existing
 *
 * 目的:
 *   ライセンスの確認が済んでいない音源をリポジトリへ置かずに、投影画面の動作確認を可能にする。
 *   ここで作るのは正弦波にエンベロープを掛けただけの自家生成音で、第三者の権利を含まない。
 *
 * 生成物:
 *   public/sounds/*.wav （44.1kHz / 16bit / モノラル）
 *   public/sounds/manifest.json を .wav の名前へ更新する
 *
 * 方針:
 *   - 追加の依存パッケージを使わない（Node.js の標準モジュールだけ）。
 *   - Windows / macOS / Linux で同じコマンドが動くよう、シェル機能に依存しない。
 *   - package.json は変更しない（呼び出し方は public/sounds/README.md に記載）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, heading, info, step, success, warn } from './lib/log.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const OUTPUT_DIR = join('public', 'sounds');
const SAMPLE_RATE = 44_100;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/** 全体の音量。会場スピーカーで歪ませないため余裕を残す。 */
const MASTER_GAIN = 0.5;

const keepExisting = process.argv.includes('--keep-existing');

// ---------------------------------------------------------------------------
// 音の組み立て
// ---------------------------------------------------------------------------

/** 音名から周波数を求める（A4 = 440Hz の平均律）。 */
function note(semitonesFromA4) {
  return 440 * Math.pow(2, semitonesFromA4 / 12);
}

const NOTES = {
  C5: note(3),
  D5: note(5),
  E5: note(7),
  G5: note(10),
  A5: note(12),
  C6: note(15),
  E6: note(19),
  G6: note(22),
  G4: note(-2),
  E4: note(-5),
  C4: note(-9),
};

/**
 * 1 つの音（部分音）を書き込む。
 *
 * @param {Float64Array} samples 出力先
 * @param {object} part
 * @param {number} part.startSec 開始時刻（秒）
 * @param {number} part.durationSec 長さ（秒）
 * @param {number} part.frequency 基本周波数 (Hz)
 * @param {number} [part.gain] 音量 (0〜1)
 * @param {number} [part.attackSec] 立ち上がり（秒）
 * @param {number} [part.decay] 減衰の速さ（大きいほど速く消える）
 * @param {number} [part.overtone] 倍音の混ぜ具合 (0〜1)
 * @param {number} [part.endFrequency] 終端周波数（指定すると滑らかに変化する）
 */
function addTone(samples, part) {
  const {
    startSec,
    durationSec,
    frequency,
    gain = 1,
    attackSec = 0.006,
    decay = 4,
    overtone = 0.18,
    endFrequency = null,
  } = part;

  const start = Math.floor(startSec * SAMPLE_RATE);
  const length = Math.floor(durationSec * SAMPLE_RATE);
  const attack = Math.max(1, Math.floor(attackSec * SAMPLE_RATE));
  // 位相を積み上げることで、周波数が変化しても波形が途切れない。
  let phase = 0;

  for (let i = 0; i < length; i += 1) {
    const index = start + i;
    if (index >= samples.length) {
      break;
    }
    const progress = i / length;
    const freq =
      endFrequency === null ? frequency : frequency + (endFrequency - frequency) * progress;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;

    // 立ち上がりは直線、減衰は指数。末尾は必ず 0 へ寄せてノイズを残さない。
    const attackGain = i < attack ? i / attack : 1;
    const decayGain = Math.exp(-decay * progress);
    const tailGain = progress > 0.9 ? (1 - progress) / 0.1 : 1;

    const value =
      Math.sin(phase) + overtone * Math.sin(2 * phase) + overtone * 0.4 * Math.sin(3 * phase);

    samples[index] += value * gain * attackGain * decayGain * tailGain;
  }
}

/** クリッピングを避けるため、最大振幅が 1 を超えないよう全体を縮める。 */
function normalize(samples) {
  let peak = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  if (peak === 0) {
    return samples;
  }
  const scale = MASTER_GAIN / peak;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= scale;
  }
  return samples;
}

/** 16bit PCM の WAV ファイル（RIFF）を組み立てる。 */
function encodeWav(samples) {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataSize = samples.length * bytesPerSample * CHANNELS;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt チャンクの長さ
  buffer.writeUInt16LE(1, 20); // 1 = リニア PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28); // バイト/秒
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32); // ブロック境界
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const value of samples) {
    const clamped = Math.max(-1, Math.min(1, value));
    buffer.writeInt16LE(Math.round(clamped * 32_767), offset);
    offset += 2;
  }

  return buffer;
}

function createSamples(durationSec) {
  return new Float64Array(Math.ceil(durationSec * SAMPLE_RATE));
}

// ---------------------------------------------------------------------------
// 6 種類の効果音
// ---------------------------------------------------------------------------

const SOUNDS = {
  /** 回答受付開始: 上昇する 2 音で「はじまり」を示す。 */
  'question-start': () => {
    const samples = createSamples(0.9);
    addTone(samples, { startSec: 0, durationSec: 0.35, frequency: NOTES.C5, decay: 3.2 });
    addTone(samples, { startSec: 0.18, durationSec: 0.7, frequency: NOTES.G5, decay: 2.6 });
    return samples;
  },

  /** 残り 5〜1 秒: 次の秒に重ならない短い合図。控えめな音量。 */
  tick: () => {
    const samples = createSamples(0.16);
    addTone(samples, {
      startSec: 0,
      durationSec: 0.12,
      frequency: NOTES.A5,
      gain: 0.7,
      attackSec: 0.002,
      decay: 9,
      overtone: 0.08,
    });
    return samples;
  },

  /** 回答締切: 下降する 2 音で「閉じた」ことを示す。 */
  'answer-lock': () => {
    const samples = createSamples(0.7);
    addTone(samples, { startSec: 0, durationSec: 0.22, frequency: NOTES.G5, decay: 4.5 });
    addTone(samples, {
      startSec: 0.14,
      durationSec: 0.55,
      frequency: NOTES.C5,
      endFrequency: NOTES.G4,
      decay: 3.2,
    });
    return samples;
  },

  /** 正解発表: 明るい和音（ド・ミ・ソ）を重ねる。 */
  'answer-reveal': () => {
    const samples = createSamples(1.4);
    addTone(samples, { startSec: 0, durationSec: 1.2, frequency: NOTES.C5, gain: 0.9, decay: 2.4 });
    addTone(samples, {
      startSec: 0.04,
      durationSec: 1.2,
      frequency: NOTES.E5,
      gain: 0.8,
      decay: 2.4,
    });
    addTone(samples, {
      startSec: 0.08,
      durationSec: 1.3,
      frequency: NOTES.G5,
      gain: 0.8,
      decay: 2.2,
    });
    addTone(samples, {
      startSec: 0.12,
      durationSec: 1.2,
      frequency: NOTES.C6,
      gain: 0.6,
      decay: 2.6,
    });
    return samples;
  },

  /** ランキング: 期待感のある上昇アルペジオ。 */
  ranking: () => {
    const samples = createSamples(1.8);
    const steps = [NOTES.C5, NOTES.E5, NOTES.G5, NOTES.C6, NOTES.E6];
    steps.forEach((frequency, index) => {
      addTone(samples, {
        startSec: index * 0.14,
        durationSec: 0.9,
        frequency,
        gain: 0.75,
        decay: 3.4,
      });
    });
    addTone(samples, {
      startSec: 0.7,
      durationSec: 1.05,
      frequency: NOTES.G6,
      gain: 0.5,
      decay: 2.8,
    });
    return samples;
  },

  /** 終了: 短いファンファーレ。最後の和音を長めに残す。 */
  finish: () => {
    const samples = createSamples(2.4);
    addTone(samples, { startSec: 0, durationSec: 0.35, frequency: NOTES.C5, gain: 0.85, decay: 4 });
    addTone(samples, {
      startSec: 0.2,
      durationSec: 0.35,
      frequency: NOTES.E5,
      gain: 0.85,
      decay: 4,
    });
    addTone(samples, {
      startSec: 0.4,
      durationSec: 0.4,
      frequency: NOTES.G5,
      gain: 0.85,
      decay: 4,
    });
    addTone(samples, {
      startSec: 0.62,
      durationSec: 1.7,
      frequency: NOTES.C4,
      gain: 0.5,
      decay: 1.6,
    });
    addTone(samples, {
      startSec: 0.62,
      durationSec: 1.7,
      frequency: NOTES.C5,
      gain: 0.8,
      decay: 1.6,
    });
    addTone(samples, {
      startSec: 0.66,
      durationSec: 1.7,
      frequency: NOTES.E5,
      gain: 0.7,
      decay: 1.6,
    });
    addTone(samples, {
      startSec: 0.7,
      durationSec: 1.7,
      frequency: NOTES.G5,
      gain: 0.7,
      decay: 1.6,
    });
    addTone(samples, {
      startSec: 0.74,
      durationSec: 1.6,
      frequency: NOTES.C6,
      gain: 0.55,
      decay: 1.8,
    });
    return samples;
  },
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

heading('投影用 効果音プレースホルダの生成');
info(
  color.dim('自家生成の正弦波です。本番用の音源へ差し替え、LICENSE.md へ出典を記録してください。'),
);

step(`出力先: ${OUTPUT_DIR}`);
mkdirSync(OUTPUT_DIR, { recursive: true });

const manifest = {};
let written = 0;
let skipped = 0;

for (const [name, build] of Object.entries(SOUNDS)) {
  const fileName = `${name}.wav`;
  const filePath = join(OUTPUT_DIR, fileName);
  manifest[name] = fileName;

  if (keepExisting && existsSync(filePath)) {
    warn(`${fileName} は既に存在するため残しました（--keep-existing）`);
    skipped += 1;
    continue;
  }

  const wav = encodeWav(normalize(build()));
  writeFileSync(filePath, wav);
  const seconds = (wav.length - 44) / 2 / SAMPLE_RATE;
  success(`${fileName} (${seconds.toFixed(2)}秒 / ${(wav.length / 1024).toFixed(0)}KB)`);
  written += 1;
}

step('manifest.json を更新');
const manifestPath = join(OUTPUT_DIR, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
success(`${manifestPath} を .wav の名前へ更新しました`);

console.log('');
console.log(
  `  ${color.green(`効果音プレースホルダを生成しました（作成 ${written} 件 / 据え置き ${skipped} 件）。`)}`,
);
console.log(
  `  ${color.dim('本番用の音源へ差し替えたら public/sounds/LICENSE.md の表を必ず埋めてください。')}\n`,
);
