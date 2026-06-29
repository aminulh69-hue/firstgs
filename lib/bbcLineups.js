'use strict';

/**
 * Best-effort BBC Sport lineup extraction.
 *
 * BBC has no public API, blocks bots, and renders lineups client-side, so this
 * cannot be guaranteed to work. It tries a few strategies against the embedded
 * JSON that BBC ships in the page, and returns null on any failure so the caller
 * can fall back to manual entry.
 *
 * Returns: { home: {name, players:[{name, number}]}, away: {...} } | null
 */

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function fetchBbcLineups(url) {
  if (!isBbcSportUrl(url)) return null;
  let html;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  return parseLineupsFromHtml(html);
}

function isBbcSportUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)bbc\.co\.uk$|(^|\.)bbc\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function parseLineupsFromHtml(html) {
  for (const blob of extractJsonBlobs(html)) {
    let data;
    try {
      data = JSON.parse(blob);
    } catch {
      continue;
    }
    const teams = findTeamsInObject(data);
    if (teams) return teams;
  }
  return null;
}

/** Pull candidate JSON strings out of the HTML (state scripts + ld+json). */
function extractJsonBlobs(html) {
  const blobs = [];
  // window.__SOMETHING__ = { ... };
  const assignRe = /window\.__[A-Z0-9_]+__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/g;
  let m;
  while ((m = assignRe.exec(html))) blobs.push(m[1]);
  // <script type="application/json" ...>{...}</script>
  const scriptRe =
    /<script[^>]*type=["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/g;
  while ((m = scriptRe.exec(html))) blobs.push(m[1].trim());
  return blobs;
}

/**
 * Recursively search a parsed object for a pair of team-lineup-shaped nodes.
 * Looks for objects that carry a team name and a list of players with names.
 */
function findTeamsInObject(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];

  while (stack.length && found.length < 8) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const team = asTeam(node);
    if (team && team.players.length >= 7) found.push(team);

    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
    } else {
      for (const k of Object.keys(node)) stack.push(node[k]);
    }
  }

  if (found.length >= 2) {
    // De-dup by team name, keep the two richest lineups.
    const byName = new Map();
    for (const t of found) {
      const prev = byName.get(t.name);
      if (!prev || t.players.length > prev.players.length) byName.set(t.name, t);
    }
    const list = [...byName.values()]
      .sort((a, b) => b.players.length - a.players.length)
      .slice(0, 2);
    if (list.length === 2) return { home: list[0], away: list[1] };
  }
  return null;
}

/** If `node` looks like a team with a lineup, normalise it; else null. */
function asTeam(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

  const name =
    pickString(node, ['name', 'teamName', 'fullName', 'shortName', 'displayName']) || null;

  // Find an array of player-like objects somewhere on this node.
  let playerArr = null;
  for (const key of ['players', 'lineup', 'startingXI', 'starting', 'squad', 'formation']) {
    if (Array.isArray(node[key]) && node[key].length) {
      playerArr = node[key];
      break;
    }
  }
  if (!playerArr) {
    // Sometimes players hang off a nested object.
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v) && v.length && v.every(looksLikePlayer)) {
        playerArr = v;
        break;
      }
    }
  }
  if (!playerArr || !name) return null;

  const players = playerArr
    .filter(looksLikePlayer)
    .map((p) => ({
      name: pickString(p, ['name', 'fullName', 'displayName', 'lastName']) || '',
      number: pickNumber(p, ['number', 'shirtNumber', 'squadNumber', 'jerseyNumber']),
    }))
    .filter((p) => p.name);

  if (players.length < 7) return null;
  return { name, players };
}

function looksLikePlayer(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Boolean(pickString(v, ['name', 'fullName', 'displayName', 'lastName']));
}

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) return parseInt(v, 10);
  }
  return null;
}

module.exports = { fetchBbcLineups, parseLineupsFromHtml, isBbcSportUrl };
