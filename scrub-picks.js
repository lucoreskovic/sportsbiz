// scrub-picks.js — credibility guard, runs AFTER generate.js, BEFORE publish.
//
// This is a deliberately standalone, dependency-free safety net. No matter what
// generate.js produces (even an old/buggy version), this step guarantees the
// published stories.json only contains picks that are REAL, CURRENT, and
// BOOKABLE. A pick survives ONLY if it clears every rule below. Anything else
// is removed before the file is pushed, so a phantom like "Saints +7.5, Sunday
// 1:00 PM ET" in June can never reach the live site.
//
// Rules (a pick must satisfy ALL):
//   1. Not flagged _pendingGrade (those are carry-forward-for-grading only).
//   2. Has a real bookmaker line snapshot (marketSnapshot.markets) — UNLESS it
//      is a player_prop (props can't be priced on the Odds API base plan, but
//      they still must pass every other rule).
//   3. Has a resolvable game time: either a numeric _scheduledTs, or a "when"
//      string we can parse into one. No resolvable time = cannot prove it's a
//      real, scheduled game = removed.
//   4. That game time is within [now - 3h, now + 36h]: not already finished,
//      not days/weeks away (kills offseason/futures lines).

const fs = require('fs');

const FILE = 'stories.json';

function tzOffsetMinutes(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

// Parse "Today/Tonight/Tomorrow H:MM AM/PM ET" → epoch ms (ET, DST-aware), else null.
function etScheduleTs(whenStr, baseDate) {
  const m = String(whenStr || '').match(/^(Today|Tonight|Tomorrow)\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET$/i);
  if (!m) return null;
  const dayOffset = /tomorrow/i.test(m[1]) ? 1 : 0;
  let hour = parseInt(m[2], 10);
  const min = parseInt(m[3], 10);
  if (/PM/i.test(m[4]) && hour < 12) hour += 12;
  if (/AM/i.test(m[4]) && hour === 12) hour = 0;
  const now = baseDate || new Date();
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now).split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d + dayOffset, hour, min, 0);
  return guess - tzOffsetMinutes('America/New_York', new Date(guess)) * 60000;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.log('[scrub] no stories.json found — nothing to scrub');
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[scrub] could not parse stories.json:', e.message);
    process.exit(0); // don't block publish on a parse hiccup
  }

  const picks = Array.isArray(data.picks) ? data.picks : [];
  if (picks.length === 0) {
    console.log('[scrub] 0 picks — nothing to scrub');
    return;
  }

  const now = Date.now();
  const windowStart = now - 3 * 3600 * 1000;
  const windowEnd = now + 36 * 3600 * 1000;

  const kept = [];
  let dropped = 0;
  for (const p of picks) {
    const label = (p.league || '?') + ' ' + (p.pick || '?');

    if (p._pendingGrade) {
      // Not a render-time pick; leave it in the array untouched so grading
      // still happens, but it isn't shown (the frontend already hides these).
      kept.push(p);
      continue;
    }

    const hasLine = !!(p.marketSnapshot && p.marketSnapshot.markets);
    const isProp = String(p.type || '').toLowerCase() === 'player_prop';
    if (!hasLine && !isProp) {
      console.log('[scrub] DROP (no real bookmaker line): ' + label);
      dropped++; continue;
    }

    let ts = (typeof p._scheduledTs === 'number') ? p._scheduledTs : etScheduleTs(p.when);
    if (!ts) {
      console.log('[scrub] DROP (no resolvable game time — phantom/offseason): ' + label + ' [' + (p.when || '?') + ']');
      dropped++; continue;
    }
    if (ts < windowStart) {
      console.log('[scrub] DROP (game already finished — stale): ' + label + ' @ ' + new Date(ts).toISOString());
      dropped++; continue;
    }
    if (ts > windowEnd) {
      console.log('[scrub] DROP (game >36h out — offseason/future line): ' + label + ' @ ' + new Date(ts).toISOString());
      dropped++; continue;
    }
    kept.push(p);
  }

  if (dropped > 0) {
    data.picks = kept;
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    console.log('[scrub] removed ' + dropped + ' invalid pick(s); ' + kept.length + ' remain');
  } else {
    console.log('[scrub] all ' + picks.length + ' picks valid — no changes');
  }
}

main();
