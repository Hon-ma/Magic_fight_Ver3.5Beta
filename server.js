// 3D Magic FPS Duel - Ver6
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Redis } = require('@upstash/redis');
const quest = require('./quest');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS_PER_ROOM = 4;

// 遅延補償（巻き戻し）の最大許容時間 (ミリ秒)
// これ以上の遅延があるプレイヤーの弾は巻き戻さず「ノーレジ（却下）」にする
const MAX_REWIND_MS = 200;
const HISTORY_DURATION_MS = 1500;

// --- レート戦設定 ---
const RATE_KILLS_TO_WIN = 3;
const DEFAULT_RATE = 1000;
const RATE_MATCH_MEMBERS = 2; // レート戦は完全1vs1
// 切断（切断側の反則負け）時、レート変動計算とは別に切断者へ追加で科すペナルティ
const DISCONNECT_PENALTY = 10;

// ================================================================
// --- コイン経済 設定（Phase1）---
// 金額感は「叩き台の仮数値」。設計書(gear_power_design.md)の1-1節に準拠。
// レート戦限定（フリーバトルはコイン対象外）で運用する。
// ================================================================
const COIN_RATE_WIN = 600;
const COIN_RATE_LOSS = 250;
const COIN_PER_KILL = 50;
const COIN_MAX_KILLS_FOR_BONUS = RATE_KILLS_TO_WIN; // 1試合あたりのキルボーナス対象上限（=3キル分まで）
const COIN_EX_ULT_BONUS = 100; // EX ULTを1回でも発動した試合につき1回だけ加算
const COIN_DISCONNECT_PENALTY_OVERRIDE = 0; // 切断による反則負けは戦績に関わらずコイン0

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ================================================================
// --- Ver5: プレイヤープロフィール永続化ストア ---
// プレイヤーはブラウザ側で発行されるUUID(clientId)で識別する。
// セットコメント(9個)・戦績・コイン/ショップ/ガチャ/ギア情報をJSONファイルに保存し、
// サーバー再起動をまたいでも保持されるようにする。
// ================================================================
const PROFILE_DB_PATH = path.join(__dirname, 'profiles.json');
const PROFILE_SAVE_DEBOUNCE_MS = 2000;
const REDIS_PROFILE_KEY = 'magicfight:profiles';

// Upstash Redis（REST API方式・接続維持不要でRenderのスリープと相性が良い）。
// 環境変数が無い場合はnullのままにし、ローカルファイル保存のみで動作させる
// （開発環境やUpstash未設定時のフォールバック）。
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;
if (!redis) {
  console.warn('[profiles] UPSTASH_REDIS_REST_URL/TOKEN が未設定のため、ローカルファイル保存のみで動作します。');
}

// ================================================================
// --- ショップ（Phase2）：通常弾・ULT・戦術タイプの買い切り購入 ---
// 購入判定は全てサーバー側で行い、クライアントの申告は信用しない。
// 価格は設計書(gear_power_design.md)2-1節の指定額。
// ================================================================
const VALID_SHOT_IDS = ['magic', 'sniper', 'heavy', 'bomb', 'ricochet'];
const VALID_ULT_IDS = ['beam', 'shield', 'curse', 'super', 'warp', 'heal', 'upgrade', 'highjump', 'thunder'];
// 戦術タイプIDは `${ultId}_A` / `${ultId}_B` の形式（全18種）
const VALID_TACTIC_IDS = VALID_ULT_IDS.flatMap(u => [`${u}_A`, `${u}_B`]);

const SHOP_PRICE_SHOT = 3000;
const SHOP_PRICE_ULT = 5000;
const SHOP_PRICE_ULT_RANDOM = 3500;
const SHOP_PRICE_TACTIC = 2000;

// 新規プレイヤーの初期所持（Phase2：既存プレイヤーもこの条件にリセットされる）
const INITIAL_SHOT_IDS = ['magic'];
const INITIAL_ULT_IDS = ['beam'];

// ================================================================
// --- ガチャ（Phase3）---
// 設計書(gear_power_design.md)3章に準拠。
// 排出内容は「破片95% / 通常弾0.8% / ULT0.5% / 戦術0.7% / 完成ギア3%」の重み付き抽選。
// 抽選は必ずサーバー側の Math.random() で行い、結果だけをクライアントへ返す。
// ================================================================
const GEAR_IDS = Array.from({ length: 20 }, (_, i) => `gear${String(i + 1).padStart(2, '0')}`);
quest.configure({ gearIds: GEAR_IDS });

// ================================================================
// --- ギアスロット装備（Phase4）---
// 設計書4章に準拠。メインギアの種類でサブスロット数（1〜3）が決まる。
// subOnly=true のギアはサブスロットに置けず、メインにのみ装備できる。
// mainSubSlots はクライアント側 GEAR_MASTER と同じ値を保持する（表示名はサーバー側では不要）。
// ================================================================
const GEAR_META = {
  gear01: { mainSubSlots: 3, subOnly: false },
  gear02: { mainSubSlots: 3, subOnly: false },
  gear03: { mainSubSlots: 3, subOnly: false },
  gear04: { mainSubSlots: 3, subOnly: false },
  gear05: { mainSubSlots: 3, subOnly: false },
  gear06: { mainSubSlots: 3, subOnly: false },
  gear07: { mainSubSlots: 2, subOnly: false },
  gear08: { mainSubSlots: 2, subOnly: false },
  gear09: { mainSubSlots: 3, subOnly: false },
  gear10: { mainSubSlots: 3, subOnly: false },
  gear11: { mainSubSlots: 1, subOnly: false },
  gear12: { mainSubSlots: 2, subOnly: false },
  gear13: { mainSubSlots: 3, subOnly: false },
  gear14: { mainSubSlots: 3, subOnly: false },
  gear15: { mainSubSlots: 2, subOnly: true },
  gear16: { mainSubSlots: 3, subOnly: true },
  gear17: { mainSubSlots: 1, subOnly: true },
  gear18: { mainSubSlots: 2, subOnly: true },
  gear19: { mainSubSlots: 2, subOnly: true },
  gear20: { mainSubSlots: 2, subOnly: true } // スポーンチャージ（旧コンボチャージから置き換え。効果はクライアント側で処理）
};

// 装備コスト・キャッシュバック（バランス調整済み：1-1節のコイン収入を基準に算出）
const GEAR_MAIN_EQUIP_COST = 1000;
const GEAR_SUB_EQUIP_COST = 500;
const GEAR_UNEQUIP_FRAGMENT_CASHBACK = 3; // 外す（消滅させる）と破片3個が戻る
const GACHA_COST = 300;
const GACHA_PITY_MAX = 30;                 // 30連ごとに天井
const GACHA_PITY_UNIVERSAL_REWARD = 3;     // 天井到達で万能破片3個（通常の抽選結果に加えて付与）
const GACHA_FRAGMENTS_PER_GEAR = 10;       // 破片10個で完成ギア1個
const GACHA_FRAGMENT_XY_DIST = [[1, 0.50], [2, 0.25], [3, 0.13], [4, 0.08], [5, 0.04]];

// 排出テーブルの基礎重み。実際の抽選時は、shot/ult/tacticのいずれかが
// 「全種所持済み（コンプ）」であれば、そのカテゴリの重みを0にして
// 丸ごとfragmentへ上乗せする。
const GACHA_BASE_WEIGHTS = { fragment: 95.0, shot: 0.8, ult: 0.5, tactic: 0.7, gear: 3.0 };

// プロフィールの所持状況を見て、コンプ済みカテゴリの重みをfragmentへ再配分した
// 実効の排出テーブルを組み立てる。合計は常に100.0のまま変わらない。
function computeGachaWeights(profile) {
  const w = { ...GACHA_BASE_WEIGHTS };
  if (VALID_SHOT_IDS.every(id => profile.unlockedShots.includes(id))) {
    w.fragment += w.shot; w.shot = 0;
  }
  if (VALID_ULT_IDS.every(id => profile.unlockedUlts.includes(id))) {
    w.fragment += w.ult; w.ult = 0;
  }
  if (VALID_TACTIC_IDS.every(id => profile.unlockedTactics.includes(id))) {
    w.fragment += w.tactic; w.tactic = 0;
  }
  return w;
}

function pickWeightedFromMap(weights) {
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const [kind, w] of Object.entries(weights)) {
    if (r < w) return kind;
    r -= w;
  }
  // 浮動小数点誤差の保険：重みが残っている最後のカテゴリを返す
  const remaining = Object.keys(weights).filter(k => weights[k] > 0);
  return remaining[remaining.length - 1] || 'fragment';
}

// 破片を加算し、10個貯まるごとに完成ギアへ変換する（余りは繰り越し）。
// 例：既に7個持っている状態で+5個入手 → 12個 → 完成+1、繰り越し2個。
function addGearFragments(profile, gearId, amount) {
  if (!profile.gearFragments[gearId]) profile.gearFragments[gearId] = 0;
  profile.gearFragments[gearId] += amount;
  let completed = 0;
  while (profile.gearFragments[gearId] >= GACHA_FRAGMENTS_PER_GEAR) {
    profile.gearFragments[gearId] -= GACHA_FRAGMENTS_PER_GEAR;
    if (!profile.completedGear[gearId]) profile.completedGear[gearId] = 0;
    profile.completedGear[gearId] += 1;
    completed += 1;
  }
  return completed; // このアクションで新たに完成した個数
}

// 装備中のギア1個を外す（＝消滅させて破片キャッシュバックする）共通処理。
// 明示的な「外す」操作でも、メイン切替に伴う自動退避でも同じ処理を使う。
function destroyEquippedGear(profile, gearId) {
  return addGearFragments(profile, gearId, GEAR_UNEQUIP_FRAGMENT_CASHBACK);
}

// 1回分の抽選結果を計算し、profileへ直接反映する（コイン消費は呼び出し側の責務）。
// shot/ult/tacticのいずれかがコンプ済みなら、そのカテゴリは抽選対象から除外される。
function pickGachaFragmentXY() {
  const choose = () => {
    const r = Math.random();
    let acc = 0;
    for (const [value, weight] of GACHA_FRAGMENT_XY_DIST) {
      acc += weight;
      if (r < acc) return value;
    }
    return GACHA_FRAGMENT_XY_DIST[GACHA_FRAGMENT_XY_DIST.length - 1][0];
  };
  return { x: choose(), y: choose() };
}

function sampleDistinctGearIds(count) {
  const pool = [...GEAR_IDS];
  const selected = [];
  while (selected.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

function classifyGachaRarity(x, y) {
  const sum = x + y;
  return sum >= 10 ? 'super' : sum >= 7 ? 'great' : sum >= 5 ? 'hit' : 'normal';
}

// 1回分の抽選結果を計算し、profileへ直接反映する（コイン消費は呼び出し側の責務）。
// 破片枠はX/Y方式：1〜5種類のギアを重複なしで選び、各ギアへY個ずつ付与する。
function runGachaPull(profile) {
  const weights = computeGachaWeights(profile);
  const kind = pickWeightedFromMap(weights);
  const detail = { kind };

  if (kind === 'fragment') {
    const { x, y } = pickGachaFragmentXY();
    const gearIds = sampleDistinctGearIds(x);
    let completedGained = 0;
    for (const gearId of gearIds) {
      completedGained += addGearFragments(profile, gearId, y);
    }
    Object.assign(detail, {
      x,
      y,
      gearIds,
      totalPieces: x * y,
      className: classifyGachaRarity(x, y),
      completedGained
    });
  } else if (kind === 'shot') {
    const candidates = VALID_SHOT_IDS.filter(id => !profile.unlockedShots.includes(id));
    // computeGachaWeightsで既に除外されているはずだが、万一の不整合に備えた保険。
    // 報酬を捏造せず、破片1個の当たりとして処理する（見た目上は「はずれ枠が無い」ことを保つ）。
    if (candidates.length === 0) {
      const { x, y } = { x: 1, y: 1 };
      const gearIds = sampleDistinctGearIds(x);
      let completedGained = 0;
      for (const gearId of gearIds) completedGained += addGearFragments(profile, gearId, y);
      Object.assign(detail, { kind: 'fragment', x, y, gearIds, totalPieces: x * y, className: classifyGachaRarity(x, y), completedGained });
    } else {
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      profile.unlockedShots.push(id);
      Object.assign(detail, { grantedId: id });
    }
  } else if (kind === 'ult') {
    const candidates = VALID_ULT_IDS.filter(id => !profile.unlockedUlts.includes(id));
    if (candidates.length === 0) {
      const { x, y } = { x: 1, y: 1 };
      const gearIds = sampleDistinctGearIds(x);
      let completedGained = 0;
      for (const gearId of gearIds) completedGained += addGearFragments(profile, gearId, y);
      Object.assign(detail, { kind: 'fragment', x, y, gearIds, totalPieces: x * y, className: classifyGachaRarity(x, y), completedGained });
    } else {
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      profile.unlockedUlts.push(id);
      Object.assign(detail, { grantedId: id });
    }
  } else if (kind === 'tactic') {
    // 設計書3-1：ガチャ直撃の戦術タイプは対応ULT未所持でも入手・保持可（2-4の例外）
    const candidates = VALID_TACTIC_IDS.filter(id => !profile.unlockedTactics.includes(id));
    if (candidates.length === 0) {
      const { x, y } = { x: 1, y: 1 };
      const gearIds = sampleDistinctGearIds(x);
      let completedGained = 0;
      for (const gearId of gearIds) completedGained += addGearFragments(profile, gearId, y);
      Object.assign(detail, { kind: 'fragment', x, y, gearIds, totalPieces: x * y, className: classifyGachaRarity(x, y), completedGained });
    } else {
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      profile.unlockedTactics.push(id);
      Object.assign(detail, { grantedId: id });
    }
  } else if (kind === 'gear') {
    const gearId = GEAR_IDS[Math.floor(Math.random() * GEAR_IDS.length)];
    if (!profile.completedGear[gearId]) profile.completedGear[gearId] = 0;
    profile.completedGear[gearId] += 1;
    Object.assign(detail, { gearId });
  }

  return detail;
}

function defaultProfile(clientId) {
  return {
    clientId,
    // 表示名・レートは既存のlocalStorage側と重複するが、
    // サーバー権威データとしても保持しておく（不整合検知・復旧用）
    name: '魔導士',
    rate: DEFAULT_RATE,
    // 戦績
    stats: {
      freeBattles: 0,
      rateBattles: 0,
      rateWins: 0,
      rateLosses: 0
    },
    // セットコメント（1〜9キーに対応、未設定はnull）
    setComments: Array(9).fill(null),
    // ================================================================
    // --- コイン経済・ショップ・ガチャ・ギアパワー（Phase0: データ受け皿のみ）---
    // このフェーズではフィールドを保持するだけで、ゲームプレイには影響しない。
    // Phase2以降でショップ・ガチャ・ギア効果を順次実装していく。
    // ================================================================
    coins: 0,
    unlockedShots: [...INITIAL_SHOT_IDS],  // 買い切りで所持している通常弾ID一覧（初期は魔法弾のみ）
    unlockedUlts: [...INITIAL_ULT_IDS],    // 買い切りで所持しているULT ID一覧（初期はメガビームのみ）
    unlockedTactics: [],            // 買い切り/ガチャ直撃で所持している戦術タイプ（例: 'beam_A'）
    gearFragments: {},              // { gearId: 破片数 }
    universalFragments: 0,          // 万能破片（天井報酬）の未使用ストック数
    completedGear: {},              // { gearId: 完成在庫数 }
    equippedGear: { main: null, subs: [] }, // 装備中のギア（サブ枠数はメインのギア種によって可変）
    gachaPityCount: 0,              // 天井までのガチャ回数カウント（30到達で万能破片3個→0にリセット）
    gachaFreeLastClaimDate: null,   // JST基準：その日の無料ガチャを最後に使った日付
    ...quest.createInitialQuestState(),
    updatedAt: Date.now()
  };
}

let profileDB = {};

// ローカルファイルからの読み込み（Upstash未設定時 or Upstash読み込み失敗時のフォールバック）
function loadProfileDBFromLocalFile() {
  try {
    if (fs.existsSync(PROFILE_DB_PATH)) {
      const raw = fs.readFileSync(PROFILE_DB_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[profiles] ローカルファイル読み込み失敗:', e.message);
    // 破損したファイルは上書き保存で失われないよう、調査・復旧用にリネーム退避しておく。
    try {
      if (fs.existsSync(PROFILE_DB_PATH)) {
        const backupPath = `${PROFILE_DB_PATH}.corrupt-${Date.now()}`;
        fs.renameSync(PROFILE_DB_PATH, backupPath);
        console.error(`[profiles] 破損ファイルを退避しました: ${backupPath}`);
      }
    } catch (renameErr) {
      console.error('[profiles] 破損ファイルの退避に失敗:', renameErr.message);
    }
  }
  return {};
}

// サーバー起動時に一度だけ呼ぶ。Upstashがあればそちらを正として読み込み、
// 失敗時やUpstash未設定時はローカルファイルにフォールバックする。
// index.jsの最後でこれをawaitしてからHTTPサーバーをlistenする。
async function loadProfileDBOnStartup() {
  if (redis) {
    try {
      const remote = await redis.get(REDIS_PROFILE_KEY);
      if (remote && typeof remote === 'object') {
        profileDB = remote;
        console.log(`[profiles] Upstashから読み込み完了（${Object.keys(profileDB).length}件）`);
        return;
      }
      console.log('[profiles] Upstashにデータなし。新規DBとして開始します。');
      profileDB = {};
      return;
    } catch (e) {
      console.error('[profiles] Upstash読み込み失敗、ローカルファイルにフォールバックします:', e.message);
    }
  }
  profileDB = loadProfileDBFromLocalFile();
}

// 旧勲章システムの保存データをプロフィールDBから完全に除去する。
// 現行プロフィールには勲章関連フィールドを残さず、コイン/ショップ/ガチャ/ギアだけを保持する。
async function purgeLegacyMedalData() {
  let changed = false;
  for (const profile of Object.values(profileDB)) {
    if (!profile || typeof profile !== 'object') continue;
    for (const key of ['medalsUnlocked', 'medalsEquipped', 'progress']) {
      if (Object.prototype.hasOwnProperty.call(profile, key)) {
        delete profile[key];
        changed = true;
      }
    }
  }
  if (!changed) return;

  writeProfileDBToLocalFile();
  if (redis) {
    try {
      await redis.set(REDIS_PROFILE_KEY, profileDB);
    } catch (e) {
      console.error('[profiles] 旧勲章データのUpstash削除保存に失敗（ローカルファイルには保存済み）:', e.message);
    }
  }
  console.log('[profiles] 旧勲章データを保存済みプロフィールから削除しました。');
}

let profileSaveTimer = null;
// 一時ファイルに書いてからrenameすることで、書き込み途中のプロセス強制終了時に
// profiles.json自体が中途半端な（JSONとして壊れた）状態になるのを防ぐ。
// Upstash設定時はこちらは「保険」として並行して残す（Upstash側がメイン）。
function writeProfileDBToLocalFile() {
  try {
    const tmpPath = `${PROFILE_DB_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(profileDB), 'utf8');
    fs.renameSync(tmpPath, PROFILE_DB_PATH);
  } catch (e) {
    console.error('[profiles] ローカル保存失敗:', e.message);
  }
}
// Upstashへの保存。呼び出し元は同期関数のままでよいよう、Promiseは内部で処理し
// 例外を外に投げない（投げっぱなしで呼ばれても落ちないようにする）。
function writeProfileDBToDisk() {
  writeProfileDBToLocalFile(); // ローカルにも常に保険で保存しておく
  if (!redis) return;
  redis.set(REDIS_PROFILE_KEY, profileDB).catch((e) => {
    console.error('[profiles] Upstash保存失敗（ローカルファイルには保存済み）:', e.message);
  });
}
function scheduleProfileSave() {
  if (profileSaveTimer) return;
  profileSaveTimer = setTimeout(() => {
    profileSaveTimer = null;
    writeProfileDBToDisk();
  }, PROFILE_SAVE_DEBOUNCE_MS);
}

function getOrCreateProfile(clientId) {
  if (!clientId || typeof clientId !== 'string' || clientId.length > 64) return null;
  if (!profileDB[clientId]) {
    profileDB[clientId] = defaultProfile(clientId);
  }
  // 旧バージョンのプロフィールに新フィールドが欠けている場合を補完
  const p = profileDB[clientId];
  if (typeof p.rate !== 'number' || !Number.isFinite(p.rate)) p.rate = DEFAULT_RATE;
  if (!p.stats) p.stats = defaultProfile(clientId).stats;
  for (const key of ['freeBattles', 'rateBattles', 'rateWins', 'rateLosses']) {
    if (typeof p.stats[key] !== 'number' || !Number.isFinite(p.stats[key])) p.stats[key] = 0;
  }
  if (!Array.isArray(p.setComments) || p.setComments.length !== 9) {
    const merged = Array(9).fill(null);
    if (Array.isArray(p.setComments)) {
      for (let i = 0; i < Math.min(9, p.setComments.length); i++) merged[i] = p.setComments[i];
    }
    p.setComments = merged;
  }
  // ================================================================
  // --- コイン経済・ショップ・ガチャ・ギアパワー（Phase0: 旧プロフィールへの補完）---
  // 既にプレイ済みの（このフィールドが無い）プロフィールに対して、
  // 欠けているフィールドだけをデフォルト値で補う。Phase2で「既存プレイヤーも
  // 新規プレイヤーと同条件にリセットする」方針が確定しているため、
  // unlockedShots/unlockedUlts の初期値も新規プレイヤーと同じ（魔法弾+メガビームのみ）にする。
  // ================================================================
  if (typeof p.coins !== 'number' || !Number.isFinite(p.coins)) p.coins = 0;
  p.coins = Math.max(0, Math.floor(p.coins));

  // 所持リストは「正規のIDのみ」「重複なし」「初期付与分を必ず含む」状態に正規化する。
  // 不正なIDが紛れ込んでもここで落とされるため、クライアント改竄の保険にもなる。
  const normalizeOwned = (list, validIds, initialIds) => {
    const base = Array.isArray(list) ? list : [];
    const cleaned = base.filter(id => typeof id === 'string' && validIds.includes(id));
    return Array.from(new Set([...initialIds, ...cleaned]));
  };
  p.unlockedShots = normalizeOwned(p.unlockedShots, VALID_SHOT_IDS, INITIAL_SHOT_IDS);
  p.unlockedUlts = normalizeOwned(p.unlockedUlts, VALID_ULT_IDS, INITIAL_ULT_IDS);
  p.unlockedTactics = normalizeOwned(p.unlockedTactics, VALID_TACTIC_IDS, []);

  // ================================================================
  // --- ガチャ・ギア在庫（Phase3）：不正な値・キーの正規化 ---
  // gearId は GEAR_IDS 以外を弾き、数量は 0以上の整数にクランプする。
  // ================================================================
  const normalizeGearCountMap = (obj) => {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const gearId of GEAR_IDS) {
        const v = obj[gearId];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          out[gearId] = Math.floor(v);
        }
      }
    }
    return out;
  };
  p.gearFragments = normalizeGearCountMap(p.gearFragments);
  p.completedGear = normalizeGearCountMap(p.completedGear);

  if (typeof p.universalFragments !== 'number' || !Number.isFinite(p.universalFragments) || p.universalFragments < 0) {
    p.universalFragments = 0;
  }
  p.universalFragments = Math.floor(p.universalFragments);

  if (!p.equippedGear || typeof p.equippedGear !== 'object') p.equippedGear = { main: null, subs: [] };
  if (p.equippedGear.main !== null && !GEAR_IDS.includes(p.equippedGear.main)) p.equippedGear.main = null;
  if (!Array.isArray(p.equippedGear.subs)) p.equippedGear.subs = [];
  let gearNormalizationChanged = false;
  // 不正/旧状態でサブに残っているメイン専用ギアや、メイン不在時のサブは
  // 通常の「外す」と同じく3破片へ戻してから除去する。
  const normalizedSubs = [];
  for (const id of p.equippedGear.subs) {
    if (!GEAR_IDS.includes(id)) continue;
    if (GEAR_META[id].subOnly) {
      destroyEquippedGear(p, id);
      gearNormalizationChanged = true;
      continue;
    }
    normalizedSubs.push(id);
  }
  p.equippedGear.subs = normalizedSubs;
  // メインが無ければサブ枠は常に0。既存サブは破片へ戻す。
  if (!p.equippedGear.main) {
    if (p.equippedGear.subs.length > 0) gearNormalizationChanged = true;
    p.equippedGear.subs.forEach(id => destroyEquippedGear(p, id));
    p.equippedGear.subs = [];
  } else {
    // メインのサブ枠を超える分は末尾から外し、破片を返す。
    const maxSlots = GEAR_META[p.equippedGear.main].mainSubSlots;
    while (p.equippedGear.subs.length > maxSlots) {
      const trimmedId = p.equippedGear.subs.pop();
      destroyEquippedGear(p, trimmedId);
      gearNormalizationChanged = true;
    }
  }

  if (gearNormalizationChanged) scheduleProfileSave();

  if (typeof p.gachaPityCount !== 'number' || !Number.isFinite(p.gachaPityCount) || p.gachaPityCount < 0) {
    p.gachaPityCount = 0;
  }
  p.gachaPityCount = Math.floor(p.gachaPityCount) % GACHA_PITY_MAX;

  // 1日1回無料ガチャ用の日付キー。JST（Asia/Tokyo）で1日を区切る。
  if (typeof p.gachaFreeLastClaimDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.gachaFreeLastClaimDate)) {
    p.gachaFreeLastClaimDate = null;
  }

  // Quest system: existing profiles are lazily migrated and period rollover is checked here.
  const questBefore = JSON.stringify({ loginBonus: p.loginBonus, monthlyLoginStreak: p.monthlyLoginStreak, dailyQuests: p.dailyQuests, weeklyQuests: p.weeklyQuests, monthlyQuests: p.monthlyQuests, monthlyCoinEarned: p.monthlyCoinEarned });
  quest.ensureQuestState(p);
  const questAfter = JSON.stringify({ loginBonus: p.loginBonus, monthlyLoginStreak: p.monthlyLoginStreak, dailyQuests: p.dailyQuests, weeklyQuests: p.weeklyQuests, monthlyQuests: p.monthlyQuests, monthlyCoinEarned: p.monthlyCoinEarned });
  if (questBefore !== questAfter) scheduleProfileSave();

  return p;
}

function sanitizeSetComment(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, 20);
  return trimmed.length > 0 ? trimmed : null;
}

function publicProfilePayload(p) {
  return {
    clientId: p.clientId,
    name: p.name,
    rate: p.rate,
    stats: p.stats,
    setComments: p.setComments,
    // --- コイン経済・ショップ・ガチャ・ギアパワー（Phase0/1）---
    coins: p.coins,
    unlockedShots: p.unlockedShots,
    unlockedUlts: p.unlockedUlts,
    unlockedTactics: p.unlockedTactics,
    gearFragments: p.gearFragments,
    universalFragments: p.universalFragments,
    completedGear: p.completedGear,
    equippedGear: p.equippedGear,
    gachaPityCount: p.gachaPityCount,
    gachaFreeLastClaimDate: p.gachaFreeLastClaimDate,
    gachaFreeAvailable: p.gachaFreeLastClaimDate !== quest.getJstDateKey(),
    quests: quest.getQuestSnapshot(p),
    loginBonus: quest.getLoginBonusSnapshot(p),
    monthlyCoinEarned: p.monthlyCoinEarned
  };
}

// roomName -> {
//   stage: string|null, hostId: string|null, mode: 'rate'|'free',
//   matchActive: boolean, members: Map<id, Member>
// }
// Member: { ws, name, history: [{time,x,y,z}], rate, kills, deaths }
const rooms = new Map();

// --- レート変動計算 ---
// kills/deaths: このマッチでの数, myRate/oppRate: マッチ開始時点のレート, didLose: マッチに負けたか
function calcRateChange(myRate, oppRate, kills, deaths, didLose) {
  const gapBonus = ((oppRate - myRate) / 100) * 2;
  const nerf = myRate > 1499 ? Math.floor((myRate - 1000) / 500) : 0;

  let perKill = 10 + gapBonus - nerf;
  let perDeath = -6 + gapBonus;

  perKill = Math.max(1, Math.min(30, perKill));
  perDeath = Math.max(-26, Math.min(-2, perDeath));

  let killGain = perKill * kills;
  if (didLose) killGain *= 0.5;
  const deathLoss = perDeath * deaths;

  const total = Math.round(killGain + deathLoss);
  return { total, perKill, perDeath };
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function getOrCreateRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      stage: null,
      hostId: null,
      mode: 'free',
      matchActive: false,
      rateResultActive: false,
      rematchRequests: new Set(),
      members: new Map()
    });
  }
  return rooms.get(roomName);
}

// --- バグ修正: 「部屋に1人しかいないのにレート戦中/満員と判定される」問題への対処 ---
// 本来メンバーの削除は socket の 'close' イベントでのみ行われるが、
// 回線不安定・タブのバックグラウンド化・ページの強制リロードなどで
// 実際にはもう繋がっていないソケットが 'close' 未発火のまま
// room.members に残り続けることがある（pingの死活監視サイクル分の遅延も生じる）。
// 特に「瞬断→即再接続」のケースでは、古い（実質死んでいる）接続がMapに残ったまま
// 新しい接続が追加されてしまい、実質1人しかいないのに人数が2人とカウントされて
// __rate_room_busy や __room_full が誤って返ってしまう。
// 入室可否の判定・部屋情報取得の直前で、既に閉じている（OPENでない）ソケットを
// 確実に取り除いてから人数判定を行うことで、この誤判定を防ぐ。
function pruneDeadMembers(room) {
  for (const [id, member] of room.members) {
    if (!member.ws || member.ws.readyState !== member.ws.OPEN) {
      room.members.delete(id);
      if (room.hostId === id) room.hostId = null;
    }
  }
}

function roomInfoPayload(room) {
  return {
    stage: room.stage,
    mode: room.mode,
    players: Array.from(room.members.values()).map(m => ({
      name: m.name,
      rate: m.rate,
      kills: m.kills,
      deaths: m.deaths
    }))
  };
}

function broadcastToRoom(roomName, payload, excludeId = null) {
  const room = rooms.get(roomName);
  if (!room) return;
  const text = JSON.stringify(payload);
  for (const [id, member] of room.members) {
    if (id === excludeId) continue;
    if (member.ws.readyState === member.ws.OPEN) {
      member.ws.send(text);
    }
  }
}

// 過去の時刻におけるプレイヤー位置を線形補間で復元
function getHistoricalPosition(history, targetTime) {
  if (!history || history.length === 0) return null;
  if (targetTime <= history[0].time) {
    return { x: history[0].x, y: history[0].y, z: history[0].z };
  }
  if (targetTime >= history[history.length - 1].time) {
    const last = history[history.length - 1];
    return { x: last.x, y: last.y, z: last.z };
  }

  for (let i = 0; i < history.length - 1; i++) {
    const h1 = history[i];
    const h2 = history[i + 1];
    if (h1.time <= targetTime && targetTime <= h2.time) {
      const dt = h2.time - h1.time;
      if (dt <= 0) return { x: h1.x, y: h1.y, z: h1.z };
      const alpha = (targetTime - h1.time) / dt;
      return {
        x: h1.x + alpha * (h2.x - h1.x),
        y: h1.y + alpha * (h2.y - h1.y),
        z: h1.z + alpha * (h2.z - h1.z)
      };
    }
  }
  const last = history[history.length - 1];
  return { x: last.x, y: last.y, z: last.z };
}

// レート戦マッチ終了処理：全員のレート変動を計算してブロードキャストし、次戦に備えてリセット
// disconnectedId: 切断による反則負けで終了した場合、切断したプレイヤーのID（通常の撃破決着では null）。
//   切断者はキル/デスに基づく通常のレート変動に加えて、追加ペナルティ(DISCONNECT_PENALTY)が引かれる。
function finishRateMatch(roomName, winnerId, disconnectedId = null) {
  const room = rooms.get(roomName);
  if (!room || !room.matchActive) return;
  room.matchActive = false;
  room.rateResultActive = true;
  if (!room.rematchRequests) room.rematchRequests = new Set();
  room.rematchRequests.clear();

  const ids = Array.from(room.members.keys());
  const results = [];

  for (const id of ids) {
    const me = room.members.get(id);
    if (!me) continue;

    // 相手のレート平均（複数対戦者がいる場合はその平均を格差計算に用いる）
    const opponents = ids.filter(oid => oid !== id).map(oid => room.members.get(oid)).filter(Boolean);
    const avgOppRate = opponents.length > 0
      ? opponents.reduce((s, o) => s + o.rate, 0) / opponents.length
      : me.rate;

    const didLose = id !== winnerId;
    const { total: baseTotal } = calcRateChange(me.rate, avgOppRate, me.kills, me.deaths, didLose);

    // 切断者には反則負けの追加ペナルティを科す。
    // キル数・レート差による加点が大きくても、切断者の最終変動が
    // プラスになることは許可しない（少なくとも -DISCONNECT_PENALTY）。
    const disconnectPenalty = (id === disconnectedId) ? DISCONNECT_PENALTY : 0;
    const total = id === disconnectedId
      ? Math.min(baseTotal - disconnectPenalty, -DISCONNECT_PENALTY)
      : baseTotal;

    const newRate = Math.max(0, me.rate + total);
    const isWinner = id === winnerId;

    // ================================================================
    // --- レート戦決着時の戦績・プロフィール更新 ---
    // ================================================================
    let coinsEarned = 0;
    const profile = me.clientId ? getOrCreateProfile(me.clientId) : null;
    if (profile) {
      profile.stats.rateBattles += 1;
      if (isWinner) profile.stats.rateWins += 1; else profile.stats.rateLosses += 1;

      // ================================================================
      // --- コイン経済（Phase1）：レート戦決着に応じたコイン付与 ---
      // 切断による反則負けは戦績・キル数に関わらずコイン0（設計書1-1節）。
      // それ以外は「勝敗基礎額 ＋ キル1つにつき+50（3キル分まで） ＋ EX ULT発動ボーナス（1試合1回）」。
      // ================================================================
      if (id === disconnectedId) {
        coinsEarned = COIN_DISCONNECT_PENALTY_OVERRIDE;
      } else {
        coinsEarned = isWinner ? COIN_RATE_WIN : COIN_RATE_LOSS;
        coinsEarned += Math.min(me.kills, COIN_MAX_KILLS_FOR_BONUS) * COIN_PER_KILL;
        if (me.matchUsedExUlt) coinsEarned += COIN_EX_ULT_BONUS;
      }
      quest.addCoins(profile, coinsEarned);
      quest.recordRateBattleResult(profile, {
        completed: id === disconnectedId ? 0 : 1,
        won: isWinner && id !== disconnectedId ? 1 : 0
      });

      profile.rate = newRate;
      profile.updatedAt = Date.now();
      scheduleProfileSave();
    }

    results.push({
      id,
      name: me.name,
      kills: me.kills,
      deaths: me.deaths,
      oldRate: me.rate,
      newRate,
      delta: total,
      isWinner,
      disconnected: id === disconnectedId,
      // --- コイン経済（Phase1）---
      coinsEarned,
      newCoins: profile ? profile.coins : null
    });

    me.rate = newRate;

    // 次戦に備えてEX ULT発動コインボーナス判定をリセット
    me.matchUsedExUlt = false;
  }

  broadcastToRoom(roomName, {
    type: '__rate_match_result',
    winnerId,
    disconnectedId,
    results
  }, disconnectedId);

  // 次戦に備えて、キル/デスのみリセット（レートは維持）
  for (const m of room.members.values()) {
    m.kills = 0;
    m.deaths = 0;
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX_HTML);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  let joinedRoom = null;
  let myId = null;
  let myClientId = null; // Ver5: プロフィール永続化用のブラウザ発行UUID

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  // Explicit client-side leave. Do not wait for WebSocket close to update room state.
  function leaveCurrentRoom() {
    if (!joinedRoom || !myId) return;
    const roomName = joinedRoom;
    const leavingId = myId;
    const room = rooms.get(roomName);
    if (!room) { joinedRoom = null; myId = null; return; }

    // Rate match disconnect: only a real 1v1 match is penalized.
    // A rate room with only one member is not a match and is simply invalidated.
    if (room.mode === 'rate' && room.matchActive) {
      const opponentIds = Array.from(room.members.keys()).filter(id => id !== leavingId);
      if (opponentIds.length > 0) finishRateMatch(roomName, opponentIds[0], leavingId);
      else room.matchActive = false;
    }

    // Result screen: remaining opponent can no longer rematch.
    if (room.mode === 'rate' && room.rateResultActive) {
      const opponentIds = Array.from(room.members.keys()).filter(id => id !== leavingId);
      for (const opponentId of opponentIds) {
        const opponent = room.members.get(opponentId);
        if (opponent?.ws && opponent.ws.readyState === opponent.ws.OPEN) {
          opponent.ws.send(JSON.stringify({ type: '__rematch_opponent_left' }));
        }
      }
      room.rematchRequests?.clear();
    }

    room.members.delete(leavingId);
    const wasHost = room.hostId === leavingId;
    if (wasHost) room.hostId = null;

    if (wasHost && room.members.size > 0) {
      const nextHostEntry = room.members.entries().next().value;
      if (nextHostEntry) {
        const [nextHostId, nextHostMember] = nextHostEntry;
        room.hostId = nextHostId;
        if (nextHostMember.ws && nextHostMember.ws.readyState === nextHostMember.ws.OPEN) {
          nextHostMember.ws.send(JSON.stringify({ type: '__host_migrated', newHostId: nextHostId }));
        }
        broadcastToRoom(roomName, { type: '__host_changed', newHostId: nextHostId }, nextHostId);
      }
    }

    broadcastToRoom(roomName, { type: '__left', id: leavingId, count: room.members.size }, leavingId);
    if (room.members.size === 0) rooms.delete(roomName);

    // Prevent the close event from performing the cleanup twice.
    joinedRoom = null;
    myId = null;
  }

  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    // --- 高精度時刻同期 / Ping測定 ---
    if (data.type === '__ping') {
      socket.send(JSON.stringify({
        type: '__pong',
        clientTime: data.clientTime,
        serverTime: Date.now()
      }));
      return;
    }

    // ================================================================
    // --- Ver5: プロフィール（セットコメント・戦績・ギア関連）の永続化 ---
    // ================================================================

    // プロフィールの取得（未参加でも可。プロフィール画面を開いた時点で呼ばれる）
    if (data.type === '__profile_request') {
      const clientId = String(data.clientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      if (!profile) {
        socket.send(JSON.stringify({ type: '__profile_result', ok: false }));
        return;
      }
      myClientId = clientId;
      socket.send(JSON.stringify({
        type: '__profile_result',
        ok: true,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // セットコメント9個の一括更新
    if (data.type === '__profile_set_comments') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      if (!profile || !Array.isArray(data.comments)) return;
      const next = Array(9).fill(null);
      for (let i = 0; i < 9; i++) next[i] = sanitizeSetComment(data.comments[i]);
      profile.setComments = next;
      profile.updatedAt = Date.now();
      scheduleProfileSave();
      socket.send(JSON.stringify({
        type: '__profile_result',
        ok: true,
        profile: publicProfilePayload(profile)
      }));
      return;
    }


    // 名前の同期（プレイヤー名変更時、サーバー側プロフィールにも反映）
    if (data.type === '__profile_sync_name') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      if (!profile) return;
      profile.name = String(data.name || profile.name).slice(0, 20);
      profile.updatedAt = Date.now();
      scheduleProfileSave();
      return;
    }

    // ================================================================
    // --- クエスト / ログインボーナス ---
    // 受取判定・報酬付与・期間更新は quest.js + サーバー側プロフィールを正とする。
    // data: { type:'__quest_claim', clientId, category, questId }
    // ================================================================
    if (data.type === '__quest_claim') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const fail = (reason) => {
        socket.send(JSON.stringify({ type: '__quest_claim_result', ok: false, reason }));
      };
      if (!clientId) return fail('no_profile');
      if (myClientId && myClientId !== clientId) return fail('invalid_client');
      const profile = getOrCreateProfile(clientId);
      if (!profile) return fail('no_profile');
      myClientId = clientId;

      const category = String(data.category || '');
      const questId = String(data.questId || '');
      const result = quest.claimQuest(profile, category, questId, addGearFragments);
      if (!result.ok) return fail(result.reason);

      profile.updatedAt = Date.now();
      scheduleProfileSave();
      socket.send(JSON.stringify({
        type: '__quest_claim_result',
        ...result,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // ログインボーナスはクエスト受取とは別枠。報酬もその場でサーバー付与する。
    if (data.type === '__login_bonus_claim') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const fail = (reason) => {
        socket.send(JSON.stringify({ type: '__login_bonus_result', ok: false, reason }));
      };
      if (!clientId) return fail('no_profile');
      if (myClientId && myClientId !== clientId) return fail('invalid_client');
      const profile = getOrCreateProfile(clientId);
      if (!profile) return fail('no_profile');
      myClientId = clientId;

      const result = quest.claimLoginBonus(profile, addGearFragments);
      if (!result.ok) return fail(result.reason);

      profile.updatedAt = Date.now();
      scheduleProfileSave();
      socket.send(JSON.stringify({
        type: '__login_bonus_result',
        ...result,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // ================================================================
    // --- ショップ購入（Phase2）---
    // data: { type:'__shop_purchase', clientId, kind:'shot'|'ult'|'tactic'|'ult_random', id }
    // 価格・所持判定・コイン残高は全てサーバー側で検証する。
    // ================================================================
    if (data.type === '__shop_purchase') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => {
        socket.send(JSON.stringify({ type: '__shop_result', ok: false, reason }));
      };
      if (!profile) return fail('no_profile');

      const kind = String(data.kind || '');
      const id = String(data.id || '');
      let price = 0;
      let grantedId = null;
      let grantedKind = kind;

      if (kind === 'shot') {
        if (!VALID_SHOT_IDS.includes(id)) return fail('invalid_id');
        if (profile.unlockedShots.includes(id)) return fail('already_owned');
        price = SHOP_PRICE_SHOT;
        grantedId = id;
      } else if (kind === 'ult') {
        if (!VALID_ULT_IDS.includes(id)) return fail('invalid_id');
        if (profile.unlockedUlts.includes(id)) return fail('already_owned');
        price = SHOP_PRICE_ULT;
        grantedId = id;
      } else if (kind === 'ult_random') {
        // 未所持のULTの中から抽選で1つ。抽選はサーバー側で行う。
        const candidates = VALID_ULT_IDS.filter(u => !profile.unlockedUlts.includes(u));
        if (candidates.length === 0) return fail('all_owned');
        price = SHOP_PRICE_ULT_RANDOM;
        grantedId = candidates[Math.floor(Math.random() * candidates.length)];
        grantedKind = 'ult';
      } else if (kind === 'tactic') {
        if (!VALID_TACTIC_IDS.includes(id)) return fail('invalid_id');
        if (profile.unlockedTactics.includes(id)) return fail('already_owned');
        // 設計書2-4節：ショップ経由では、対応するULT本体を所持していないと購入不可。
        // （ガチャ直撃での入手だけが例外だが、それはPhase3で別経路として実装する）
        const parentUlt = id.split('_')[0];
        if (!profile.unlockedUlts.includes(parentUlt)) return fail('ult_required');
        price = SHOP_PRICE_TACTIC;
        grantedId = id;
      } else {
        return fail('invalid_kind');
      }

      if (profile.coins < price) return fail('not_enough_coins');

      profile.coins -= price;
      if (grantedKind === 'shot') profile.unlockedShots.push(grantedId);
      else if (grantedKind === 'ult') profile.unlockedUlts.push(grantedId);
      else if (grantedKind === 'tactic') profile.unlockedTactics.push(grantedId);
      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__shop_result',
        ok: true,
        kind: grantedKind,
        grantedId,
        spent: price,
        wasRandom: kind === 'ult_random',
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // ================================================================
    // --- ガチャ（Phase3）---
    // data: { type:'__gacha_pull', clientId, times: 1|10 }
    // 抽選は必ずサーバー側で行う。timesは1回引きと10連引きのみ許可（不正な回数は拒否）。
    // ================================================================
    if (data.type === '__gacha_pull') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      if (!profile) {
        socket.send(JSON.stringify({ type: '__gacha_result', ok: false, reason: 'no_profile' }));
        return;
      }

      const times = (data.times === 10) ? 10 : 1;
      const isFreeDaily = data.freeDaily === true;
      if (isFreeDaily && times !== 1) {
        socket.send(JSON.stringify({ type: '__gacha_result', ok: false, reason: 'invalid_free_gacha' }));
        return;
      }

      const todayJst = quest.getJstDateKey();
      if (isFreeDaily && profile.gachaFreeLastClaimDate === todayJst) {
        socket.send(JSON.stringify({ type: '__gacha_result', ok: false, reason: 'free_gacha_used' }));
        return;
      }

      const totalCost = isFreeDaily ? 0 : GACHA_COST * times;
      if (profile.coins < totalCost) {
        socket.send(JSON.stringify({ type: '__gacha_result', ok: false, reason: 'not_enough_coins' }));
        return;
      }

      profile.coins -= totalCost;
      const pulls = [];
      let gearCompletedGained = 0;
      for (let i = 0; i < times; i++) {
        const detail = runGachaPull(profile);

        // 天井チェック：このガチャ自体の結果とは別に、30連ごとに万能破片3個を確定付与する
        profile.gachaPityCount += 1;
        let pityTriggered = false;
        if (profile.gachaPityCount >= GACHA_PITY_MAX) {
          profile.gachaPityCount = 0;
          profile.universalFragments += GACHA_PITY_UNIVERSAL_REWARD;
          pityTriggered = true;
        }

        gearCompletedGained += (detail.kind === 'gear') ? 1 : (Number(detail.completedGained) || 0);
        pulls.push({ ...detail, pityTriggered, pityCountAfter: profile.gachaPityCount });
      }

      if (isFreeDaily) {
        profile.gachaFreeLastClaimDate = todayJst;
      }

      quest.recordProgress(profile, 'gachaPull', times);
      quest.registerGearCompletion(profile, gearCompletedGained);
      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gacha_result',
        ok: true,
        pulls,
        spent: totalCost,
        freeDaily: isFreeDaily,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // ================================================================
    // --- 万能破片の使用（Phase3）---
    // data: { type:'__gacha_use_universal', clientId, gearId, amount }
    // 万能破片を指定したギアIDの破片としてamount個消費する。
    // ================================================================
    if (data.type === '__gacha_use_universal') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => socket.send(JSON.stringify({ type: '__gacha_use_universal_result', ok: false, reason }));
      if (!profile) return fail('no_profile');

      const gearId = String(data.gearId || '');
      if (!GEAR_IDS.includes(gearId)) return fail('invalid_id');

      let amount = Number(data.amount);
      if (!Number.isFinite(amount) || amount <= 0) return fail('invalid_amount');
      amount = Math.floor(amount);
      if (amount > profile.universalFragments) return fail('not_enough_fragments');

      profile.universalFragments -= amount;
      const completedGained = addGearFragments(profile, gearId, amount);
      quest.registerGearCompletion(profile, completedGained);
      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gacha_use_universal_result',
        ok: true,
        gearId,
        amount,
        completedGained,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // ================================================================
    // --- ギアスロット装備（Phase4）---
    // メイン切替時、旧メインは自動的に外れて消滅＋キャッシュバックされ、
    // 新メインのサブ枠数に収まらない分のサブも同様に自動退避される。
    // ================================================================
    if (data.type === '__gear_equip_main') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => socket.send(JSON.stringify({ type: '__gear_equip_main_result', ok: false, reason }));
      if (!profile) return fail('no_profile');

      const gearId = String(data.gearId || '');
      if (!GEAR_IDS.includes(gearId)) return fail('invalid_id');
      if (profile.equippedGear.main === gearId) return fail('already_equipped');
      if ((profile.completedGear[gearId] || 0) < 1) return fail('not_enough_inventory');
      if (profile.coins < GEAR_MAIN_EQUIP_COST) return fail('not_enough_coins');

      const removed = { oldMain: null, trimmedSubs: [] };

      // 1. 旧メインがあれば外す（消滅＋キャッシュバック）。コストはかからない。
      if (profile.equippedGear.main) {
        destroyEquippedGear(profile, profile.equippedGear.main);
        removed.oldMain = profile.equippedGear.main;
      }

      // 2. 新メインを装備（在庫を1消費、コインを支払う）
      profile.completedGear[gearId] -= 1;
      if (profile.completedGear[gearId] <= 0) delete profile.completedGear[gearId];
      profile.coins -= GEAR_MAIN_EQUIP_COST;
      profile.equippedGear.main = gearId;

      // 3. 新メインのサブ枠数に収まらないサブは末尾から自動退避（消滅＋キャッシュバック）
      const newSlots = GEAR_META[gearId].mainSubSlots;
      while (profile.equippedGear.subs.length > newSlots) {
        const trimmedId = profile.equippedGear.subs.pop();
        destroyEquippedGear(profile, trimmedId);
        removed.trimmedSubs.push(trimmedId);
      }

      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gear_equip_main_result',
        ok: true,
        gearId,
        spent: GEAR_MAIN_EQUIP_COST,
        removedOldMain: removed.oldMain,
        trimmedSubs: removed.trimmedSubs,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    if (data.type === '__gear_equip_sub') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => socket.send(JSON.stringify({ type: '__gear_equip_sub_result', ok: false, reason }));
      if (!profile) return fail('no_profile');

      const gearId = String(data.gearId || '');
      if (!GEAR_IDS.includes(gearId)) return fail('invalid_id');
      if (GEAR_META[gearId].subOnly) return fail('main_only_gear');
      if (!profile.equippedGear.main) return fail('no_main_equipped');

      const maxSlots = GEAR_META[profile.equippedGear.main].mainSubSlots;
      if (profile.equippedGear.subs.length >= maxSlots) return fail('sub_slots_full');
      if ((profile.completedGear[gearId] || 0) < 1) return fail('not_enough_inventory');
      if (profile.coins < GEAR_SUB_EQUIP_COST) return fail('not_enough_coins');

      profile.completedGear[gearId] -= 1;
      if (profile.completedGear[gearId] <= 0) delete profile.completedGear[gearId];
      profile.coins -= GEAR_SUB_EQUIP_COST;
      profile.equippedGear.subs.push(gearId);

      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gear_equip_sub_result',
        ok: true,
        gearId,
        spent: GEAR_SUB_EQUIP_COST,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    if (data.type === '__gear_unequip_main') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => socket.send(JSON.stringify({ type: '__gear_unequip_main_result', ok: false, reason }));
      if (!profile) return fail('no_profile');
      if (!profile.equippedGear.main) return fail('no_main_equipped');

      const removedMain = profile.equippedGear.main;
      destroyEquippedGear(profile, removedMain);
      profile.equippedGear.main = null;

      // メインが無い状態ではサブ枠は0になるため、装備中のサブも全て道連れで外れる
      const removedSubs = profile.equippedGear.subs.slice();
      removedSubs.forEach(id => destroyEquippedGear(profile, id));
      profile.equippedGear.subs = [];

      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gear_unequip_main_result',
        ok: true,
        removedMain,
        removedSubs,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    if (data.type === '__gear_unequip_sub') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      const fail = (reason) => socket.send(JSON.stringify({ type: '__gear_unequip_sub_result', ok: false, reason }));
      if (!profile) return fail('no_profile');

      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= profile.equippedGear.subs.length) {
        return fail('invalid_index');
      }

      const [removedId] = profile.equippedGear.subs.splice(index, 1);
      destroyEquippedGear(profile, removedId);

      profile.updatedAt = Date.now();
      scheduleProfileSave();

      socket.send(JSON.stringify({
        type: '__gear_unequip_sub_result',
        ok: true,
        removedId,
        index,
        profile: publicProfilePayload(profile)
      }));
      return;
    }

    // --- 部屋の詳細情報の照会（未参加でも可・「合言葉で部屋に入る」プレビュー用） ---
    if (data.type === '__room_info_request') {
      const roomName = String(data.room || 'default').slice(0, 30);
      const room = rooms.get(roomName);
      if (!room) {
        socket.send(JSON.stringify({ type: '__room_info_result', room: roomName, exists: false }));
      } else {
        pruneDeadMembers(room);
        socket.send(JSON.stringify({
          type: '__room_info_result',
          room: roomName,
          exists: true,
          ...roomInfoPayload(room)
        }));
      }
      return;
    }

    // --- 部屋への参加 ---
    if (data.type === '__join') {
      if (joinedRoom) return;

      const roomName = String(data.room || 'default').slice(0, 30);
      const isRoomNew = !rooms.has(roomName);
      const room = getOrCreateRoom(roomName);

      // 修正: 入室可否（レート戦中/満員）を判定する前に、既に切断済みだが
      // 'close' イベント未到達で残っている幽霊メンバーを掃除しておく。
      // これをしないと、実質1人しかいない部屋でも人数が2人のまま扱われ、
      // 「この部屋はレート戦中です！」と誤って弾かれることがある。
      pruneDeadMembers(room);

      if (!data.isHost && !room.hostId) {
        socket.send(JSON.stringify({ type: '__no_host' }));
        if (isRoomNew) rooms.delete(roomName);
        return;
      }

      // --- レート戦は完全1vs1。既に2人揃っている部屋には
      //     （ホスト本人の瞬断再接続を除き）合言葉を知っていても乱入できない。
      // 修正: 以前は room.matchActive も条件に含めていたため、ホストが1人で
      //       入室した時点で matchActive が true になり、2人目が正常に参加
      //       できないバグがあった。人数のみで判定するように変更。
      if (!data.isHost && room.mode === 'rate' && room.members.size >= RATE_MATCH_MEMBERS) {
        socket.send(JSON.stringify({ type: '__rate_room_busy' }));
        socket.close();
        return;
      }

      const memberCap = (room.mode === 'rate') ? RATE_MATCH_MEMBERS : MAX_MEMBERS_PER_ROOM;
      if (room.members.size >= memberCap) {
        socket.send(JSON.stringify({ type: '__room_full' }));
        socket.close();
        return;
      }

      myId = makeId();
      joinedRoom = roomName;
      myClientId = String(data.clientId || '').slice(0, 64) || null; // Ver5: プロフィール紐付け

      if (data.isHost && !room.stage && data.stage) {
        room.stage = data.stage;
      }
      if (data.isHost && !room.hostId) {
        room.hostId = myId;
        // モード/試合状態は「部屋が本当に新規」の場合のみ初期化する。
        // ホストの瞬断からの再接続で room.hostId が null になっていた場合に
        // 進行中のレート戦や確定済みのモードを誤って上書きしないため。
        if (isRoomNew) {
          room.mode = (data.mode === 'rate') ? 'rate' : 'free';
          // 修正: レート戦は対戦相手が揃うまで matchActive にしない
          // （揃うタイミングは下のメンバー登録後に別途判定する）。
          // フリーバトルは従来通りホスト参加時点でアクティブ扱いにする。
          room.matchActive = (room.mode !== 'rate');
        }
      }

      // Ver5修正: レートはサーバー権威のプロフィールDBを常に正とする。
      // クライアントがlocalStorageから申告する data.rate は、
      // 未参加・DB無しなど profile が取得できない場合のみのフォールバックとして扱う。
      // （以前はクライアント申告値をそのまま採用していたため、localStorageが古い/
      //   別ブラウザ/クリア後などにプロフィール画面の表示レートと実戦のレートがズレていた）
      const joinProfile = myClientId ? getOrCreateProfile(myClientId) : null;
      const startRate = joinProfile ? joinProfile.rate
        : (Number.isFinite(Number(data.rate)) ? Number(data.rate) : DEFAULT_RATE);

      room.members.set(myId, {
        ws: socket,
        name: String(data.name || '魔導士').slice(0, 20),
        history: [],
        rate: startRate,
        kills: 0,
        deaths: 0,
        clientId: myClientId,
        // レート戦終了時のEX ULT発動コインボーナス判定用
        matchUsedExUlt: false
      });

      // レート戦は対戦相手（2人目）が揃った時点でマッチを開始扱いにする。
      if (room.mode === 'rate' && room.members.size >= RATE_MATCH_MEMBERS) {
        room.matchActive = true;
      }

      // Ver5: フリーバトル参加回数のカウント（レート戦は決着時にカウントするためここでは対象外）
      if (room.mode === 'free' && myClientId) {
        const profile = getOrCreateProfile(myClientId);
        if (profile) {
          profile.stats.freeBattles += 1;
          profile.updatedAt = Date.now();
          scheduleProfileSave();
        }
      }

      socket.send(JSON.stringify({
        type: '__joined',
        id: myId,
        stage: room.stage,
        mode: room.mode
      }));
      broadcastToRoom(roomName, {
        type: '__joined_other',
        count: room.members.size,
        name: room.members.get(myId).name,
        rate: startRate
      }, myId);

      if (data.isHost && room.stage) {
        broadcastToRoom(roomName, { type: '__stage_update', stage: room.stage }, myId);
      }
      return;
    }

    if (!joinedRoom || !myId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const currentMember = room.members.get(myId);

    if (data.type === '__leave') {
      leaveCurrentRoom();
      return;
    }

    // クライアント側で発生した戦闘系クエストイベントのバッチ。
    // 訓練場はそもそもこのWebSocketへ参加しないため対象外。
    if (data.type === '__quest_event_batch') {
      if (!currentMember || !myClientId || String(data.clientId || '') !== String(myClientId)) return;
      if (room.mode !== 'free' && room.mode !== 'rate') return;
      const events = data.events && typeof data.events === 'object' ? data.events : {};
      const profile = getOrCreateProfile(myClientId);
      if (!profile) return;

      let changed = false;
      for (const [eventType, rawAmount] of Object.entries(events)) {
        const amount = Number(rawAmount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        if (quest.recordClientEvent(profile, eventType, amount)) changed = true;
      }
      if (changed) {
        profile.updatedAt = Date.now();
        scheduleProfileSave();
      }
      return;
    }

    // --- 移動同期 ＆ サーバー側位置履歴の記録 ---
    if (data.type === 'move') {
      if (currentMember) {
        const now = Date.now();
        currentMember.history.push({
          time: now,
          x: Number(data.x),
          y: Number(data.y),
          z: Number(data.z)
        });
        // 過去1.5秒より古い履歴は破棄
        const cutoff = now - HISTORY_DURATION_MS;
        while (currentMember.history.length > 0 && currentMember.history[0].time < cutoff) {
          currentMember.history.shift();
        }
      }
      broadcastToRoom(joinedRoom, { ...data, senderId: myId }, myId);
      return;
    }

    // EX ULT使用報告（レート戦のコインボーナス判定用）
    if (data.type === '__report_ex_ult_used') {
      if (currentMember && room.mode === 'rate' && room.matchActive) {
        currentMember.matchUsedExUlt = true;
      }
      return;
    }


    // --- シューター優先の着弾申請（遅延補償・巻き戻し検証） ---
    if (data.type === 'hit_claim') {
      const serverNow = Date.now();
      const clientHitTime = Number(data.hitTime) || serverNow;
      const rewindMs = serverNow - clientHitTime;

      // 【高遅延ノーレジ制限】
      // あまりにも遅延が高すぎる（MAX_REWIND_MSを超える）または異常な未来タイムスタンプの場合は却下
      if (rewindMs > MAX_REWIND_MS || rewindMs < -60) {
        socket.send(JSON.stringify({
          type: 'hit_rejected',
          reason: 'high_latency',
          delay: rewindMs
        }));
        return;
      }

      const targetMember = room.members.get(data.targetId);
      if (!targetMember) return;
      if (data.targetId === myId) return; // 自傷申請は無視

      // 相手の過去の位置を巻き戻して復元
      const targetPos = getHistoricalPosition(targetMember.history, clientHitTime);
      if (!targetPos) {
        // 履歴がまだない場合は着弾を明示的に却下して、
        // シューター側へ理由を返す。黙ってreturnすると不発原因をUI/ログから追えない。
        socket.send(JSON.stringify({
          type: 'hit_rejected',
          reason: 'no_history'
        }));
        return;
      }

      // 弾の着弾座標と、復元した相手中心（Y+0.9）の距離を検証
      const bp = data.bulletPos || { x: 0, y: 0, z: 0 };
      const dx = bp.x - targetPos.x;
      const dy = bp.y - (targetPos.y + 0.9);
      const dz = bp.z - targetPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const hitRadius = 1.35 * (data.bulletScale || 1.0) + 0.55; // 補間ジッター許容マージン
      if (dist <= hitRadius) {
        // ヒット承認！ 部屋全員（被弾者含む）に確定メッセージを通知
        broadcastToRoom(joinedRoom, {
          type: 'hit_approved',
          shooterId: myId,
          targetId: data.targetId,
          rawDmg: data.rawDmg,
          isExSuperHoming: !!data.isExSuperHoming,
          bulletPos: bp,
          bulletScale: data.bulletScale || 1.0,
          isCurseTarget: !!data.isCurseTarget
        });
      } else {
        socket.send(JSON.stringify({
          type: 'hit_rejected',
          reason: 'out_of_bounds',
          dist: dist
        }));
      }
      return;
    }

    // --- レート戦の再戦申込（ホスト/ゲスト双方、決着済みの場合のみ） ---
    if (data.type === '__rematch_request' || data.type === '__rematch') {
      if (room.mode !== 'rate' || room.matchActive || !room.rateResultActive) return;
      const ids = Array.from(room.members.keys());
      if (ids.length !== RATE_MATCH_MEMBERS || !room.members.has(myId)) {
        socket.send(JSON.stringify({ type: '__rematch_opponent_left' }));
        return;
      }

      if (!room.rematchRequests) room.rematchRequests = new Set();
      room.rematchRequests.add(myId);

      if (room.rematchRequests.size >= RATE_MATCH_MEMBERS) {
        for (const m of room.members.values()) {
          m.kills = 0;
          m.deaths = 0;
          m.matchUsedExUlt = false;
        }
        room.rematchRequests.clear();
        room.rateResultActive = false;
        room.matchActive = true;
        broadcastToRoom(joinedRoom, { type: '__rematch_start' });
      } else {
        const opponentId = ids.find(id => id !== myId);
        const opponent = opponentId ? room.members.get(opponentId) : null;
        if (opponent?.ws && opponent.ws.readyState === opponent.ws.OPEN) {
          opponent.ws.send(JSON.stringify({ type: '__rematch_offer' }));
        }
        socket.send(JSON.stringify({ type: '__rematch_waiting' }));
      }
      return;
    }

    // --- 撃破報告（レート戦のキル/デス集計＆勝敗判定） ---
    if (data.type === 'player_died') {
      if (room.mode === 'rate' && room.matchActive && currentMember) {
        currentMember.deaths += 1;

        const killerId = data.killerId;
        const killerMember = (killerId && killerId !== myId) ? room.members.get(killerId) : null;
        if (killerMember) {
          killerMember.kills += 1;
        }

        broadcastToRoom(joinedRoom, { ...data, senderId: myId }, myId);

        if (killerMember && killerMember.kills >= RATE_KILLS_TO_WIN) {
          finishRateMatch(joinedRoom, killerId);
        }
        return;
      }

      broadcastToRoom(joinedRoom, { ...data, senderId: myId }, myId);
      return;
    }

    // その他の通常中継
    broadcastToRoom(joinedRoom, { ...data, senderId: myId }, myId);
  });

  socket.on('close', () => {
    leaveCurrentRoom();
  });
});

setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 25000);

// Upstashからプロフィールデータを読み込み終えてからlistenを開始する。
// こうしないと、起動直後のアクセスが「空のprofileDB」を見てしまう可能性がある。
loadProfileDBOnStartup().then(async () => {
  await purgeLegacyMedalData();
  server.listen(PORT, () => {
    console.log(`Rewind & CCD Authoritative Server listening on port ${PORT}`);
  });
}).catch((e) => {
  console.error('[profiles] 起動時読み込みで致命的エラー、空DBで起動します:', e.message);
  server.listen(PORT, () => {
    console.log(`Rewind & CCD Authoritative Server listening on port ${PORT}`);
  });
});

// --- 終了時にプロフィールDBの未保存分を確実にフラッシュする ---
// Render等のホスティング環境ではデプロイ更新・再起動時にSIGTERMが送られる。
// デバウンス中（直近2秒以内）の変更が失われないよう、終了前に保存を完了させる。
// Upstashへの書き込みは非同期のため、完了を待ってからプロセスを終了する
// （待たずにexitすると、書き込み中にプロセスが切られてデータが失われる恐れがある）。
async function gracefulShutdown(signal) {
  console.log(`[server] ${signal} を受信、プロフィールDBを保存して終了します...`);
  if (profileSaveTimer) {
    clearTimeout(profileSaveTimer);
    profileSaveTimer = null;
  }
  writeProfileDBToLocalFile();
  if (redis) {
    try {
      await redis.set(REDIS_PROFILE_KEY, profileDB);
      console.log('[profiles] Upstashへの終了時保存が完了しました。');
    } catch (e) {
      console.error('[profiles] 終了時のUpstash保存に失敗（ローカルファイルには保存済み）:', e.message);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
