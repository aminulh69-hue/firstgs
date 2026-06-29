const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const mk = () => io(URL, { transports: ['websocket'], forceNew: true });
const p = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const pNoArg = (s, ev) => new Promise((res) => s.emit(ev, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = [];
  const log = (...a) => out.push(a.join(' '));

  // Host
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const created = await pNoArg(host, 'host:create');
  log('1. room created:', created.code, '(hostToken len ' + created.hostToken.length + ')');
  const code = created.code;

  const teams = {
    home: { name: 'England', players: [{ number: 9, name: 'Kane' }, { number: 10, name: 'Bellingham' }, { number: 7, name: 'Saka' }] },
    away: { name: 'France', players: [{ number: 10, name: 'Mbappe' }, { number: 9, name: 'Giroud' }] },
  };
  const setR = await p(host, 'host:setLineups', { teams });
  log('2. setLineups:', JSON.stringify(setR));
  const openR = await pNoArg(host, 'host:open');
  log('3. open:', JSON.stringify(openR));

  // capture state to learn player ids
  let lastState = null;
  host.on('state', (s) => (lastState = s));
  // subscribe to get a fresh state
  const sub = await p(host, 'subscribe', { code });
  lastState = sub.state;
  const kane = lastState.teams.home.players.find((x) => x.name === 'Kane').id;
  const mbappe = lastState.teams.away.players.find((x) => x.name === 'Mbappe').id;

  // Players A and B both want Kane
  const A = mk(); await new Promise((r) => A.on('connect', r));
  const B = mk(); await new Promise((r) => B.on('connect', r));
  const ja = await p(A, 'player:join', { code, displayName: 'Alice' });
  const jb = await p(B, 'player:join', { code, displayName: 'Bob' });
  log('4. joins ok:', !!ja.ok, !!jb.ok);

  // Race for Kane simultaneously
  const [ra, rb] = await Promise.all([
    p(A, 'player:claim', { playerId: kane }),
    p(B, 'player:claim', { playerId: kane }),
  ]);
  const aWon = !!ra.ok, bWon = !!rb.ok;
  log('5. race for Kane -> Alice:', JSON.stringify(ra), '| Bob:', JSON.stringify(rb));
  log('   exactly one winner:', (aWon ^ bWon) ? 'PASS' : 'FAIL');

  // The loser takes Mbappe
  const loser = aWon ? B : A;
  const rl = await p(loser, 'player:claim', { playerId: mbappe });
  log('6. loser claims Mbappe:', JSON.stringify(rl));

  // Loser tries to claim a second player (Giroud) -> should fail (already has a pick)
  const giroud = lastState.teams.away.players.find((x) => x.name === 'Giroud').id;
  const rdouble = await p(loser, 'player:claim', { playerId: giroud });
  log('7. double-pick rejected:', rdouble.error ? 'PASS (' + rdouble.error + ')' : 'FAIL');

  // 9-player cap: join 6 more (already 2) => 8 ok, 9th rejected
  let capMsg = '';
  for (let i = 3; i <= 9; i++) {
    const s = mk(); await new Promise((r) => s.on('connect', r));
    const r = await p(s, 'player:join', { code, displayName: 'P' + i });
    if (i === 8) capMsg += '8th ok:' + (!!r.ok) + ' ';
    if (i === 9) capMsg += '9th rejected:' + (r.error ? 'PASS (' + r.error + ')' : 'FAIL');
  }
  log('8. cap test ->', capMsg);

  // Declare Kane as first scorer
  const decl = await p(host, 'host:declareScorer', { playerId: kane });
  await sleep(100);
  const winnerPick = lastState.picks[kane];
  log('9. declareScorer:', JSON.stringify(decl), '| winner =', winnerPick ? winnerPick.displayName : '(none)');

  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
