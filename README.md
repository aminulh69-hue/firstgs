# ⚽ First Goalscorer — Lineup Lock

A lightweight, fun party game for a live football match. When the lineups drop (~1 hour
before kickoff), up to **8 players** join from their own phones and **reserve** a player
from either team as their first-goalscorer pick. **First come, first served** — once a
player is locked, nobody else can take them. When the first goal goes in, the host taps
the scorer and the winner is revealed.

## Run it

```bash
npm install
npm start
```

Open the printed URL (default http://localhost:3000).

- **Host:** click **Create a game** → load lineups → **Open picks**. Share the 4-letter
  code or link.
- **Players:** open the link (or enter the code on the home page), type a name, and tap a
  player to lock them in.

To let phones on the same Wi-Fi connect, share `http://<your-computer-ip>:3000`.
Set a custom port with `PORT=8080 npm start`.

## Loading lineups

1. **BBC import (best-effort):** paste a BBC Sport match link and click **Import**. BBC
   blocks bots and renders lineups in the browser, so this may not always work.
2. **Manual (always works):** type/paste each team's name and players — one per line,
   optional shirt number first, e.g. `9 Harry Kane`. Auto-imported lineups are editable.

## How it works

- **Backend:** Node + Express + Socket.IO, all room state in memory (no database). Node's
  single thread makes the "first-come" lock naturally atomic.
- **Frontend:** plain HTML/CSS/JS, mobile-first, no build step.
- **Reconnect:** your pick survives a refresh (stored in `localStorage`).

## Game flow

1. Host creates a room and loads the two lineups.
2. Host opens picks; players join (max 8) and each lock exactly one player.
3. A locked player turns gold with the claimer's name, live on every device.
4. Host closes picks at kickoff (locks the board).
5. On the first goal, host taps the scorer → the matching player wins 🏆 (or "no winner"
   for an own goal / unpicked scorer, via the host's own-goal button).

## Test

With the server running in another terminal:

```bash
npm test
```

Covers the claim race (exactly one winner), one-pick-per-player rule, the 8-player cap,
and winner resolution.
