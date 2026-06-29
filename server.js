'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { fetchBbcLineups } = require('./lib/bbcLineups');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const BASE_PRICE = 3.0; // first lock-in costs this much
const PRICE_STEP = 0.5; // every subsequent lock-in costs 50p more

/** Price for the next lock-in given how many players are already locked in. */
function priceForNextPick(picksMade) {
  return Math.round((BASE_PRICE + PRICE_STEP * picksMade) * 100) / 100;
}

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- room state ------------------------------- */
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    status: 'lobby', // 'lobby' | 'open' | 'closed'
    hostToken: crypto.randomUUID(),
    teams: null, // { home:{name,players:[{id,name,number}]}, away:{...} }
    picks: {}, // playerId -> { participantId, displayName, ts }
    participants: {}, // participantId -> { displayName, pickPlayerId|null }
    firstScorerPlayerId: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

/** Public view of a room (no host token). */
function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    teams: room.teams,
    picks: room.picks,
    participants: Object.fromEntries(
      Object.entries(room.participants).map(([id, p]) => [
        id,
        { displayName: p.displayName, pickPlayerId: p.pickPlayerId },
      ])
    ),
    firstScorerPlayerId: room.firstScorerPlayerId,
    playerCount: Object.keys(room.participants).length,
    maxPlayers: MAX_PLAYERS,
    pricing: {
      base: BASE_PRICE,
      step: PRICE_STEP,
      next: priceForNextPick(Object.keys(room.picks).length),
      pot: Object.values(room.picks).reduce((sum, p) => sum + (p.price || 0), 0),
    },
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function normaliseTeams(teams) {
  const side = (t) => ({
    name: String(t?.name || '').slice(0, 60) || 'Team',
    players: (Array.isArray(t?.players) ? t.players : [])
      .map((p, i) => ({
        id: p.id || `${crypto.randomUUID().slice(0, 8)}`,
        name: String(p?.name || '').slice(0, 60),
        number: p?.number ?? null,
      }))
      .filter((p) => p.name)
      .slice(0, 30),
  });
  return { home: side(teams?.home), away: side(teams?.away) };
}

function allPlayerIds(room) {
  if (!room.teams) return new Set();
  return new Set(
    [...room.teams.home.players, ...room.teams.away.players].map((p) => p.id)
  );
}

/* ------------------------------- HTTP API --------------------------------- */
app.post('/api/import-bbc', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const teams = await fetchBbcLineups(url);
    if (!teams) {
      return res.json({
        ok: false,
        reason:
          'Could not read lineups from that link automatically. Enter them manually below.',
      });
    }
    return res.json({ ok: true, teams });
  } catch {
    return res.json({ ok: false, reason: 'Import failed. Enter lineups manually.' });
  }
});

/* ----------------------------- socket handlers ---------------------------- */
io.on('connection', (socket) => {
  // socket-scoped identity
  let joinedCode = null;
  let participantId = null;
  let isHost = false;

  function getRoom() {
    return joinedCode ? rooms.get(joinedCode) : null;
  }

  socket.on('host:create', (ack) => {
    const room = createRoom();
    joinedCode = room.code;
    isHost = true;
    socket.join(room.code);
    if (typeof ack === 'function') {
      ack({ code: room.code, hostToken: room.hostToken });
    }
    broadcast(room);
  });

  socket.on('host:resume', ({ code, hostToken } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || room.hostToken !== hostToken) {
      return ack?.({ error: 'Room not found' });
    }
    joinedCode = room.code;
    isHost = true;
    socket.join(room.code);
    ack?.({ ok: true, state: publicState(room) });
  });

  socket.on('host:setLineups', ({ teams } = {}, ack) => {
    const room = getRoom();
    if (!room || !isHost) return ack?.({ error: 'Not authorised' });
    if (room.status === 'closed') return ack?.({ error: 'Game is closed' });
    room.teams = normaliseTeams(teams);
    // Drop any picks that point at players no longer present.
    const ids = allPlayerIds(room);
    for (const pid of Object.keys(room.picks)) {
      if (!ids.has(pid)) {
        const owner = room.participants[room.picks[pid].participantId];
        if (owner) owner.pickPlayerId = null;
        delete room.picks[pid];
      }
    }
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('host:open', (ack) => {
    const room = getRoom();
    if (!room || !isHost) return ack?.({ error: 'Not authorised' });
    if (!room.teams) return ack?.({ error: 'Set lineups first' });
    room.status = 'open';
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('host:close', (ack) => {
    const room = getRoom();
    if (!room || !isHost) return ack?.({ error: 'Not authorised' });
    room.status = 'closed';
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('host:declareScorer', ({ playerId } = {}, ack) => {
    const room = getRoom();
    if (!room || !isHost) return ack?.({ error: 'Not authorised' });
    // null = own goal / nobody (no winner)
    if (playerId !== null && !allPlayerIds(room).has(playerId)) {
      return ack?.({ error: 'Unknown player' });
    }
    room.firstScorerPlayerId = playerId;
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('host:reset', (ack) => {
    const room = getRoom();
    if (!room || !isHost) return ack?.({ error: 'Not authorised' });
    room.firstScorerPlayerId = null;
    room.picks = {};
    for (const p of Object.values(room.participants)) p.pickPlayerId = null;
    room.status = room.teams ? 'open' : 'lobby';
    ack?.({ ok: true });
    broadcast(room);
  });

  /* ----- players ----- */
  socket.on('player:join', ({ code, displayName, participantId: existingId } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return ack?.({ error: 'Room not found. Check the code.' });

    // Reconnect with an existing id keeps the same seat.
    if (existingId && room.participants[existingId]) {
      participantId = existingId;
      if (displayName) {
        room.participants[participantId].displayName = cleanName(displayName);
      }
    } else {
      const name = cleanName(displayName);
      if (!name) return ack?.({ error: 'Enter your name first.' });
      if (Object.keys(room.participants).length >= MAX_PLAYERS) {
        return ack?.({ error: `Game is full (max ${MAX_PLAYERS} players).` });
      }
      participantId = crypto.randomUUID();
      room.participants[participantId] = { displayName: name, pickPlayerId: null };
    }

    joinedCode = room.code;
    socket.join(room.code);
    ack?.({ ok: true, participantId, state: publicState(room) });
    broadcast(room);
  });

  socket.on('player:claim', ({ playerId } = {}, ack) => {
    const room = getRoom();
    if (!room || !participantId) return ack?.({ error: 'Join the game first.' });
    if (room.status !== 'open') return ack?.({ error: 'Picks are not open.' });
    if (!allPlayerIds(room).has(playerId)) return ack?.({ error: 'Unknown player.' });

    // First-come, first-served. Single-threaded => atomic.
    if (room.picks[playerId]) {
      return ack?.({ error: 'Too late — already taken!' });
    }
    const me = room.participants[participantId];
    if (me.pickPlayerId) {
      return ack?.({ error: 'You already have a pick. Release it first.' });
    }
    room.picks[playerId] = {
      participantId,
      displayName: me.displayName,
      ts: Date.now(),
      price: priceForNextPick(Object.keys(room.picks).length),
    };
    me.pickPlayerId = playerId;
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('player:release', (ack) => {
    const room = getRoom();
    if (!room || !participantId) return ack?.({ error: 'Join the game first.' });
    if (room.status !== 'open') return ack?.({ error: 'Picks are locked.' });
    const me = room.participants[participantId];
    if (me.pickPlayerId) {
      delete room.picks[me.pickPlayerId];
      me.pickPlayerId = null;
    }
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('subscribe', ({ code } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return ack?.({ error: 'Room not found' });
    joinedCode = room.code;
    socket.join(room.code);
    ack?.({ ok: true, state: publicState(room) });
  });
});

function cleanName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

server.listen(PORT, () => {
  console.log(`\n  ⚽  First Goalscorer running:`);
  console.log(`      http://localhost:${PORT}\n`);
});
