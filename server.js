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

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

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
function finishRateMatch(roomName, winnerId) {
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
    const { total } = calcRateChange(me.rate, avgOppRate, me.kills, me.deaths, didLose);
    const newRate = Math.max(0, me.rate + total);

    results.push({
      id,
      name: me.name,
      kills: me.kills,
      deaths: me.deaths,
      oldRate: me.rate,
      newRate,
      delta: total,
      isWinner: id === winnerId
    });

    me.rate = newRate;
  }

  broadcastToRoom(roomName, {
    type: '__rate_match_result',
    winnerId,
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

      if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
        socket.send(JSON.stringify({ type: '__room_full' }));
        socket.close();
        return;
      }

      myId = makeId();
      joinedRoom = roomName;

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
        deaths: 0
      });

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
    room.members.delete(myId);
    if (room.hostId === myId) room.hostId = null;
    if (room.mode === 'rate' && room.matchActive && room.members.size < 2) {
      room.matchActive = false;
    }
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
