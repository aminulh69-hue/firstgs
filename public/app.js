/* global io */
'use strict';

/* --------------------------------- shared --------------------------------- */
function toast(msg, err) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const statusLabel = { lobby: 'lobby', open: 'open', closed: 'locked' };

function money(n) {
  return '£' + (Number(n) || 0).toFixed(2);
}

/**
 * Render the two-column board.
 * opts: { myId, mode: 'play'|'host', onClick(playerId, taken, mine) }
 */
function renderBoard(mount, state, opts = {}) {
  if (!state.teams) {
    mount.innerHTML = '<div class="card muted center">Waiting for the host to load the lineups…</div>';
    return;
  }
  const sides = [
    ['home', state.teams.home],
    ['away', state.teams.away],
  ];
  const scorer = state.firstScorerPlayerId;

  mount.innerHTML = `<div class="board">${sides
    .map(([key, team]) => {
      const items = team.players
        .map((p) => {
          const pick = state.picks[p.id];
          const taken = !!pick;
          const mine = taken && pick.participantId === opts.myId;
          const isWinner = scorer && scorer === p.id;
          const isSelected = !taken && opts.selectedId === p.id;
          const cls = [
            'player',
            taken ? 'taken' : '',
            mine ? 'mine' : '',
            isSelected ? 'selected' : '',
            isWinner ? 'winner' : '',
            opts.mode === 'play' && (taken && !mine) ? 'notclickable' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const holder = taken
            ? `<span class="holder">${isWinner ? '🏆 ' : ''}${esc(pick.displayName)}</span>` +
              (pick.price != null ? `<span class="price">${money(pick.price)}</span>` : '')
            : '';
          const num = p.number != null ? p.number : '·';
          return `<li class="${cls}" data-id="${esc(p.id)}" data-taken="${taken}" data-mine="${mine}">
            <span class="num">${esc(num)}</span>
            <span class="pname">${esc(p.name)}</span>
            ${holder}
          </li>`;
        })
        .join('');
      return `<div class="team ${key}">
        <h2><span class="dot"></span>${esc(team.name)}</h2>
        <ul class="players">${items}</ul>
      </div>`;
    })
    .join('')}</div>`;

  if (opts.onClick) {
    mount.querySelectorAll('.player').forEach((el) => {
      el.addEventListener('click', () =>
        opts.onClick(el.dataset.id, el.dataset.taken === 'true', el.dataset.mine === 'true')
      );
    });
  }
}

function parsePlayers(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{1,2})[\s.).-]+(.+)$/);
      if (m) return { number: parseInt(m[1], 10), name: m[2].trim() };
      return { number: null, name: line };
    });
}

function playersToText(players) {
  return (players || [])
    .map((p) => (p.number != null ? `${p.number} ${p.name}` : p.name))
    .join('\n');
}

/**
 * Parse a pasted blob of both line-ups into { home, away }.
 * Each team is a block of lines: first line = team name, rest = players.
 * Teams are separated by one or more blank lines. Returns null if it can't
 * find two teams.
 */
function parseBlob(text) {
  const blocks = String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n+/) // split on blank line(s)
    .map((b) =>
      b
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
    .filter((b) => b.length);

  if (blocks.length < 2) return null;

  const toTeam = (lines) => ({
    name: lines[0],
    players: parsePlayers(lines.slice(1).join('\n')),
  });

  const home = toTeam(blocks[0]);
  const away = toTeam(blocks[1]);
  if (!home.players.length || !away.players.length) return null;
  return { home, away };
}

/* ================================ HOST PAGE =============================== */
const HostPage = {
  socket: null,
  state: null,
  code: null,

  init() {
    this.socket = io();
    const $ = (id) => document.getElementById(id);

    this.socket.on('connect', () => this.connectOrResume());
    this.socket.on('state', (s) => this.onState(s));

    $('copyLink').onclick = () => {
      const inp = $('shareLink');
      navigator.clipboard?.writeText(inp.value);
      toast('Link copied');
    };
    $('fillFromBlob').onclick = () => this.fillFromBlob();
    $('saveBtn').onclick = () => this.saveLineups(false);
    $('openBtn').onclick = () => this.saveLineups(true);
    $('closeBtn').onclick = () => this.socket.emit('host:close', (r) => this.ack(r, 'Picks locked'));
    $('reopenBtn').onclick = () => this.socket.emit('host:open', (r) => this.ack(r, 'Picks re-opened'));
    $('ownGoalBtn').onclick = () =>
      this.socket.emit('host:declareScorer', { playerId: null }, (r) => this.ack(r, 'Marked: no winner'));
    $('resetBtn').onclick = () => {
      if (confirm('Clear everyone’s picks and start fresh?'))
        this.socket.emit('host:reset', (r) => this.ack(r, 'Reset done'));
    };
  },

  connectOrResume() {
    const saved = JSON.parse(localStorage.getItem('fgs_host') || 'null');
    if (saved && saved.code && saved.hostToken) {
      this.socket.emit('host:resume', saved, (r) => {
        if (r && r.ok) {
          this.code = saved.code;
          this.onState(r.state);
        } else {
          this.create();
        }
      });
    } else {
      this.create();
    }
  },

  create() {
    this.socket.emit('host:create', (r) => {
      this.code = r.code;
      localStorage.setItem('fgs_host', JSON.stringify({ code: r.code, hostToken: r.hostToken }));
    });
  },

  ack(r, okMsg) {
    if (r && r.error) toast(r.error, true);
    else if (okMsg) toast(okMsg);
  },

  fillFromBlob() {
    const text = document.getElementById('blobPaste').value;
    const teams = parseBlob(text);
    if (!teams) {
      return toast('Could not read two teams — separate them with a blank line', true);
    }
    document.getElementById('homeName').value = teams.home.name || '';
    document.getElementById('awayName').value = teams.away.name || '';
    document.getElementById('homePlayers').value = playersToText(teams.home.players);
    document.getElementById('awayPlayers').value = playersToText(teams.away.players);
    document.getElementById('importMsg').textContent =
      `Filled ${teams.home.name} (${teams.home.players.length}) vs ${teams.away.name} (${teams.away.players.length}) — check below, then Open picks.`;
    toast('Teams filled ✓');
  },

  collectTeams() {
    return {
      home: {
        name: document.getElementById('homeName').value.trim(),
        players: parsePlayers(document.getElementById('homePlayers').value),
      },
      away: {
        name: document.getElementById('awayName').value.trim(),
        players: parsePlayers(document.getElementById('awayPlayers').value),
      },
    };
  },

  saveLineups(thenOpen) {
    const teams = this.collectTeams();
    if (!teams.home.name || !teams.away.name) return toast('Enter both team names', true);
    if (teams.home.players.length < 1 || teams.away.players.length < 1)
      return toast('Add players to both teams', true);
    this.socket.emit('host:setLineups', { teams }, (r) => {
      if (r && r.error) return toast(r.error, true);
      toast('Lineups saved');
      if (thenOpen) this.socket.emit('host:open', (r2) => this.ack(r2, 'Picks are open!'));
    });
  },

  onState(s) {
    this.state = s;
    this.code = s.code;
    const $ = (id) => document.getElementById(id);

    $('roomCode').textContent = s.code;
    const link = `${location.origin}/game.html?room=${s.code}`;
    $('shareLink').value = link;

    const pill = $('statusPill');
    pill.textContent = statusLabel[s.status];
    pill.className = 'pill ' + s.status;
    const pill2 = $('statusPill2');
    if (pill2) { pill2.textContent = statusLabel[s.status]; pill2.className = 'pill ' + s.status; }
    $('playerCountChip').textContent = `${s.playerCount} / ${s.maxPlayers} players`;
    if ($('potChip') && s.pricing) $('potChip').textContent = `Pot ${money(s.pricing.pot)}`;

    // If picks are running, surface the live controls.
    const live = s.status === 'open' || s.status === 'closed';
    $('liveCard').classList.toggle('hidden', !live);

    // Prefill setup fields from saved lineups (only when not yet open, to avoid clobbering edits).
    if (s.teams && s.status === 'lobby') {
      // leave host's in-progress edits alone
    }

    // Board: host can click a player to declare the first scorer.
    const mount = $('boardMount');
    renderBoard(mount, s, {
      mode: 'host',
      onClick: (playerId) => {
        if (s.status === 'lobby') return;
        const p = this.findPlayer(playerId);
        if (!p) return;
        if (confirm(`Mark ${p.name} as the FIRST goalscorer?`)) {
          this.socket.emit('host:declareScorer', { playerId }, (r) => this.ack(r, 'Winner revealed! 🏆'));
        }
      },
    });
  },

  findPlayer(id) {
    if (!this.state || !this.state.teams) return null;
    return [...this.state.teams.home.players, ...this.state.teams.away.players].find((p) => p.id === id);
  },
};

/* ================================ GAME PAGE =============================== */
const GamePage = {
  socket: null,
  state: null,
  code: null,
  myId: null,
  pendingPlayerId: null,

  init() {
    const params = new URLSearchParams(location.search);
    this.code = (params.get('room') || '').toUpperCase();
    if (!this.code) { location.href = '/'; return; }

    document.getElementById('joinCode').textContent = this.code;
    const pending = sessionStorage.getItem('pendingName');
    if (pending) document.getElementById('name').value = pending;

    this.socket = io();
    this.socket.on('state', (s) => this.onState(s));
    this.socket.on('connect', () => this.tryResume());

    document.getElementById('joinBtn').onclick = () => this.join();
    document.getElementById('lockBtn').onclick = () => this.lockIn();
    document.getElementById('releaseBtn').onclick = () => {
      this.pendingPlayerId = null;
      this.socket.emit('player:release', (r) => { if (r && r.error) toast(r.error, true); });
    };
  },

  lockIn() {
    const s = this.state;
    if (!this.pendingPlayerId) return toast('Select a player first', true);
    if (!s || s.status !== 'open') return toast('Picks aren’t open', true);
    if (s.picks[this.pendingPlayerId]) {
      this.pendingPlayerId = null;
      this.onState(s);
      return toast('Already taken — pick someone else', true);
    }
    this.socket.emit('player:claim', { playerId: this.pendingPlayerId }, (r) => {
      if (r && r.error) {
        this.pendingPlayerId = null;
        this.onState(this.state);
        toast(r.error, true);
      } else {
        this.pendingPlayerId = null;
        toast('Locked in! 🔒');
      }
    });
  },

  savedId() {
    const map = JSON.parse(localStorage.getItem('fgs_player') || '{}');
    return map[this.code] || null;
  },
  storeId(id) {
    const map = JSON.parse(localStorage.getItem('fgs_player') || '{}');
    map[this.code] = id;
    localStorage.setItem('fgs_player', JSON.stringify(map));
  },

  tryResume() {
    const id = this.savedId();
    if (!id) {
      // Subscribe so we can show the board even before joining.
      this.socket.emit('subscribe', { code: this.code }, (r) => {
        if (r && r.error) toast(r.error, true);
        else if (r && r.state) this.onState(r.state);
      });
      return;
    }
    this.socket.emit('player:join', { code: this.code, participantId: id }, (r) => {
      if (r && r.ok) { this.myId = r.participantId; this.enterPlay(r.state); }
      else this.socket.emit('subscribe', { code: this.code });
    });
  },

  join() {
    const name = document.getElementById('name').value.trim();
    if (!name) return toast('Enter your name', true);
    this.socket.emit('player:join', { code: this.code, displayName: name, participantId: this.savedId() }, (r) => {
      if (r && r.error) { document.getElementById('joinMsg').textContent = r.error; return toast(r.error, true); }
      this.myId = r.participantId;
      this.storeId(r.participantId);
      sessionStorage.removeItem('pendingName');
      this.enterPlay(r.state);
    });
  },

  enterPlay(s) {
    document.getElementById('joinCard').classList.add('hidden');
    document.getElementById('playArea').classList.remove('hidden');
    this.onState(s);
  },

  onState(s) {
    this.state = s;
    const $ = (id) => document.getElementById(id);

    const pill = $('statusPill');
    if (pill) { pill.textContent = statusLabel[s.status]; pill.className = 'pill ' + s.status; }
    if ($('countChip')) $('countChip').textContent = `${s.playerCount} / ${s.maxPlayers}`;

    const me = this.myId ? s.participants[this.myId] : null;
    const myPickId = me ? me.pickPlayerId : null;
    const myPick = myPickId ? this.findPlayer(myPickId) : null;

    if ($('meChip')) $('meChip').textContent = me ? `You: ${me.displayName}` : 'Spectating';

    // My pick card
    const relBtn = $('releaseBtn');
    const lockBtn = $('lockBtn');
    const nextPrice = s.pricing ? s.pricing.next : null;
    const myPrice = myPickId && s.picks[myPickId] ? s.picks[myPickId].price : null;

    // Clear a stale selection (locked already, or the player got taken).
    if (myPickId || (this.pendingPlayerId && s.picks[this.pendingPlayerId])) {
      this.pendingPlayerId = null;
    }
    const pending = this.pendingPlayerId ? this.findPlayer(this.pendingPlayerId) : null;

    if (myPick) {
      $('myPickTitle').textContent = `Your pick: ${myPick.name} — ${money(myPrice)}`;
      $('myPickSub').textContent = s.status === 'open'
        ? 'Locked in. Release it to choose someone else (you’ll be re-priced at the current rate).'
        : 'Picks are locked. Good luck!';
      lockBtn.classList.add('hidden');
      relBtn.classList.toggle('hidden', s.status !== 'open');
    } else {
      relBtn.classList.add('hidden');
      const canPick = me && s.status === 'open';
      if (pending && canPick) {
        $('myPickTitle').textContent = `Selected: ${pending.name}`;
        $('myPickSub').textContent = `Tap a different row to change, or lock it in for ${money(nextPrice)} (price rises 50p per pick).`;
        lockBtn.textContent = `🔒 Lock in ${pending.name} — ${money(nextPrice)}`;
        lockBtn.classList.remove('hidden');
      } else {
        $('myPickTitle').textContent = me ? 'Pick your first goalscorer' : 'Watching the board';
        $('myPickSub').textContent = canPick
          ? `Tap any player to select them — tap around freely. Next lock-in costs ${money(nextPrice)}.`
          : (s.status === 'closed' ? 'Picks are locked.' : 'Waiting for the host to open picks…');
        lockBtn.classList.add('hidden');
      }
    }

    if ($('potChip') && s.pricing) $('potChip').textContent = `Pot ${money(s.pricing.pot)}`;

    // Result banner
    this.renderResult(s, myPickId);

    // Board
    renderBoard($('boardMount'), s, {
      mode: 'play',
      myId: this.myId,
      selectedId: this.pendingPlayerId,
      onClick: (playerId, taken, mine) => this.onPlayerClick(playerId, taken, mine),
    });
  },

  renderResult(s, myPickId) {
    const el = document.getElementById('resultBanner');
    if (!s.firstScorerPlayerId && s.firstScorerPlayerId !== null) { el.innerHTML = ''; return; }
    // firstScorerPlayerId is null until declared; distinguish "not declared" from "no winner"
    if (s.firstScorerPlayerId === null) {
      // Could be undeclared OR declared-own-goal. We can't tell from null alone here,
      // so only show "no winner" handling via the winner highlight path below.
      el.innerHTML = '';
      return;
    }
    const scorer = this.findPlayer(s.firstScorerPlayerId);
    const pick = s.picks[s.firstScorerPlayerId];
    if (!scorer) { el.innerHTML = ''; return; }
    if (pick) {
      const iWon = myPickId === s.firstScorerPlayerId;
      el.innerHTML = `<div class="banner win">🏆 ${esc(pick.displayName)} called it! ${esc(scorer.name)} scored first.${iWon ? ' That’s you! 🎉' : ''}</div>`;
    } else {
      el.innerHTML = `<div class="banner lose">${esc(scorer.name)} scored first — nobody picked them. No winner this time.</div>`;
    }
  },

  onPlayerClick(playerId, taken, mine) {
    const s = this.state;
    if (!s) return;
    if (!this.myId) return toast('Join the game to pick', true);
    if (s.status !== 'open') return toast(s.status === 'closed' ? 'Picks are locked' : 'Picks aren’t open yet', true);
    const me = s.participants[this.myId];
    if (me && me.pickPlayerId) return toast('Release your pick first to change it', true);
    if (taken) return toast('Already taken — pick someone else', true);
    // Just select (toggle) — locking happens via the Lock in button.
    this.pendingPlayerId = this.pendingPlayerId === playerId ? null : playerId;
    this.onState(s);
  },

  findPlayer(id) {
    if (!this.state || !this.state.teams) return null;
    return [...this.state.teams.home.players, ...this.state.teams.away.players].find((p) => p.id === id);
  },
};
