#!/usr/bin/env node
/**
 * 動作確認用のデモクイズを作成する。
 *
 *   npm run seed:demo                     … 設定ファイルから対象を判定して作成
 *   npm run seed:demo -- --project my-proj
 *   npm run seed:demo -- --owner you@example.com   … 所有者を指定
 *   npm run seed:demo -- --replace        … 同名のデモクイズを作り直す
 *   npm run seed:demo -- --cleanup-stray  … 誤ってトップレベルへ書かれた問題を削除する
 *
 * 収録する問題（型を一通り網羅する）:
 *   1. 2 択                       … 問題画像 + 解説画像
 *   2. 3 択                       … 文章のみ
 *   3. 4 択                       … 選択肢がすべて画像（代替テキスト必須の例）
 *   4. 数値 / 完全一致            … 単位あり
 *   5. 数値 / 許容誤差            … ±50
 *   6. 数値 / 範囲指定            … 380〜430
 *
 * 画像は第三者素材を使わず、その場で SVG から描き起こす（scripts/lib/demo-images.mjs）。
 *
 * 認証は Admin SDK の ADC。事前に済ませておくこと。
 *   gcloud auth application-default login
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { configExists, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { confirmYesNo, isInteractive } from './lib/prompt.mjs';
import { PALETTE, questionImage, revealImage, shapeChoiceImage } from './lib/demo-images.mjs';
import {
  DEMO_DESCRIPTION,
  DEMO_MEDIA,
  DEMO_TITLE,
  questionsPath,
  toDomainQuestions,
} from './lib/demo-quiz.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { flags } = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 対象の解決（host-admin.mjs と同じ規則）
// ---------------------------------------------------------------------------
function readConfigFile() {
  const available = ENVIRONMENTS.filter(configExists);
  const target =
    (typeof flags.get('env') === 'string' ? flags.get('env') : '') ||
    (available.length === 1 ? available[0] : available.includes('production') ? 'production' : '');
  if (!target) {
    return null;
  }
  const path = new URL(`../deploy/cloud-run.${target}.json`, import.meta.url);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const config = readConfigFile();

const projectId =
  (typeof flags.get('project') === 'string' ? flags.get('project') : '') ||
  process.env.FIREBASE_PROJECT_ID ||
  config?.firebaseProjectId ||
  config?.projectId ||
  '';

const databaseId =
  (typeof flags.get('database') === 'string' ? flags.get('database') : '') ||
  process.env.FIRESTORE_DATABASE_ID ||
  config?.firestoreDatabaseId ||
  'smileq-live';

const bucketName =
  (typeof flags.get('bucket') === 'string' ? flags.get('bucket') : '') ||
  process.env.MEDIA_BUCKET ||
  config?.mediaBucket ||
  '';

if (!projectId) {
  fatal(
    'Firebase プロジェクト ID を特定できません。',
    '--project で指定するか、deploy/cloud-run.<env>.json を用意してください。',
  );
}
if (!bucketName) {
  fatal(
    '画像用バケットを特定できません。',
    '--bucket で指定するか、設定ファイルの mediaBucket を確認してください。',
  );
}

heading('デモクイズを作成');
info(`プロジェクト  : ${projectId}`);
info(`データベース  : ${databaseId}`);
info(`バケット      : ${bucketName}`);

// ---------------------------------------------------------------------------
// Admin SDK
// ---------------------------------------------------------------------------
const { getApps, initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { getStorage } = await import('firebase-admin/storage');

const app = getApps().length > 0 ? getApps()[0] : initializeApp({ projectId, storageBucket: bucketName });
const db = getFirestore(app, databaseId);
const auth = getAuth(app);
const bucket = getStorage(app).bucket(bucketName);

/** 問題のサブコレクション（quizzes/{quizId}/questions）。 */
function questionsRef(id) {
  const [root, docId, sub] = questionsPath(id);
  return db.collection(root).doc(docId).collection(sub);
}

// ---------------------------------------------------------------------------
// 以前のバージョンはトップレベルの `questions` へ書いていた。
// アプリは quizzes/{quizId}/questions を読むため、その分は使われないまま残る。
// 消しても現在の動作には影響しないので、掃除だけを行う入口を用意する。
if (flags.has('cleanup-stray')) {
  heading('誤った場所に残った問題を削除');
  const strays = await db.collection('questions').get();
  if (strays.empty) {
    success('トップレベルの questions は空です。掃除は不要です。');
    process.exit(0);
  }
  info(`トップレベルの questions に ${strays.size} 件あります。`);
  const proceed =
    flags.has('yes') || !isInteractive() ? true : await confirmYesNo('削除しますか？', true);
  if (!proceed) {
    warn('中止しました。');
    process.exit(0);
  }
  for (const doc of strays.docs) {
    await doc.ref.delete();
  }
  success(`${strays.size} 件を削除しました。`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
step('対象の司会者を決定');

/**
 * デモクイズを入れる相手。
 *
 * クイズは所有者ごとに分かれており、他人のクイズは一覧に出ない
 * （quiz-repository.ts の listQuizIds が ownerId で絞る）。
 * 共有のしくみが無いため、全員に配るには**人数分の複製を作る**しかない。
 * 既定は「登録済みの司会者全員」。--owner で相手を絞れる。
 */
async function resolveOwners() {
  const raw = typeof flags.get('owner') === 'string' ? flags.get('owner') : '';
  const emails = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (emails.length > 0) {
    const owners = [];
    for (const email of emails) {
      const user = await auth.getUserByEmail(email);
      const profile = await db.collection('profiles').doc(user.uid).get();
      if (!profile.exists) {
        fatal(
          `${email} は司会者として登録されていません。`,
          `先に登録してください:\n  npm run host:add -- ${email} --name "表示名"`,
        );
      }
      owners.push({ uid: user.uid, label: email });
    }
    return owners;
  }

  const snapshot = await db.collection('profiles').get();
  if (snapshot.empty) {
    fatal(
      '司会者が 1 人も登録されていません。',
      [
        '先に登録してください:',
        '  npm run host:add -- you@example.com --name "あなたの名前"',
        '',
        `対象データベース: ${databaseId}`,
      ].join('\n'),
    );
  }
  return snapshot.docs.map((doc) => ({
    uid: doc.id,
    label: doc.data().email ?? doc.data().displayName ?? doc.id,
  }));
}

const owners = await resolveOwners();
success(`対象の司会者: ${owners.length} 名`);
for (const owner of owners) {
  console.log(`    ${owner.label}`);
}

// ---------------------------------------------------------------------------
step('画像を生成');

/** DEMO_MEDIA の定義どおりに画像を作る。 */
async function renderMedia(spec) {
  const paletteOf = (name) => PALETTE[name] ?? name;
  if (spec.kind === 'question') {
    return questionImage({
      title: spec.title,
      subtitle: spec.subtitle ?? '',
      from: paletteOf(spec.palette[0]),
      to: paletteOf(spec.palette[1] ?? spec.palette[0]),
      illustration: spec.illustration,
    });
  }
  if (spec.kind === 'reveal') {
    return revealImage({
      answer: spec.answer,
      note: spec.note ?? '',
      color: paletteOf(spec.palette[0]),
    });
  }
  return shapeChoiceImage(spec.shape, paletteOf(spec.palette[0]));
}

// 画像は所有者に依存しないので 1 回だけ描く。アップロードだけ人数分行う。
const rendered = new Map();
for (const [key, spec] of Object.entries(DEMO_MEDIA)) {
  rendered.set(key, await renderMedia(spec));
}
const totalBytes = [...rendered.values()].reduce((sum, item) => sum + item.info.size, 0);
success(`${rendered.size} 枚（合計 ${Math.round(totalBytes / 1024)} KB）`);

// ---------------------------------------------------------------------------
/** 1 人分のデモクイズを作る。 */
async function seedFor(owner) {
  const ownerId = owner.uid;

  // 既存のデモクイズ（同じ所有者・同じ題名）を確認する。
  const existing = await db
    .collection('quizzes')
    .where('ownerId', '==', ownerId)
    .where('title', '==', DEMO_TITLE)
    .get();

  if (!existing.empty) {
    // 既にあるものが「使える状態か」を先に見る。
    // 壊れている（問題が読めない）場合は、確認を待たずに作り直す。
    // 以前トップレベルの questions へ書いていた分がこれに当たり、
    // 作り直さないと「問題を1問以上作成してください」が消えない。
    let broken = false;
    for (const doc of existing.docs) {
      const stored = await questionsRef(doc.id).get();
      if (stored.empty) {
        broken = true;
      }
    }

    if (!replaceExisting && !broken) {
      info(`${owner.label}: 既にあります（作り直すには --replace）`);
      return { owner, skipped: true };
    }
    if (broken && !replaceExisting) {
      warn(`${owner.label}: 既存のデモクイズから問題を読めません。作り直します。`);
    }
    for (const doc of existing.docs) {
      // 問題 → 画像 → クイズ の順に消す（参照が残らないようにする）。
      const questions = await questionsRef(doc.id).get();
      for (const question of questions.docs) {
        await question.ref.delete();
      }
      // 以前のバージョンがトップレベルの questions へ書いていた分も片付ける。
      const strays = await db.collection('questions').where('quizId', '==', doc.id).get();
      for (const stray of strays.docs) {
        await stray.ref.delete();
      }
      const assets = await db.collection('mediaAssets').where('ownerId', '==', ownerId).get();
      for (const asset of assets.docs) {
        const objectPath = asset.data().objectPath ?? '';
        if (objectPath.includes(`/${doc.id}/`)) {
          await bucket.file(objectPath).delete({ ignoreNotFound: true });
          await asset.ref.delete();
        }
      }
      await doc.ref.delete();
    }
  }

  const quizId = randomUUID();

  /**
   * 生成済みの画像を Storage へ置き、mediaAssets を作る。
   * 保存パスはアプリ本体と同じ規則（buildObjectPath）に合わせる。
   * 画像は所有者ごとに複製する（所有者が認可の単位になっているため共有しない）。
   */
  async function putImage(result) {
    const assetId = randomUUID();
    const objectPath = `${ownerId}/${quizId}/${assetId}.webp`;

    await bucket.file(objectPath).save(result.data, {
      resumable: false,
      contentType: 'image/webp',
      metadata: { cacheControl: 'private, max-age=31536000, immutable' },
    });

    await db.collection('mediaAssets').doc(assetId).set({
      id: assetId,
      ownerId,
      bucket: bucketName,
      objectPath,
      mimeType: 'image/webp',
      byteSize: result.info.size,
      width: result.info.width,
      height: result.info.height,
      createdAt: Timestamp.now(),
    });
    return assetId;
  }

  const mediaByKey = new Map();
  for (const [key, result] of rendered.entries()) {
    mediaByKey.set(key, {
      assetId: await putImage(result),
      url: '',
      width: result.info.width,
      height: result.info.height,
    });
  }

  // 公開検証と同じ定義から問題を組み立てる（tests/unit/scripts/demo-quiz.test.ts が検証済み）。
  const domainQuestions = toDomainQuestions((key) => {
    const asset = mediaByKey.get(key);
    if (!asset) {
      fatal(`画像キーが見つかりません: ${key}`);
    }
    return asset;
  });

  const questions = domainQuestions.map((question) => {
    const now = Timestamp.now();
    const isChoice = question.type === 'choice';
    const rule = isChoice ? null : question.numberRule;

    return {
      id: randomUUID(),
      quizId,
      ownerId,
      position: question.position,
      questionType: question.type,
      questionText: question.text,
      questionImageAssetId: question.image?.assetId ?? null,
      questionImageAlt: question.image?.alt ?? null,
      revealImageAssetId: question.revealImage?.assetId ?? null,
      revealImageAlt: question.revealImage?.alt ?? null,
      explanation: question.explanation,
      timeLimitSeconds: question.timeLimitSeconds,
      points: question.points,
      choices: isChoice
        ? question.choices.map((choice) => ({
            id: randomUUID(),
            position: choice.position,
            text: choice.text,
            imageAssetId: choice.image?.assetId ?? null,
            imageAlt: choice.image?.alt ?? null,
            isCorrect: choice.isCorrect,
          }))
        : [],
      numberMode: rule?.mode ?? null,
      numberCorrectValue: rule && 'correctValue' in rule ? rule.correctValue : null,
      numberTolerance: rule && 'tolerance' in rule ? rule.tolerance : null,
      numberMinValue: rule && 'minValue' in rule ? rule.minValue : null,
      numberMaxValue: rule && 'maxValue' in rule ? rule.maxValue : null,
      numberUnit: isChoice ? null : question.unit,
      numberDecimalPlaces: isChoice ? 0 : question.decimalPlaces,
      createdAt: now,
      updatedAt: now,
    };
  });

  const now = Timestamp.now();
  const batch = db.batch();

  batch.set(db.collection('quizzes').doc(quizId), {
    id: quizId,
    ownerId,
    title: DEMO_TITLE,
    description: DEMO_DESCRIPTION,
    status: 'published',
    showLeaderboard: true,
    soundTheme: 'default',
    questionCount: questions.length,
    choiceQuestionCount: questions.filter((q) => q.questionType === 'choice').length,
    numberQuestionCount: questions.filter((q) => q.questionType === 'number').length,
    createdAt: now,
    updatedAt: now,
  });

  for (const question of questions) {
    batch.set(questionsRef(quizId).doc(question.id), question);
  }

  await batch.commit();

  const inspection = await inspect(quizId, questions.length);
  return { owner, quizId, questions, inspection, skipped: false };
}

/**
 * ルーム作成時に効くのは「Firestore に何が入っているか」だけ。
 * 書いたつもりの値ではなく、実際に読める値を確かめる。
 *
 * ルーム作成は公開検証をやり直すため、ここが欠けていると
 * 「公開条件を満たしていません」で止まる。
 */
async function inspect(quizId, expectedCount) {
  const problems = [];

  // アプリと同じ場所（quizzes/{quizId}/questions）から読む。
  // ここを別の場所にすると、点検が自分の書き間違いを追認してしまう。
  const storedQuestions = await questionsRef(quizId).get();
  if (storedQuestions.size !== expectedCount) {
    problems.push(`問題が ${storedQuestions.size} 件しか読めません（期待 ${expectedCount} 件）`);
  }

  const referenced = new Set();
  for (const doc of storedQuestions.docs) {
    const data = doc.data();
    for (const id of [data.questionImageAssetId, data.revealImageAssetId]) {
      if (id) referenced.add(id);
    }
    for (const choice of data.choices ?? []) {
      if (choice.imageAssetId) referenced.add(choice.imageAssetId);
    }
  }

  const assetIds = [...referenced];
  const assetDocs =
    assetIds.length > 0
      ? await db.getAll(...assetIds.map((id) => db.collection('mediaAssets').doc(id)))
      : [];
  const foundAssets = new Set(
    assetDocs
      // getAssetRefs と同じ条件（id / bucket / objectPath が揃っていること）。
      .filter((doc) => {
        const data = doc.data();
        return data && data.id && data.bucket && data.objectPath;
      })
      .map((doc) => doc.id),
  );

  for (const id of assetIds) {
    if (!foundAssets.has(id)) {
      problems.push(`画像 ${id} の mediaAssets が読めません`);
    }
  }

  // 文章を持たない選択肢は、画像と代替テキストの両方が必要。
  for (const doc of storedQuestions.docs) {
    const data = doc.data();
    for (const choice of data.choices ?? []) {
      const hasText = typeof choice.text === 'string' && choice.text.trim().length > 0;
      if (hasText) continue;
      if (!choice.imageAssetId || !foundAssets.has(choice.imageAssetId)) {
        problems.push(`第${data.position}問の選択肢に文章も画像もありません`);
      } else if (!choice.imageAlt || String(choice.imageAlt).trim().length === 0) {
        problems.push(`第${data.position}問の画像だけの選択肢に代替テキストがありません`);
      }
    }
  }

  return { problems, questionCount: storedQuestions.size, assetCount: foundAssets.size };
}

// ---------------------------------------------------------------------------
step('デモクイズを作成');

const replaceExisting =
  flags.has('replace') ||
  flags.has('yes') ||
  !isInteractive() ||
  false;

const results = [];
for (const owner of owners) {
  const result = await seedFor(owner);
  results.push(result);
  if (result.skipped) {
    continue;
  }
  if (result.inspection.problems.length === 0) {
    success(
      `${owner.label}: 問題 ${result.inspection.questionCount} 件 / 画像 ${result.inspection.assetCount} 件`,
    );
  } else {
    warn(`${owner.label}: 読み直しで問題が見つかりました`);
    for (const problem of result.inspection.problems) {
      console.log(`      ${problem}`);
    }
  }
}

const created = results.filter((result) => !result.skipped);
const skipped = results.filter((result) => result.skipped);

// ---------------------------------------------------------------------------
heading('結果');
console.log(`  作成: ${created.length} 名 / 既存のまま: ${skipped.length} 名`);
if (skipped.length > 0) {
  console.log('');
  info('既にある分を作り直す場合:');
  console.log('    npm run seed:demo -- --replace');
}

if (created.length > 0) {
  console.log('');
  console.log('  収録している問題:');
  for (const question of created[0].questions) {
    const kind =
      question.questionType === 'choice'
        ? `${question.choices.length} 択`
        : `数値 / ${{ exact: '完全一致', absolute_tolerance: '許容誤差', range: '範囲指定' }[question.numberMode]}`;
    console.log(
      `    ${String(question.position).padStart(2)}. ${color.bold(kind.padEnd(14))} ${question.questionText ?? ''}`,
    );
  }
}

console.log('');
info('クイズは所有者ごとに分かれています（他人のクイズは一覧に出ません）。');
info('あとから司会者を追加したときは、もう一度このコマンドを実行してください。');
console.log('');
info('次の手順:');
console.log('  1. 管理画面でルームを作成する');
console.log(`       ${config?.appBaseUrl ?? ''}/admin/quizzes`);
console.log('  2. 投影画面を開く（効果音はこの画面だけで鳴ります）');
console.log('  3. 二次元コードを読んで参加者として入る');
console.log('');
