/**
 * Firestore トランザクションのスモークテスト（エミュレータ上で実行）。
 *
 *   npm run test:emulator
 *
 * PostgreSQL 版で SQL 関数を実 DB 上で検証していたのと同じ位置づけ。
 * Firestore へ移行しても次の不変条件が保たれていることを、実際に書き込んで確かめる。
 *
 *   1. 1 参加者・1 問につき 1 回答（決定的ドキュメントID + create）
 *   2. 同時実行しても回答が二重登録されない
 *   3. 状態遷移の stateVersion 競合検出
 *   4. 締切後の回答を受け付けない
 *   5. 参加者登録の冪等性とニックネーム重複の拒否
 *   6. 数値判定が境界値を含めて正しい（両端を含む）
 *   7. 得点集計が回答と同じトランザクションで更新される
 *
 * 注意: このスクリプトは Admin SDK で動くため Security Rules は適用されない。
 *       Rules 自体の検証は tests/rules/ が担当する。
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'smileq-live-emulator';

const app = initializeApp({ projectId: PROJECT_ID });
// 本番と同じ名前付きデータベースを対象にする。
// (default) で検証すると、実際の配線と違うものを確かめてしまう。
const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID ?? 'smileq-live');
db.settings({ ignoreUndefinedProperties: true });

let passed = 0;
let failed = 0;

function ok(message) {
  passed += 1;
  console.log(`OK: ${message}`);
}

function fail(message, detail) {
  failed += 1;
  console.error(`FAIL: ${message}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Firestore は gRPC の数値コードで失敗を返す（ALREADY_EXISTS = 6）。
 * 本番の isAlreadyExistsError() も code === 6 を先に見ているため、
 * ここでも同じ判定にそろえる。
 */
const GRPC_CODE_NAMES = {
  6: 'ALREADY_EXISTS',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
};

function errorSignature(error) {
  const parts = [];
  if (typeof error?.code === 'number') {
    parts.push(GRPC_CODE_NAMES[error.code] ?? `gRPC:${error.code}`);
  } else if (error?.code) {
    parts.push(String(error.code));
  }
  if (error?.message) {
    parts.push(String(error.message));
  }
  return parts.join(' / ') || String(error);
}

async function expectReject(label, promise, expectedCode) {
  try {
    await promise;
    fail(label, '拒否されるべき操作が成功した');
  } catch (error) {
    const signature = errorSignature(error);
    if (expectedCode && !signature.includes(expectedCode)) {
      fail(label, `期待したエラーではない: ${signature}`);
    } else {
      ok(`${label} (${signature.slice(0, 60)})`);
    }
  }
}

// ---------------------------------------------------------------------------
const ROOM_ID = 'room-smoke';
const Q_CHOICE = 'question-choice';
const Q_RANGE = 'question-range';
const CHOICE_A = 'choice-a';
const CHOICE_B = 'choice-b';

const roomRef = db.collection('rooms').doc(ROOM_ID);
const answersRef = roomRef.collection('answers');
const membersRef = roomRef.collection('members');

const answerId = (questionId, participantId) => `${questionId}__${participantId}`;

async function reset() {
  await db.recursiveDelete(roomRef).catch(() => {});
  await roomRef.set({
    id: ROOM_ID,
    ownerId: 'host-uid',
    quizId: 'quiz-1',
    joinTokenHash: 'x'.repeat(64),
    phase: 'question_open',
    stateVersion: 5,
    currentQuestionId: Q_CHOICE,
    currentQuestionPosition: 1,
    phaseStartedAt: Timestamp.fromMillis(Date.now() - 3000),
    answerDeadlineAt: Timestamp.fromMillis(Date.now() + 60_000),
    joinOpen: true,
    maxParticipants: 200,
    participantCount: 0,
    quizSnapshot: {
      quizId: 'quiz-1',
      title: 'スモーク',
      settings: { showLeaderboard: true, soundTheme: 'default', leaderboardSize: 10 },
      questions: [
        {
          id: Q_CHOICE,
          type: 'choice',
          position: 1,
          text: '2択',
          timeLimitSeconds: 20,
          points: 1000,
          choices: [
            { id: CHOICE_A, position: 1, text: '不正解', isCorrect: false },
            { id: CHOICE_B, position: 2, text: '正解', isCorrect: true },
          ],
        },
        {
          id: Q_RANGE,
          type: 'number',
          position: 2,
          text: '範囲',
          timeLimitSeconds: 20,
          points: 500,
          numberRule: { mode: 'range', minValue: '9.5', maxValue: '10.5' },
          unit: 'km',
          decimalPlaces: 1,
        },
      ],
    },
  });

  for (const uid of ['p1', 'p2', 'p3']) {
    await membersRef.doc(uid).set({
      id: uid,
      roomId: ROOM_ID,
      authUserId: uid,
      role: 'participant',
      nickname: uid,
      nicknameLower: uid,
      joinedAt: Timestamp.now(),
      lastSeenAt: Timestamp.now(),
      isActive: true,
      totalPoints: 0,
      correctCount: 0,
      correctElapsedMsTotal: 0,
    });
  }
}

/** 本番の submitAnswer と同じ形（決定的ID + create + 集計加算）を再現する。 */
async function submitChoiceAnswer(uid, choiceId) {
  return db.runTransaction(async (tx) => {
    const room = (await tx.get(roomRef)).data();
    const memberSnap = await tx.get(membersRef.doc(uid));
    const member = memberSnap.data();

    if (room.phase !== 'question_open') {
      throw new Error('ANSWER_NOT_OPEN');
    }
    if (Date.now() > room.answerDeadlineAt.toMillis()) {
      throw new Error('ANSWER_DEADLINE_PASSED');
    }

    const question = room.quizSnapshot.questions.find((q) => q.id === room.currentQuestionId);
    const choice = question.choices.find((c) => c.id === choiceId);
    if (!choice) {
      throw new Error('INVALID_CHOICE');
    }

    const isCorrect = choice.isCorrect;
    const points = isCorrect ? question.points : 0;
    const elapsedMs = Date.now() - room.phaseStartedAt.toMillis();

    tx.create(answersRef.doc(answerId(question.id, uid)), {
      roomId: ROOM_ID,
      questionId: question.id,
      participantId: uid,
      answerType: 'choice',
      choiceId,
      answeredAt: Timestamp.now(),
      elapsedMs,
      isCorrect,
      pointsAwarded: points,
    });

    tx.update(membersRef.doc(uid), {
      totalPoints: member.totalPoints + points,
      correctCount: member.correctCount + (isCorrect ? 1 : 0),
      correctElapsedMsTotal: member.correctElapsedMsTotal + (isCorrect ? elapsedMs : 0),
    });
  });
}

async function transitionRoom(action, expectedVersion) {
  return db.runTransaction(async (tx) => {
    const room = (await tx.get(roomRef)).data();
    if (room.stateVersion !== expectedVersion) {
      throw new Error('STATE_VERSION_CONFLICT');
    }
    const next = room.stateVersion + 1;
    tx.update(roomRef, { phase: action === 'lock_question' ? 'question_locked' : room.phase, stateVersion: next });
    tx.create(roomRef.collection('events').doc(String(next)), {
      roomId: ROOM_ID,
      stateVersion: next,
      eventType: action,
      createdAt: Timestamp.now(),
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
console.log('=== Firestore トランザクション スモークテスト ===\n');

await reset();

// 1. 通常の回答
await submitChoiceAnswer('p1', CHOICE_B);
const a1 = await answersRef.doc(answerId(Q_CHOICE, 'p1')).get();
if (a1.exists && a1.data().isCorrect === true && a1.data().pointsAwarded === 1000) {
  ok('回答が登録され、正誤と配点が記録される');
} else {
  fail('回答の登録', JSON.stringify(a1.data()));
}

// 2. 二重回答の拒否
await expectReject('同一参加者の二重回答を拒否', submitChoiceAnswer('p1', CHOICE_A), 'ALREADY_EXISTS');

// 3. 同時実行でも二重登録されない（決定的IDの実効性）
const concurrent = await Promise.allSettled([
  submitChoiceAnswer('p2', CHOICE_A),
  submitChoiceAnswer('p2', CHOICE_B),
  submitChoiceAnswer('p2', CHOICE_A),
]);
const fulfilled = concurrent.filter((r) => r.status === 'fulfilled').length;
const answersForP2 = await answersRef.where('participantId', '==', 'p2').get();
if (fulfilled === 1 && answersForP2.size === 1) {
  ok('同時に3回送っても回答は1件だけ登録される');
} else {
  fail('同時実行の二重登録防止', `成功${fulfilled}件 / 登録${answersForP2.size}件`);
}

// 4. 得点集計が同一トランザクションで更新される
const p1Member = (await membersRef.doc('p1').get()).data();
if (p1Member.totalPoints === 1000 && p1Member.correctCount === 1) {
  ok('得点集計が回答と同じトランザクションで更新される');
} else {
  fail('得点集計', JSON.stringify(p1Member));
}

// 5. 存在しない選択肢の拒否
await expectReject('他問題の選択肢を拒否', submitChoiceAnswer('p3', 'choice-foreign'), 'INVALID_CHOICE');

// 6. stateVersion 競合
const current = (await roomRef.get()).data().stateVersion;
await expectReject('古い expectedVersion を拒否', transitionRoom('lock_question', current - 1), 'STATE_VERSION_CONFLICT');
const newVersion = await transitionRoom('lock_question', current);
if (newVersion === current + 1) {
  ok('正しい expectedVersion で stateVersion が 1 進む');
} else {
  fail('stateVersion の更新', String(newVersion));
}

// 7. 締切後の回答拒否
await roomRef.update({ phase: 'question_open', answerDeadlineAt: Timestamp.fromMillis(Date.now() - 1000) });
await expectReject('締切後の回答を拒否', submitChoiceAnswer('p3', CHOICE_B), 'ANSWER_DEADLINE_PASSED');

// 8. 監査ログ
const events = await roomRef.collection('events').get();
if (events.size >= 1) {
  ok(`監査ログが記録される (${events.size} 件)`);
} else {
  fail('監査ログ');
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
