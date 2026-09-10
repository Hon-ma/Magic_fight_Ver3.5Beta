// 3D Magic FPS Duel 用 中継サーバー
//
// やっていることはとてもシンプルです。
// ・クライアント（ゲーム画面）がWebSocketで繋いでくる
// ・最初に { type: '__join', room: '合言葉', name: '名前', isHost, stage } を送ってもらう
// ・同じ room に入っている人たち同士でメッセージを転送しあうだけ
//
// ゲームのルール（誰が勝った、ダメージ計算など）はここには一切書かれていません。
// あくまで「届いたものを、同じ部屋の他の人に渡す」だけの郵便屋さんです。

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS_PER_ROOM = 4;

// roomName -> { stage: string|null, members: Map<id, { ws, name }> }
const rooms = new Map();

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function getOrCreateRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, { stage: null, members: new Map() });
  }
  return rooms.get(roomName);
}

function broadcastToRoom(roomName, payload, excludeId) {
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

// Renderがサーバーの生存確認に使う簡単なヘルスチェック用エンドポイント
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Magic Fight relay server is running.\n');
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
      return; // JSONとして読めないメッセージは無視
    }

    // --- 部屋への参加 ---
    if (data.type === '__join') {
      if (joinedRoom) return; // 二重参加は無視

      const roomName = String(data.room || 'default').slice(0, 30);
      const room = getOrCreateRoom(roomName);

      if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
        socket.send(JSON.stringify({ type: '__room_full' }));
        socket.close();
        return;
      }

      myId = makeId();
      joinedRoom = roomName;

      // ホストとして参加してきた人が、まだ誰も決めていないステージを指定していたら採用する
      if (data.isHost && !room.stage && data.stage) {
        room.stage = data.stage;
      }

      room.members.set(myId, { ws: socket, name: String(data.name || '魔導士').slice(0, 20) });

      socket.send(JSON.stringify({ type: '__joined', id: myId, stage: room.stage }));

      // 既存メンバーへ、人数の更新を知らせる
      broadcastToRoom(roomName, { type: '__joined_other', count: room.members.size }, myId);

      // ホストが（すでに他の人がいる部屋に）新しくステージを確定させた場合は、全員に配り直す
      if (data.isHost && room.stage) {
        broadcastToRoom(roomName, { type: '__stage_update', stage: room.stage }, myId);
      }
      return;
    }

    // --- それ以外は全部「中継」するだけ ---
    // 送信者のIDを付けて、同じ部屋の他のメンバー全員に転送する。
    if (!joinedRoom || !myId) return;
    broadcastToRoom(joinedRoom, { ...data, senderId: myId }, myId);
  });

  socket.on('close', () => {
    if (!joinedRoom || !myId) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.members.delete(myId);
    broadcastToRoom(joinedRoom, { type: '__left', id: myId, count: room.members.size }, myId);
    if (room.members.size === 0) rooms.delete(joinedRoom);
  });
});

// Renderのプロキシが「何も流れていない接続」を切ってしまわないよう、
// 定期的にping/pongを送って生存確認する。反応がない接続は掃除する。
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
  console.log(`Relay server listening on port ${PORT}`);
});
