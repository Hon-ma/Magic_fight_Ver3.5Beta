// 3D Magic FPS Duel - オーソリタティブ遅延補償＆中継サーバー
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

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

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ================================================================
// --- Ver5: プレイヤープロフィール永続化ストア ---
// プレイヤーはブラウザ側で発行されるUUID(clientId)で識別する。
// セットコメント(9個)・勲章の所持状況・戦績をJSONファイルに保存し、
// サーバー再起動をまたいでも保持されるようにする。
// ================================================================
const PROFILE_DB_PATH = path.join(__dirname, 'profiles.json');
const PROFILE_SAVE_DEBOUNCE_MS = 2000;

const MEDAL_IDS = ['red', 'blue', 'yellow', 'green', 'orange', 'purple', 'white'];

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
    // 勲章の達成状況 { red: bool, blue: bool, ... }
    medalsUnlocked: Object.fromEntries(MEDAL_IDS.map(id => [id, false])),
    // 選択中の勲章（最大2つ、重複可なので配列でid格納。例: ['red','red']）
    medalsEquipped: [],
    // 勲章の進捗トラッキング用（達成条件の判定に使う中間値）
    progress: {
      totalDistanceM: 0,        // 緑の勲章用: 総移動距離
      bestRateMatchJumps: 0     // 黄の勲章用: 1回のレート戦での最大ジャンプ数（参考値、判定はクライアント申告+簡易検証）
    },
    updatedAt: Date.now()
  };
}

let profileDB = {};
try {
  if (fs.existsSync(PROFILE_DB_PATH)) {
    const raw = fs.readFileSync(PROFILE_DB_PATH, 'utf8');
    profileDB = JSON.parse(raw);
  }
} catch (e) {
  console.error('[profiles] 読み込み失敗、空DBで起動します:', e.message);
  profileDB = {};
}

let profileSaveTimer = null;
function scheduleProfileSave() {
  if (profileSaveTimer) return;
  profileSaveTimer = setTimeout(() => {
    profileSaveTimer = null;
    try {
      fs.writeFileSync(PROFILE_DB_PATH, JSON.stringify(profileDB), 'utf8');
    } catch (e) {
      console.error('[profiles] 保存失敗:', e.message);
    }
  }, PROFILE_SAVE_DEBOUNCE_MS);
}

function getOrCreateProfile(clientId) {
  if (!clientId || typeof clientId !== 'string' || clientId.length > 64) return null;
  if (!profileDB[clientId]) {
    profileDB[clientId] = defaultProfile(clientId);
  }
  // 旧バージョンのプロフィールに新フィールドが欠けている場合を補完
  const p = profileDB[clientId];
  if (!p.stats) p.stats = defaultProfile(clientId).stats;
  if (!Array.isArray(p.setComments) || p.setComments.length !== 9) {
    const merged = Array(9).fill(null);
    if (Array.isArray(p.setComments)) {
      for (let i = 0; i < Math.min(9, p.setComments.length); i++) merged[i] = p.setComments[i];
    }
    p.setComments = merged;
  }
  if (!p.medalsUnlocked) p.medalsUnlocked = Object.fromEntries(MEDAL_IDS.map(id => [id, false]));
  for (const id of MEDAL_IDS) if (typeof p.medalsUnlocked[id] !== 'boolean') p.medalsUnlocked[id] = false;
  if (!Array.isArray(p.medalsEquipped)) p.medalsEquipped = [];
  if (!p.progress) p.progress = defaultProfile(clientId).progress;
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
    medalsUnlocked: p.medalsUnlocked,
    medalsEquipped: p.medalsEquipped,
    progress: p.progress
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
      members: new Map()
    });
  }
  return rooms.get(roomName);
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

    // 切断者には反則負けの追加ペナルティを科す
    const disconnectPenalty = (id === disconnectedId) ? DISCONNECT_PENALTY : 0;
    const total = baseTotal - disconnectPenalty;

    const newRate = Math.max(0, me.rate + total);
    const isWinner = id === winnerId;

    // ================================================================
    // --- Ver5: 勲章の達成判定 ＆ 戦績・プロフィールの更新 ---
    // ================================================================
    let newlyUnlockedMedals = [];
    const profile = me.clientId ? getOrCreateProfile(me.clientId) : null;
    if (profile) {
      profile.stats.rateBattles += 1;
      if (isWinner) profile.stats.rateWins += 1; else profile.stats.rateLosses += 1;

      const checks = [
        // 赤の勲章: レート戦で敗北する
        ['red', !isWinner],
        // 青の勲章: レート戦で勝利する
        ['blue', isWinner],
        // 黄の勲章: 1回のレート戦で50回ジャンプする
        ['yellow', me.matchJumps >= 50],
        // 橙の勲章: レート戦でEX ULTを使う
        ['orange', me.matchUsedExUlt === true],
        // 紫の勲章: 合計被ダメージ99以内でレート戦に勝利する
        ['purple', isWinner && me.matchDamageTaken <= 99],
        // 白の勲章: レート1100（このマッチ終了後の新レートで判定）
        ['white', newRate >= 1100]
      ];
      for (const [medalId, achieved] of checks) {
        if (achieved && !profile.medalsUnlocked[medalId]) {
          profile.medalsUnlocked[medalId] = true;
          newlyUnlockedMedals.push(medalId);
        }
      }
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
      newlyUnlockedMedals
    });

    me.rate = newRate;

    // 個別に本人へ新規勲章獲得を通知（他プレイヤーには見せない）
    if (newlyUnlockedMedals.length > 0 && me.ws && me.ws.readyState === me.ws.OPEN) {
      me.ws.send(JSON.stringify({ type: '__medal_unlocked_batch', medals: newlyUnlockedMedals }));
    }

    // 次戦に備えてマッチ内トラッキング値をリセット
    me.matchJumps = 0;
    me.matchDamageTaken = 0;
    me.matchUsedExUlt = false;
  }

  broadcastToRoom(roomName, {
    type: '__rate_match_result',
    winnerId,
    disconnectedId,
    results
  });

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
    // --- Ver5: プロフィール（セットコメント・勲章・戦績）の永続化 ---
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

    // 勲章の装備選択（最大2つ、未達成の勲章は選択不可・重複可）
    if (data.type === '__profile_equip_medals') {
      const clientId = String(data.clientId || myClientId || '').slice(0, 64);
      const profile = getOrCreateProfile(clientId);
      if (!profile || !Array.isArray(data.medals)) return;
      const requested = data.medals.slice(0, 2).filter(id => MEDAL_IDS.includes(id) && profile.medalsUnlocked[id]);
      profile.medalsEquipped = requested;
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

    // --- 部屋の詳細情報の照会（未参加でも可・「合言葉で部屋に入る」プレビュー用） ---
    if (data.type === '__room_info_request') {
      const roomName = String(data.room || 'default').slice(0, 30);
      const room = rooms.get(roomName);
      if (!room) {
        socket.send(JSON.stringify({ type: '__room_info_result', room: roomName, exists: false }));
      } else {
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

      if (!data.isHost && !room.hostId) {
        socket.send(JSON.stringify({ type: '__no_host' }));
        if (isRoomNew) rooms.delete(roomName);
        return;
      }

      // --- レート戦は完全1vs1。既に2人揃っている、または試合進行中の部屋には
      //     （ホスト本人の瞬断再接続を除き）合言葉を知っていても乱入できない。
      if (!data.isHost && room.mode === 'rate' && (room.members.size >= RATE_MATCH_MEMBERS || room.matchActive)) {
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
          room.matchActive = true;
        }
      }

      const startRate = Number.isFinite(Number(data.rate)) ? Number(data.rate) : DEFAULT_RATE;

      room.members.set(myId, {
        ws: socket,
        name: String(data.name || '魔導士').slice(0, 20),
        history: [],
        rate: startRate,
        kills: 0,
        deaths: 0,
        clientId: myClientId,
        // --- Ver5: 勲章達成条件トラッキング（このマッチ内での値） ---
        matchJumps: 0,          // 黄の勲章: このレート戦でのジャンプ回数
        matchDamageTaken: 0,    // 紫の勲章: このレート戦での合計被ダメージ
        matchUsedExUlt: false,  // 橙の勲章: このレート戦でEX ULTを使用したか
        matchStartDistance: 0,  // 緑の勲章判定用の基準値（プロフィール側の累計距離）
        isFirstSpawnOfSession: true // 白の勲章: 初回スポーンかどうか
      });

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

    // ================================================================
    // --- Ver5: 勲章の達成条件トラッキング（クライアントからの申告値） ---
    // これらはチート耐性が高い項目ではないが、勲章はパッシブ強化に留まり
    // 対戦バランスへの影響が限定的なため、簡易的な申告ベースで運用する。
    // ================================================================

    // 移動距離の加算申告（フレーム単位で細かく送ると負荷が高いため、
    // クライアント側である程度まとめて送る想定）
    if (data.type === '__report_distance') {
      const meters = Number(data.meters);
      if (currentMember && Number.isFinite(meters) && meters > 0 && meters < 50) {
        // 明らかな異常値（1回の報告で50m超）は無視してチート耐性を持たせる
        const profile = myClientId ? getOrCreateProfile(myClientId) : null;
        if (profile) {
          profile.progress.totalDistanceM += meters;
          if (!profile.medalsUnlocked.green && profile.progress.totalDistanceM >= 3000) {
            profile.medalsUnlocked.green = true;
            socket.send(JSON.stringify({ type: '__medal_unlocked', medal: 'green' }));
          }
          scheduleProfileSave();
        }
      }
      return;
    }

    // ジャンプ報告（レート戦中のみ加算。黄の勲章判定用）
    if (data.type === '__report_jump') {
      if (currentMember && room.mode === 'rate' && room.matchActive) {
        currentMember.matchJumps += 1;
      }
      return;
    }

    // EX ULT使用報告（橙の勲章判定用）
    if (data.type === '__report_ex_ult_used') {
      if (currentMember && room.mode === 'rate' && room.matchActive) {
        currentMember.matchUsedExUlt = true;
      }
      return;
    }

    // 被ダメージ報告（紫の勲章判定用。被弾者本人が実際に受けた「軽減後」のダメージを申告する。
    // シールド・ガード等の軽減はクライアント側でしか正確に計算できないため、
    // 通常弾のhit_claimでの生ダメージ加算ではなく、被弾者本人の自己申告に一元化している）
    if (data.type === '__report_damage_taken') {
      const dmg = Number(data.amount);
      if (currentMember && room.mode === 'rate' && room.matchActive && Number.isFinite(dmg) && dmg > 0 && dmg < 1000) {
        currentMember.matchDamageTaken += dmg;
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
      if (data.targetId === myId) return; // 自傷申請は無視（勲章集計への誤加算防止も兼ねる）

      // 相手の過去の位置を巻き戻して復元
      const targetPos = getHistoricalPosition(targetMember.history, clientHitTime);
      if (!targetPos) {
        // 履歴がまだない場合は現在の最新位置で照合
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

    // --- レート戦の再戦（ホストのみ・決着済みの場合のみ） ---
    if (data.type === '__rematch') {
      if (room.hostId === myId && room.mode === 'rate' && !room.matchActive) {
        for (const m of room.members.values()) {
          m.kills = 0;
          m.deaths = 0;
          // Ver5: 勲章のマッチ内トラッキング値も次戦に備えて確実にリセットする
          // （finishRateMatchで既にリセット済みのはずだが、念のための防御）
          m.matchJumps = 0;
          m.matchDamageTaken = 0;
          m.matchUsedExUlt = false;
        }
        room.matchActive = true;
        broadcastToRoom(joinedRoom, { type: '__rematch_start' });
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
    if (!joinedRoom || !myId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    // --- レート戦中の切断は問答無用で切断側の反則負け ---
    // メンバーを削除する「前」に、切断時点のキル/デスでレート変動を確定させる。
    // （finishRateMatch はメンバー一覧を参照するため、削除前に呼ぶ必要がある）
    if (room.mode === 'rate' && room.matchActive) {
      const opponentIds = Array.from(room.members.keys()).filter(id => id !== myId);
      const winnerId = opponentIds.length > 0 ? opponentIds[0] : null;
      if (winnerId) {
        finishRateMatch(joinedRoom, winnerId, myId);
      } else {
        room.matchActive = false;
      }
    }

    room.members.delete(myId);
    if (room.hostId === myId) room.hostId = null;
    broadcastToRoom(joinedRoom, { type: '__left', id: myId, count: room.members.size }, myId);
    if (room.members.size === 0) rooms.delete(joinedRoom);
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

server.listen(PORT, () => {
  console.log(`Rewind & CCD Authoritative Server listening on port ${PORT}`);
});
