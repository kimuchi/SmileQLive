/**
 * Firestore Security Rules 検証の共通基盤。
 *
 * `@firebase/rules-unit-testing` を **導入せずに**、素の Firebase SDK だけで
 * `firebase/firestore.rules` を実際のエミュレータへ適用した状態で検証する。
 *
 *   * 認証つきクライアント … `firebase`（Web SDK）+ Auth エミュレータの匿名サインイン
 *   * 種データの投入       … `firebase-admin`（Admin SDK は Rules を迂回するため書き込める）
 *
 * 実行は `scripts/test-rules.mjs`（firebase emulators:exec）から行う。
 * 直接 node で起動しても、エミュレータの環境変数が無ければ失敗する。
 */
import {
  deleteApp as deleteAdminApp,
  initializeApp as initializeAdminApp,
} from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, Timestamp } from 'firebase-admin/firestore';
import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore as getClientFirestore,
  setLogLevel,
  terminate,
} from 'firebase/firestore';

// この検証は「拒否されること」を大量に確かめるため、SDK が拒否のたびに出す
// GrpcConnection のエラーログで結果が埋もれる。判定は Promise の reject で行うので、
// SDK 自身のログは黙らせる（拒否の内訳は検証結果の行として出力する）。
setLogLevel('silent');

// ---------------------------------------------------------------------------
// エミュレータ接続
// ---------------------------------------------------------------------------

/** `127.0.0.1:8080` 形式を分解する。 */
function splitHostPort(value, label) {
  const withoutScheme = value.replace(/^https?:\/\//, '');
  const separator = withoutScheme.lastIndexOf(':');
  if (separator <= 0) {
    throw new Error(`${label} の形式が不正です: ${value}`);
  }
  const host = withoutScheme.slice(0, separator);
  const port = Number.parseInt(withoutScheme.slice(separator + 1), 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${label} のポート番号が不正です: ${value}`);
  }
  return { host, port };
}

/** エミュレータの接続情報。無ければ理由つきで例外にする。 */
export function readEmulatorConfig() {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

  if (!firestoreHost || !authHost) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST が設定されていません。' +
        ' このテストは `node scripts/test-rules.mjs` から実行してください。',
    );
  }

  return {
    projectId:
      process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? 'smileq-live-emulator',
    firestore: splitHostPort(firestoreHost, 'FIRESTORE_EMULATOR_HOST'),
    // Auth エミュレータは URL 形式で渡す必要がある。
    authUrl: authHost.startsWith('http') ? authHost : `http://${authHost}`,
  };
}

// ---------------------------------------------------------------------------
// 検証結果の記録
// ---------------------------------------------------------------------------

/** Firebase SDK のエラーコードを取り出す（想定外の形でも落ちないようにする）。 */
function errorCodeOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return error.code;
  }
  return String(error);
}

export function createReporter() {
  let passed = 0;
  let failed = 0;

  const line = (mark, kind, label, detail) => {
    const text = `${mark} [${kind}] ${label}${detail ? ` — ${detail}` : ''}`;
    if (mark === 'OK') {
      console.log(`  ${text}`);
    } else {
      console.error(`  ${text}`);
    }
  };

  return {
    /** 見出し。 */
    section(title) {
      console.log(`\n${title}`);
    },

    /**
     * 拒否されるべき操作。
     * **「期待どおり拒否されたか」を必ず明示して表示する。**
     */
    async denied(label, operation) {
      try {
        await operation();
        failed += 1;
        line('NG', '拒否されるはず', label, '拒否されず成功してしまった（情報が漏れる）');
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === 'permission-denied') {
          passed += 1;
          line('OK', '期待どおり拒否', label, 'permission-denied');
        } else {
          failed += 1;
          line('NG', '拒否されるはず', label, `別の理由で失敗した: ${code}`);
        }
      }
    },

    /** 許可されるべき操作。 */
    async allowed(label, operation) {
      try {
        await operation();
        passed += 1;
        line('OK', '期待どおり許可', label);
      } catch (error) {
        failed += 1;
        line('NG', '許可されるはず', label, `拒否された: ${errorCodeOf(error)}`);
      }
    },

    /** 任意の真偽条件。 */
    check(label, condition, detail) {
      if (condition) {
        passed += 1;
        line('OK', '確認', label);
      } else {
        failed += 1;
        line('NG', '確認', label, detail);
      }
    },

    get passed() {
      return passed;
    },
    get failed() {
      return failed;
    },
  };
}

// ---------------------------------------------------------------------------
// クライアント（ロールごとに独立した Firebase App を持たせる）
// ---------------------------------------------------------------------------

/**
 * 匿名サインイン済みのクライアントを 1 つ作る。
 *
 * @param {string} name  ロール名（アプリ名にも使う）
 * @param {{signIn: boolean}} options  signIn:false なら未認証のまま
 */
async function createClient(config, name, options = { signIn: true }) {
  const app = initializeClientApp(
    // エミュレータでは API キーの中身は検証されない（本番の値を持ち込まない）。
    { apiKey: 'emulator-api-key', projectId: config.projectId },
    `rules-${name}`,
  );

  const auth = getAuth(app);
  connectAuthEmulator(auth, config.authUrl, { disableWarnings: true });

  const db = getClientFirestore(app);
  connectFirestoreEmulator(db, config.firestore.host, config.firestore.port);

  let uid = null;
  if (options.signIn) {
    const credential = await signInAnonymously(auth);
    uid = credential.user.uid;
  }

  return {
    name,
    uid,
    db,
    async dispose() {
      await terminate(db).catch(() => {});
      await deleteClientApp(app).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// 種データ
// ---------------------------------------------------------------------------

export const IDS = {
  room: 'room-rules',
  otherRoom: 'room-rules-other',
  quiz: 'quiz-rules',
  otherQuiz: 'quiz-rules-other',
  /** otherHost が所有し、host へ共有しているクイズ。 */
  sharedQuiz: 'quiz-rules-shared',
  sharedQuestion: 'question-rules-shared',
  question: 'question-rules-1',
  choiceCorrect: 'choice-correct',
  choiceWrong: 'choice-wrong',
  asset: 'asset-rules-1',
  presentationLink: 'link-rules-1',
  drawList: 'draw-list-rules-1',
  drawEntry: 'draw-entry-rules-1',
};

/** `${questionId}__${participantId}`（src/types/firestore.ts の answerDocId と同じ規則）。 */
export function answerDocId(questionId, participantId) {
  return `${questionId}__${participantId}`;
}

/**
 * 検証用のデータを Admin SDK で作る。
 *
 * Admin SDK は Rules を迂回するため、ここでは「Rules が守るべき状態」を自由に作れる。
 * 正解・解説をあえて含めることで、「参加者がそこへ到達できない」ことを検証できる。
 */
async function seed(adminDb, roles) {
  const now = Timestamp.now();

  // 司会者だけが profiles を持つ（isStaffUser の条件）。
  for (const role of [roles.host, roles.otherHost]) {
    await adminDb.collection('profiles').doc(role.uid).set({
      uid: role.uid,
      email: null,
      displayName: null,
      hostedDomain: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // クイズ（正解・解説を含む）。参加者からは到達できてはいけない。
  await adminDb.collection('quizzes').doc(IDS.quiz).set({
    id: IDS.quiz,
    ownerId: roles.host.uid,
    title: 'Rules 検証用クイズ',
    description: null,
    status: 'published',
    showLeaderboard: true,
    soundTheme: 'default',
    questionCount: 1,
    choiceQuestionCount: 1,
    numberQuestionCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await adminDb
    .collection('quizzes')
    .doc(IDS.quiz)
    .collection('questions')
    .doc(IDS.question)
    .set({
      id: IDS.question,
      quizId: IDS.quiz,
      ownerId: roles.host.uid,
      position: 1,
      questionType: 'choice',
      questionText: '正解が漏れないことを確かめる問題',
      explanation: 'これは解説。参加者へ発表前に渡ってはいけない。',
      timeLimitSeconds: 20,
      points: 1000,
      choices: [
        { id: IDS.choiceWrong, position: 1, text: '不正解', isCorrect: false },
        { id: IDS.choiceCorrect, position: 2, text: '正解', isCorrect: true },
      ],
      numberMode: null,
      numberDecimalPlaces: 0,
      createdAt: now,
      updatedAt: now,
    });

  // 別の司会者が所有し、host へ共有しているクイズ。
  await adminDb.collection('quizzes').doc(IDS.sharedQuiz).set({
    id: IDS.sharedQuiz,
    ownerId: roles.otherHost.uid,
    sharedWith: [roles.host.uid],
    title: '共有されたクイズ',
    description: null,
    status: 'published',
    showLeaderboard: true,
    soundTheme: 'default',
    questionCount: 1,
    choiceQuestionCount: 1,
    numberQuestionCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await adminDb
    .collection('quizzes')
    .doc(IDS.sharedQuiz)
    .collection('questions')
    .doc(IDS.sharedQuestion)
    .set({
      id: IDS.sharedQuestion,
      quizId: IDS.sharedQuiz,
      ownerId: roles.otherHost.uid,
      position: 1,
      questionType: 'choice',
      questionText: '共有されたクイズの問題',
      explanation: '共有相手は読めるが、参加者は読めない。',
      timeLimitSeconds: 20,
      points: 1000,
      choices: [{ id: 'shared-choice', position: 1, text: 'A', isCorrect: true }],
      numberMode: null,
      numberDecimalPlaces: 0,
      createdAt: now,
      updatedAt: now,
    });

  await adminDb.collection('quizzes').doc(IDS.otherQuiz).set({
    id: IDS.otherQuiz,
    ownerId: roles.otherHost.uid,
    title: '別の司会者のクイズ',
    description: null,
    status: 'published',
    showLeaderboard: true,
    soundTheme: 'default',
    questionCount: 0,
    choiceQuestionCount: 0,
    numberQuestionCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await adminDb.collection('mediaAssets').doc(IDS.asset).set({
    id: IDS.asset,
    ownerId: roles.host.uid,
    bucket: 'emulator-bucket',
    objectPath: 'quiz/emulator.webp',
    mimeType: 'image/webp',
    byteSize: 1024,
    width: 100,
    height: 100,
    createdAt: now,
  });

  // 差し替えた効果音の設定。配信 ID が漏れると音を勝手に取られるので、所有者以外は読めてはいけない。
  await adminDb.collection('soundSettings').doc(roles.host.uid).set({
    ownerId: roles.host.uid,
    publicId: 'public-id-rules-1',
    sounds: {
      fanfare: {
        assetId: 'sound-rules-1',
        bucket: 'emulator-bucket',
        objectPath: `sounds/${roles.host.uid}/sound-rules-1.mp3`,
        mimeType: 'audio/mpeg',
        byteSize: 2048,
        originalName: 'fanfare.mp3',
        updatedAtMs: 1700000000000,
      },
    },
    updatedAt: now,
  });

  // 抽選リスト（名簿。氏名がそのまま並ぶので、所有者以外は読めてはいけない）。
  await adminDb.collection('drawLists').doc(IDS.drawList).set({
    id: IDS.drawList,
    ownerId: roles.host.uid,
    title: '社員名簿',
    kind: 'name',
    numberMin: null,
    numberMax: null,
    settings: {
      spinIntervalMs: 50,
      spinDurationMs: 2500,
      resultFontSize: 240,
      historyFontSize: 96,
      layout: 'board',
      backgroundAssetId: null,
      openingVideoUrl: null,
    },
    entryCount: 1,
    createdAt: now,
    updatedAt: now,
  });

  await adminDb
    .collection('drawLists')
    .doc(IDS.drawList)
    .collection('entries')
    .doc(IDS.drawEntry)
    .set({
      id: IDS.drawEntry,
      listId: IDS.drawList,
      position: 1,
      label: '山田太郎',
      imageAssetId: null,
      imageAlt: null,
      createdAt: now,
      updatedAt: now,
    });

  // ルーム本体（quizSnapshot に正解が入る）。
  const roomRef = adminDb.collection('rooms').doc(IDS.room);
  await roomRef.set({
    id: IDS.room,
    ownerId: roles.host.uid,
    quizId: IDS.quiz,
    joinTokenHash: 'f'.repeat(64),
    joinTokenRotatedAt: now,
    phase: 'question_open',
    currentQuestionId: IDS.question,
    currentQuestionPosition: 1,
    phaseStartedAt: now,
    answerDeadlineAt: Timestamp.fromMillis(Date.now() + 60_000),
    stateVersion: 3,
    joinOpen: true,
    maxParticipants: 200,
    participantCount: 2,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    quizSnapshot: {
      quizId: IDS.quiz,
      title: 'Rules 検証用クイズ',
      settings: { showLeaderboard: true, soundTheme: 'default', leaderboardSize: 10 },
      questions: [
        {
          id: IDS.question,
          type: 'choice',
          position: 1,
          text: '正解が漏れないことを確かめる問題',
          explanation: 'これは解説。参加者へ発表前に渡ってはいけない。',
          timeLimitSeconds: 20,
          points: 1000,
          choices: [
            { id: IDS.choiceWrong, position: 1, text: '不正解', isCorrect: false },
            { id: IDS.choiceCorrect, position: 2, text: '正解', isCorrect: true },
          ],
        },
      ],
    },
  });

  // 公開状態: 正解・問題文・選択肢を含めない。
  await roomRef
    .collection('public')
    .doc('state')
    .set({
      roomId: IDS.room,
      phase: 'question_open',
      stateVersion: 3,
      currentQuestionId: IDS.question,
      currentQuestionPosition: 1,
      totalQuestions: 1,
      answerDeadlineAt: Timestamp.fromMillis(Date.now() + 60_000),
      joinOpen: true,
      participantCount: 2,
      answeredCount: 1,
      updatedAt: now,
    });

  // 進捗: 司会・投影のみ。
  await roomRef.collection('staff').doc('progress').set({
    roomId: IDS.room,
    stateVersion: 3,
    participantCount: 2,
    onlineCount: 2,
    answeredCount: 1,
    breakdown: null,
    updatedAt: now,
  });

  const members = [
    { role: roles.host, kind: 'host', nickname: '司会' },
    { role: roles.presenter, kind: 'presenter', nickname: '投影' },
    { role: roles.participant, kind: 'participant', nickname: 'さくら' },
    { role: roles.otherParticipant, kind: 'participant', nickname: 'たろう' },
  ];

  for (const member of members) {
    await roomRef
      .collection('members')
      .doc(member.role.uid)
      .set({
        id: member.role.uid,
        roomId: IDS.room,
        authUserId: member.role.uid,
        role: member.kind,
        nickname: member.nickname,
        nicknameLower: member.nickname.toLowerCase(),
        joinedAt: now,
        lastSeenAt: now,
        isActive: true,
        totalPoints: member.kind === 'participant' ? 1000 : 0,
        correctCount: member.kind === 'participant' ? 1 : 0,
        correctElapsedMsTotal: member.kind === 'participant' ? 3200 : 0,
      });
  }

  // 回答（正誤・配点を含む）。本人だけが読めること。
  for (const participant of [roles.participant, roles.otherParticipant]) {
    await roomRef
      .collection('answers')
      .doc(answerDocId(IDS.question, participant.uid))
      .set({
        id: answerDocId(IDS.question, participant.uid),
        roomId: IDS.room,
        questionId: IDS.question,
        participantId: participant.uid,
        nickname: null,
        answerType: 'choice',
        choiceId: IDS.choiceCorrect,
        numberRaw: null,
        numberNormalized: null,
        answeredAt: now,
        elapsedMs: 3200,
        isCorrect: true,
        pointsAwarded: 1000,
      });
  }

  await roomRef.collection('events').doc('3').set({
    roomId: IDS.room,
    stateVersion: 3,
    eventType: 'open_question',
    payload: {},
    actorUserId: roles.host.uid,
    createdAt: now,
  });

  // 別の司会者のルーム。
  await adminDb
    .collection('rooms')
    .doc(IDS.otherRoom)
    .set({
      id: IDS.otherRoom,
      ownerId: roles.otherHost.uid,
      quizId: IDS.otherQuiz,
      joinTokenHash: 'e'.repeat(64),
      joinTokenRotatedAt: now,
      phase: 'lobby',
      currentQuestionId: null,
      currentQuestionPosition: null,
      phaseStartedAt: null,
      answerDeadlineAt: null,
      stateVersion: 0,
      joinOpen: true,
      maxParticipants: 200,
      participantCount: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      quizSnapshot: { quizId: IDS.otherQuiz, title: '別の司会者のクイズ', questions: [] },
    });

  // 投影リンク（トークンはハッシュのみ）。誰からも読めてはいけない。
  await adminDb
    .collection('presentationLinks')
    .doc(IDS.presentationLink)
    .set({
      id: IDS.presentationLink,
      roomId: IDS.room,
      tokenHash: 'd'.repeat(64),
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      consumedAt: null,
      createdBy: roles.host.uid,
      createdAt: now,
    });
}

// ---------------------------------------------------------------------------
// セットアップ / 後始末
// ---------------------------------------------------------------------------

/**
 * ロール別クライアントと種データを用意する。
 *
 * 匿名サインインで得た **実際の uid** を使って種データを作るため、
 * Rules の `request.auth.uid` 比較が本番と同じ経路で評価される。
 */
export async function setupRulesContext() {
  const config = readEmulatorConfig();

  const adminApp = initializeAdminApp({ projectId: config.projectId }, 'rules-admin');
  const adminDb = getAdminFirestore(adminApp);
  adminDb.settings({ ignoreUndefinedProperties: true });

  const roles = {
    /** ルーム・クイズの所有者。 */
    host: await createClient(config, 'host'),
    /** 別の司会者（他人のデータへ到達できないことの検証用）。 */
    otherHost: await createClient(config, 'other-host'),
    /** 投影担当（匿名認証 + role=presenter）。 */
    presenter: await createClient(config, 'presenter'),
    /** 参加者（匿名認証 + role=participant）。 */
    participant: await createClient(config, 'participant'),
    /** 別の参加者。 */
    otherParticipant: await createClient(config, 'other-participant'),
    /** ルームに参加していない匿名利用者。 */
    stranger: await createClient(config, 'stranger'),
    /** 未認証（サインインしていない）。 */
    anonymousUnauthenticated: await createClient(config, 'unauthenticated', { signIn: false }),
  };

  await seed(adminDb, roles);

  return {
    config,
    roles,
    adminDb,
    async dispose() {
      for (const role of Object.values(roles)) {
        await role.dispose();
      }
      await adminDb.terminate().catch(() => {});
      await deleteAdminApp(adminApp).catch(() => {});
    },
  };
}
