import { writeFileSync, readFileSync, existsSync } from 'fs';

// All feeds fetched via RSS2JSON for maximum reliability from GitHub Actions
const FEEDS = [
  { url: 'https://frontofficesports.com/feed/',                     source: 'Front Office Sports'  },
  { url: 'https://sportico.com/feed/',                              source: 'Sportico'             },
  { url: 'https://nypost.com/sports/feed/',                         source: 'NY Post Sports'       },
  { url: 'https://www.theguardian.com/sport/rss',                   source: 'The Guardian'         },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml', source: 'NY Times Sports'      },
  { url: 'https://feeds.bbci.co.uk/sport/rss.xml',                  source: 'BBC Sport'            },
  { url: 'https://www.si.com/rss/si_top_stories.rss',               source: 'Sports Illustrated'   },
  { url: 'https://bleacherreport.com/articles/feed',                source: 'Bleacher Report'      },
  { url: 'https://www.cbssports.com/rss/headlines/',                source: 'CBS Sports'           },
  { url: 'https://www.sportingnews.com/us/rss.xml',                 source: 'Sporting News'        },
  { url: 'https://www.sportsnet.ca/feed/',                          source: 'Sportsnet'            },
  { url: 'https://www.tsn.ca/rss/tsn-top-stories',                  source: 'TSN'                  },
  { url: 'https://deadspin.com/rss',                                source: 'Deadspin'             },
  { url: 'https://apnews.com/hub/sports/rss',                       source: 'AP Sports'            },
  // Specialty feeds for Market Tracker data — TicketIQ posts regular ticket-price
  // reports; Sports Media Watch posts Nielsen ratings within 24-48h of broadcast.
  { url: 'https://blog.ticketiq.com/blog/rss.xml',                  source: 'TicketIQ'             },
  { url: 'https://www.sportsmediawatch.com/feed/',                  source: 'Sports Media Watch'   },
];

// ═════════════════════════════════════════════════════════════════════════════
// PICK GRADING — server-side W/L/Push determination after games finish.
//
// Problem this solves: picks used to disappear from stories.json after their
// game's scheduled time + 2hr, with grading happening client-side from
// localStorage. If no visitor loaded the page in the window between game-end
// and next workflow prune, the result never got recorded. The Spurs pick
// that "hit a couple days ago" was a casualty of this.
//
// New flow:
//   1. When an off-cycle workflow finds a pick whose game-time has passed,
//      it tries to fetch the final score from ESPN and grade it.
//   2. Successful grades get written to pick_history.json (canonical record).
//   3. Ungradeable picks (score not yet final on ESPN) get re-queued in
//      stories.json so the next run tries again — they don't silently vanish.
//   4. Front-end reads pick_history.json AND localStorage, takes whichever
//      has the result (pick_history.json wins on conflict — it's canonical).
// ═════════════════════════════════════════════════════════════════════════════

// Stable id per pick — same formula used by the front-end so the records line
// up. Strip whitespace and lowercase, hash matchup+pick only. Front-end uses
// the same logic so server-graded results map cleanly to client records.
function pickId(p) {
  return String((p.matchup || '') + '|' + (p.pick || '')).replace(/\s+/g, '').toLowerCase();
}

// ─── ET-AWARE SCHEDULE PARSING ───────────────────────────────────────────────
// GitHub Actions runners are UTC. Parsing "Today 8:00 PM ET" with new Date()
// setHours() produced 8 PM *UTC* = 4 PM ET, so staleness/grading checks fired
// 4-5 hours early. These helpers compute the real UTC instant for an ET wall
// clock, DST-aware, regardless of server timezone.
function tzOffsetMinutes(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000; // ET in summer: -240, winter: -300
}

// "Today 8:00 PM ET" / "Tonight ..." / "Tomorrow ..." → epoch ms, or null.
// dayOffset is computed relative to the current calendar date IN ET.
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

// Fetch the final score for a pick by matching team names against ESPN's
// scoreboard. Returns { home, away, homeScore, awayScore, status } or null.
async function fetchFinalScoreForPick(pick) {
  // Map our pick "league" field to ESPN's url path. NCAA leagues fall back to
  // the matching pro league since user picks have been pro-only so far.
  const leagueMap = {
    'NBA': 'basketball/nba',
    'MLB': 'baseball/mlb',
    'NHL': 'hockey/nhl',
    'NFL': 'football/nfl',
    'WNBA': 'basketball/wnba',
    'EPL': 'soccer/eng.1',
    'LA LIGA': 'soccer/esp.1',
    'BUNDESLIGA': 'soccer/ger.1',
    'SERIE A': 'soccer/ita.1',
    'LIGUE 1': 'soccer/fra.1',
    'UCL': 'soccer/uefa.champions',
    'MLS': 'soccer/usa.1',
  };
  const path = leagueMap[String(pick.league || '').toUpperCase()];
  if (!path) {
    console.log('[grading] no ESPN path for league:', pick.league);
    return null;
  }
  try {
    // Pull both "today" and "yesterday" scoreboards — picks that finished a
    // couple days ago need a wider window. ESPN's default endpoint shows
    // today, but appending ?dates=YYYYMMDD lets us scan back. Try a 4-day
    // window walking back from today.
    for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
      const d = new Date();
      d.setDate(d.getDate() - dayOffset);
      const dateStr = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
      const url = 'https://site.api.espn.com/apis/site/v2/sports/' + path + '/scoreboard?dates=' + dateStr;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      const events = data.events || [];
      for (const ev of events) {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors || [];
        const home = teams.find(t => t.homeAway === 'home') || teams[0];
        const away = teams.find(t => t.homeAway === 'away') || teams[1];
        if (!home || !away) continue;
        // Match by team name tokens — same tactic the front-end uses for fuzzy
        // matching. Pick.matchup is usually "Away @ Home".
        const matchupText = String(pick.matchup || '').toLowerCase();
        const homeName = String(home.team?.displayName || home.team?.name || '').toLowerCase();
        const awayName = String(away.team?.displayName || away.team?.name || '').toLowerCase();
        const homeShort = String(home.team?.shortDisplayName || '').toLowerCase();
        const awayShort = String(away.team?.shortDisplayName || '').toLowerCase();
        // A match needs at least one token from BOTH team names in the
        // pick.matchup. This avoids false positives like "Lakers vs Heat"
        // accidentally matching a "Lakers vs Bulls" event from earlier in week.
        function hasToken(name) {
          if (!name) return false;
          const tokens = name.split(/\s+/).filter(t => t.length > 2);
          return tokens.some(t => matchupText.includes(t));
        }
        const homeMatch = hasToken(homeName) || hasToken(homeShort);
        const awayMatch = hasToken(awayName) || hasToken(awayShort);
        if (!homeMatch || !awayMatch) continue;
        // We've found the game. Is it actually final?
        const statusName = ev.status?.type?.name;
        const isFinal = statusName === 'STATUS_FINAL' || statusName === 'STATUS_FULL_TIME';
        if (!isFinal) {
          console.log('[grading] found game but not final yet (' + statusName + '): ' + awayName + ' @ ' + homeName);
          return null;
        }
        const homeScore = parseInt(home.score, 10);
        const awayScore = parseInt(away.score, 10);
        if (isNaN(homeScore) || isNaN(awayScore)) return null;
        return { home: homeName, away: awayName, homeScore, awayScore, status: 'final' };
      }
    }
  } catch (e) {
    console.warn('[grading] fetch error for ' + pick.matchup + ':', e.message);
  }
  return null;
}

// Determine W/L/Push from a final score and a pick. Picks have type:
// moneyline / spread / total / player_prop. We can grade moneyline and spread
// reliably from final scores; totals if we have a number in the pick text;
// player_prop is impossible without box scores so we skip.
function gradePick(pick, finalScore) {
  const { homeScore, awayScore } = finalScore;
  const type = String(pick.type || '').toLowerCase();
  const pickText = String(pick.pick || '').toLowerCase();
  const matchupText = String(pick.matchup || '').toLowerCase();
  const homeWon = homeScore > awayScore;
  const awayWon = awayScore > homeScore;
  const isTie = homeScore === awayScore;

  // Which side of the matchup is the pick on? "Lakers ML" / "Lakers -4.5" /
  // "Lakers +6" — figure out if Lakers is the home or away team.
  function pickIsForHome() {
    return pickText.split(/\s+/).some(tok => tok.length > 2 && finalScore.home.includes(tok));
  }
  function pickIsForAway() {
    return pickText.split(/\s+/).some(tok => tok.length > 2 && finalScore.away.includes(tok));
  }
  const forHome = pickIsForHome();
  const forAway = pickIsForAway();

  // MONEYLINE
  if (type === 'moneyline' || type === 'ml') {
    // Ties in non-soccer leagues shouldn't happen, but if they do, treat as null.
    if (isTie) return null;
    if (forHome) return homeWon ? 'W' : 'L';
    if (forAway) return awayWon ? 'W' : 'L';
    return null;
  }

  // SPREAD — parse a number like -4.5 or +6 from the pick text.
  if (type === 'spread') {
    const spreadMatch = pickText.match(/([+-]?\d+\.?\d*)/);
    if (!spreadMatch) return null;
    const spread = parseFloat(spreadMatch[1]);
    if (isNaN(spread)) return null;
    let margin;
    if (forHome) {
      // home covers if (homeScore + spread) > awayScore
      margin = (homeScore + spread) - awayScore;
    } else if (forAway) {
      margin = (awayScore + spread) - homeScore;
    } else {
      return null;
    }
    if (margin > 0) return 'W';
    if (margin < 0) return 'L';
    return 'P'; // exact push
  }

  // TOTAL — "Over 220.5" / "Under 8.5"
  if (type === 'total') {
    const numMatch = pickText.match(/(\d+\.?\d*)/);
    if (!numMatch) return null;
    const total = parseFloat(numMatch[1]);
    if (isNaN(total)) return null;
    const actualTotal = homeScore + awayScore;
    const isOver = /over|o\b/.test(pickText);
    const isUnder = /under|u\b/.test(pickText);
    if (!isOver && !isUnder) return null;
    if (actualTotal === total) return 'P';
    if (isOver) return actualTotal > total ? 'W' : 'L';
    return actualTotal < total ? 'W' : 'L';
  }

  // player_prop and anything else: can't grade from a scoreboard score.
  return null;
}

// Grade a batch of finished picks. Returns array of { id, pick, result, score }
// for picks that could be graded; picks that couldn't are silently omitted
// (caller re-queues them).
async function gradeFinishedPicks(picks) {
  const results = [];
  for (const p of picks) {
    const finalScore = await fetchFinalScoreForPick(p);
    if (!finalScore) continue;
    const result = gradePick(p, finalScore);
    if (!result) {
      console.log('[grading] could not grade pick (type or parse issue): ' + p.pick);
      continue;
    }
    console.log('[grading] ' + result + ' — ' + p.pick + ' (' + finalScore.away + ' ' + finalScore.awayScore + ' @ ' + finalScore.home + ' ' + finalScore.homeScore + ')');
    results.push({
      id: pickId(p),
      matchup: p.matchup,
      pick: p.pick,
      league: p.league,
      type: p.type,
      when: p.when,
      confidence: String(p.confidence||'medium').toLowerCase(),
      result,
      finalScore: `${finalScore.awayScore}-${finalScore.homeScore}`,
      gradedAt: new Date().toISOString()
    });
  }
  return results;
}

// Merge new graded picks into pick_history.json. Existing entries with the
// same id are NOT overwritten (first grade wins — protects against later
// runs accidentally re-grading a finalized pick from a different game).
function mergePickHistory(newResults) {
  let history = { picks: [], version: 1 };
  try {
    if (existsSync('pick_history.json')) {
      history = JSON.parse(readFileSync('pick_history.json', 'utf8'));
      if (!Array.isArray(history.picks)) history.picks = [];
    }
  } catch (e) {
    console.warn('[grading] could not read pick_history.json (will recreate):', e.message);
  }
  const existingIds = new Set(history.picks.map(p => p.id));
  for (const r of newResults) {
    if (!existingIds.has(r.id)) history.picks.push(r);
  }
  // Keep history file from growing forever — cap at 500 most-recent entries.
  // At ~1-2 picks/day that's a year+ of history.
  history.picks.sort((a, b) => String(b.gradedAt || '').localeCompare(String(a.gradedAt || '')));
  history.picks = history.picks.slice(0, 500);
  history.lastUpdated = new Date().toISOString();
  writeFileSync('pick_history.json', JSON.stringify(history, null, 2));
}

function stripTags(s) {
  return (s||'').replace(/<[^>]*>/g,'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#\d+;/g,'')
    .trim();
}

function timeAgo(dateStr) {
  if (!dateStr) return 'recently';
  const d = new Date(dateStr);
  if (isNaN(d)) return 'recently';
  const h = Math.round((Date.now() - d.getTime()) / 3600000);
  if (h < 1) return 'Just now';
  if (h < 24) return h + 'h ago';
  return Math.round(h/24) + 'd ago';
}

async function fetchFeed(feed) {
  // Try direct fetch first
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 SportsBizNow/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const xml = await res.text();
      const items = parseRSS(xml, feed.source);
      if (items.length > 0) {
        console.log('DIRECT OK [' + items.length + '] ' + feed.source);
        return items;
      }
    }
  } catch(e) {}

  // Fallback to RSS2JSON
  try {
    const r2j = await fetch(
      'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(feed.url) + '&count=20',
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await r2j.json();
    if (data.status === 'ok' && data.items?.length > 0) {
      const items = data.items
        .filter(i => i.title && i.title.length > 10)
        .map(i => ({
          title: stripTags(i.title),
          link: i.link || '',
          description: stripTags(i.description || '').slice(0, 400),
          pubDate: i.pubDate || '',
          source: feed.source,
        }));
      console.log('RSS2JSON OK [' + items.length + '] ' + feed.source);
      return items;
    }
  } catch(e) {}

  console.warn('FAIL ' + feed.source);
  return [];
}

function parseRSS(xml, sourceName) {
  const items = [];
  const rx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const b = m[1];
    const title = stripTags(
      (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i.exec(b)||
       /<title>([\s\S]*?)<\/title>/i.exec(b)||[])[1] || ''
    );
    const linkTag = /<link>([^<]+)<\/link>/i.exec(b);
    const guid    = /<guid[^>]*>([^<]+)<\/guid>/i.exec(b);
    const link    = (linkTag?.[1] || guid?.[1] || '').trim();
    const desc = stripTags(
      (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i.exec(b)||
       /<description>([\s\S]*?)<\/description>/i.exec(b)||[])[1] || ''
    ).slice(0, 400);
    const date = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(b)||[])[1] || '';
    if (title.length > 10) items.push({ title, link, description: desc, pubDate: date, source: sourceName });
  }
  return items;
}

function dedup(stories) {
  const seen = new Set();
  return stories.filter(s => {
    const k = s.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,50);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function cluster(stories) {
  // ─── RECENCY GUARD ─────────────────────────────────────────────────────────
  // RSS feeds keep big stories near the top for DAYS, so without an age filter
  // the same lead story can win "most important" run after run. Drop anything
  // older than 36h (keep undated items), and label every story with its age so
  // the model can weigh freshness.
  const ageLabel = (pd) => {
    const t = Date.parse(pd || '');
    if (isNaN(t)) return 'age unknown';
    const h = Math.max(0, Math.round((Date.now() - t) / 3600000));
    return h < 1 ? 'just now' : h < 24 ? h + 'h ago' : Math.round(h/24) + 'd ago';
  };
  const freshStories = stories.filter(s => {
    const t = Date.parse(s.pubDate || '');
    return isNaN(t) || (Date.now() - t) < 36 * 3600 * 1000;
  });
  if (freshStories.length !== stories.length) {
    console.log('[cluster] recency filter: ' + stories.length + ' → ' + freshStories.length + ' stories (dropped >36h old)');
  }
  // What did the last refresh lead with? Used to stop the feed from re-leading
  // with the same story when nothing new happened.
  let prevLeads = [];
  try {
    if (existsSync('stories.json')) {
      const prev = JSON.parse(readFileSync('stories.json', 'utf8'));
      prevLeads = (prev.clusters || []).slice(0, 3).map(c => c.leadHeadline).filter(Boolean);
    }
  } catch (e) {}

  // Interleave stories from ALL sources for even distribution
  const sourceGroups = {};
  for (const s of freshStories) {
    if (!sourceGroups[s.source]) sourceGroups[s.source] = [];
    if (sourceGroups[s.source].length < 5) sourceGroups[s.source].push(s);
  }
  const interleaved = [];
  for (let i = 0; i < 5; i++) {
    for (const src of Object.keys(sourceGroups)) {
      if (sourceGroups[src][i]) interleaved.push(sourceGroups[src][i]);
    }
  }
  // Cap at 18 stories. Lower than the previous 22 — reducing input tokens by
  // ~20% with no clustering quality loss; Claude finds the same clusters from
  // a leaner slate, and the variety advantage of 22 over 18 is marginal.
  const selected = interleaved.slice(0, 18);
  const list = selected.map((s, i) =>
    // Truncate descriptions to 140 chars — preserves the headline meaning while
    // halving the token footprint. Full descriptions weren't adding clustering
    // value over titles + first sentence anyway.
    '[' + i + '] SOURCE:' + s.source + ' | ' + ageLabel(s.pubDate) + ' | ' + s.title + ' | ' + (s.description||'').slice(0, 400)
  ).join('\n');
  const srcList = [...new Set(selected.map(s=>s.source))].join(', ');

  // Soccer/World Cup injuries have no live ESPN feed, so they only reach the desk
  // if an injury-framed soccer story happens to be in the 18 clustered stories
  // above — which it usually isn't. To fix that, scan the FULL fetched feed (not
  // just the clustered slice) for injury language tied to soccer/World Cup and
  // hand those items to the injury task as extra candidates. Reuses already-
  // fetched RSS, so no web searches and no extra API cost beyond input tokens.
  const INJ_RX = /injur|ruled out|sidelin|doubtful|out for|fitness test|\bknock\b|hamstring|\bknee\b|ankle|withdrawn|limp|set to miss|miss(es|ed)? the (match|game|tournament|cup)|return(s|ing)? from|setback|strain|sprain|surgery|concussion|out (of|for) the/i;
  const SOC_RX = /world cup|\bfifa\b|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league|\bmls\b|usmnt|uswnt|national team|knockout (stage|round)|group stage|round of 16|quarter-?final|semi-?final|\bnations league\b/i;
  const injCandidates = stories.filter(s => {
    const t = (s.title || '') + ' ' + (s.description || '');
    return INJ_RX.test(t) && SOC_RX.test(t);
  }).slice(0, 12);
  const injBlock = injCandidates.length
    ? '\n\nSOCCER / WORLD CUP INJURY CANDIDATES (flagged across the FULL feed, beyond the clustered set above — scan these for TASK 7 injuries too):\n' +
      injCandidates.map((s, i) => '(S' + i + ') ' + s.source + ' | ' + ageLabel(s.pubDate) + ' | ' + s.title + ' | ' + (s.description || '').slice(0, 300)).join('\n')
    : '';
  const prevLeadsBlock = prevLeads.length
    ? '\nFRESHNESS — DO NOT RERUN YESTERDAY\'S FEED:\nThe previous refresh led with these stories:\n' + prevLeads.map(h => '- "' + h + '"').join('\n') + '\nDo NOT re-lead with any of these unless a genuinely NEW development happened since (a new game was played, new numbers were reported, a new announcement dropped). A follow-up WITH new facts is a new story; the same article re-ranked is not. Each story below shows its age — strongly prefer leads under 24h old. When two candidates are comparably important, the fresher one leads.\n'
    : '';

  const prompt = `You are a sports business columnist, the voice of The Athletic, Sportico, Pablo Torre Finds Out. Confident, specific, editorial. Stories from: ${srcList}.

## TASK 1 — CREATE 5-7 STORY CLUSTERS, RANKED BY IMPORTANCE

CRITICAL ORDERING: Return clusters as an ARRAY ordered from MOST IMPORTANT to LEAST IMPORTANT. The first cluster in the array is the day's top story, what a major sports business publication would lead with at the top of its homepage. The cluster at index [0] gets the biggest display treatment on every section of the site, so it must genuinely be the day's biggest story.

WHAT MAKES A STORY "BIG":
- Affects an entire league, multiple franchises, or hundreds of millions of revenue/contract dollars
- Breaks news vs. analyzes already-known news (breaking news ranks higher)
- Names star-tier figures (top-10 athletes, league commissioners, billion-dollar owners)
- Confirmed/official vs. rumored/speculative (official ranks higher)
- Genuinely new vs. follow-up to last week's story (new ranks higher)

NOT a "big story":
- Marketing announcements (a brand sponsoring a single team)
- Local market news (one city's stadium debate)
- Routine schedule/lineup news
- Recap-of-recap analysis pieces

Spread cluster leads across sources. No more than 2 leads from any single outlet (especially not Front Office Sports or Sportico).
${prevLeadsBlock}

For each cluster return:
- importance: integer 1-10. 10 = "this is THE story of the day, every major sports outlet is leading with it." 7-8 = "front-page worthy, would be on most outlets' homepage." 4-6 = "solid news, of interest to industry readers." 1-3 = "minor but worth tracking." Use the full range honestly, most days have one 8-10 lead, two or three 5-7 mid-tier, and the rest lower.
  IMPORTANCE CALIBRATION (be strict, this sets the lead story):
  • A MAJOR LIVE EVENT HAPPENING NOW is the lead, full stop. While the FIFA World Cup, an Olympics, the NBA/Stanley Cup Finals, or a major championship is in progress, results, records, and standout performances from it are 9-10 and should LEAD the page. The World Cup is the biggest sporting event on earth, when it is on, a World Cup result/record (e.g. "Messi makes World Cup history") leads over almost anything else.
  • On-field history (records, championships, marquee results) = 8-10.
  • A blockbuster STAR signing/trade can be 8 ONLY if genuinely league-altering (a top-10 player changing teams, a record-shattering contract that reshapes the league). A normal big-money contract is a 5-6.
  • DEPRIORITIZE routine business/league-governance news: contract signings, draft-lottery mechanics, sponsorship/investment deals, front-office moves. These are 4-6 and should NOT lead unless genuinely groundbreaking (a franchise relocating, a league folding, a CBA/lockout, a multi-billion-dollar media deal that changes the sport). A $200M contract or a niche-league investment is NOT a lead story when a marquee event is live.
  • Test: "would ESPN/BBC lead their homepage with this RIGHT NOW, with the World Cup on?" If not, it is not a 9-10.
  Do NOT inflate contract/draft/business stories to the top slot over a live marquee sporting moment. When the World Cup is active and there's a World Cup story available, it should almost always be the lead.
- category: "media" | "contracts" | "leagues" | "revenue" | "labor"
- leadHeadline: exact title from a source story (copy verbatim)
- leadSource: exact source name from the [index] prefix + " · Xh ago"
- summary: 2 sentences, under 180 chars, tone guide applies. MUST be about the specific event in leadHeadline, not the broader topic. Put a real fact in it (a number, a name, a result), not a vibe. Plain text only, no tags or markup.
- article: up to 280 words, but ONLY as long as your real facts support. **MUST be ABOUT the specific event named in leadHeadline.** Lead with the hard specifics of that event drawn from the source snippets: who, what, the actual numbers, the score, the date, the dollar figure, the record and the previous holder of it. If a source says Messi has 18 World Cup goals, the article says "18" and says whose record that passed, do not write "a figure no other player has reached." Mine every concrete detail out of the clustered sources and put it on the page.
  THEN you may add analytical context, implications, comparables, who wins/loses, what's next. But the specifics come first and dominate.
  HARD RULES on facts:
  • Use only specifics that appear in the source snippets, OR well-established historical background you are certain is correct (e.g. a prior record-holder's name, a past championship, an old contract figure). NEVER invent a current number, quote, date, or stat. If you don't have the figure, write around it honestly, do not paper over the gap with grand abstraction.
  • NEVER fabricate a reaction, quote, or state of mind. Do not write that someone "responded", "said", "is confident", "was emotional", "called it" anything, or that a response "was understated/measured/defiant", UNLESS the actual words or clear substance of what they said are in the sources. A characterization of a quote is not a quote. If you don't have what they actually said, don't claim they said anything.
  • HEADLINE PAYLOAD: if the leadHeadline promises a specific payload you cannot source, a quote, a "response", a "reaction", a decision, someone "addresses"/"speaks out"/"reveals", and that payload is NOT in the snippets, do NOT manufacture it. Lead instead with the hard news you actually have (what happened, the numbers), and either pick a different source title from this cluster as the leadHeadline whose payload you CAN deliver, or write the factual story straight. A "responds to X" headline with no actual response in the body is the exact failure to avoid.
  • Do NOT pad to hit a word count. A tight 150-word piece packed with real facts is far better than 280 words of filler. If you only have enough verified detail for 130 words, write 130 words and stop. Length is a ceiling, never a target.
  • PLAIN PROSE ONLY. The article and summary are shown to readers as raw text, so any tag or bracketed reference renders literally on the page and breaks it. Do NOT add citation markup, footnotes, or source indices of any kind. Never emit <cite ...> or </cite>, never write [1], [10-4], (source 3), superscripts, or any XML/HTML tags. Attribute in plain words instead ("Sportico reported", "per ESPN"). Just write sentences.
  Write it like a wire-service sports reporter: lead, facts, context, done. Do not write a generic thematic piece that uses the headline as a jumping-off point. tone guide applies.
- storyIndexes: [story indexes that belong in this cluster, from multiple sources when possible]
- posts: [] (real X posts are attached separately after clustering, leave empty here)

## TONE GUIDE (applies to every piece of prose you write)

Write like a human columnist with 20 years on the beat filing for a smart reader, not a press-release intern and not an AI. The test for every sentence: does it carry a fact or a real argument, or is it just sounding important? If it's the latter, cut it.

DO:
- Open with the fact or the angle. No throat-clearing.
- Name names, cite numbers, contracts, dates, prior context. Specific beats grand every time. "His 18th World Cup goal, passing Klose" is worth ten "cements his legacy"s.
- Deliver an analytical line: what this means, who wins, who loses, what comes next.
- Vary sentence rhythm. Short punches next to longer analytical sentences. Some sentences can be four words.
- Make claims you can defend. Don't hedge with "might" and "could" when a stronger verb works.
- Reference prior events where it adds weight ("This follows Goodell's October memo", "The third straight year a QB went No. 1").
- Sound like a person talking: plain verbs, real specifics, the occasional dry aside. Contractions are fine.

PUNCTUATION:
- NO em dashes and NO double hyphens (--). Ever. The em dash (the long dash, "—") is banned outright. Use a comma, a period, parentheses, or a colon instead, or just restructure the sentence. This is a hard rule; the presence of an em dash is an automatic tell that the prose is machine-written.

NEVER use these clichés or patterns:
- "game-changer", "paradigm shift", "uncertain times", "pivotal moment", "new era", "watershed"
- "ushers in", "underscores", "highlights the", "the landscape", "the space"
- "cements/cementing his status", "adds another layer to a legacy", "defies expectation", "remains the story of", "showcased the [X] that has defined", "generational bridge", "for the ages", "etched his name"
- "isn't just [X], it's [Y]" and "not only [X] but [Y]" sentence shapes
- "In a recent development…", "In the world of sports…", "It remains to be seen…"
- Restating the headline verbatim in the first sentence
- Moralizing about what a league "needs" or "should do"
- Empty transition phrases: "That said", "Moving forward", "At the end of the day"
- Vague intensifiers standing in for facts: "ruthlessness", "brilliance", "masterclass", "statement win" with no number attached

CONCRETE OVER ABSTRACT, this is the big one:
Every time you reach for an abstraction, ask if a source gave you the concrete fact behind it. If a source says he scored twice and now has 18, write the 2 and the 18. If you find yourself writing "a figure no other player has reached," stop: name the figure. If you're describing how good a performance was instead of what happened in it, you're writing slop. When the concrete fact genuinely isn't in your sources, say less rather than inflating.

BAD (vague, padded, em-dashed AI slop):
"The two goals extended his World Cup goal tally to a figure no other player has reached across the tournament's 100-year history. At 39, Messi has added yet another layer to a legacy — the veteran who carries clinical finishing into the knockout rounds. Whether Argentina can convert that brilliance into another title remains the story of this tournament."

GOOD (concrete, human, no em dashes):
"The brace was Messi's 17th and 18th career World Cup goals, moving him past Miroslav Klose's record of 16. He's 39, four years removed from the title in Qatar, and still Argentina's primary scorer: both goals came from inside the box against an Austria side that had conceded once in the group stage. Argentina draw the Group F runner-up in the last 32."
(Note: only state the prior record-holder and figures if your sources or solid historical knowledge support them. Never invent the number.)

FAKE-REACTION FAILURE (the headline promises a response; the body must deliver it or not claim it):
BAD: "Messi's response to the record was characteristically understated. He remains the team's primary scoring threat..." (This describes a response without ever saying what it was. Pure filler over a missing fact.)
GOOD, if you have the quote: 'Asked about the record afterward, Messi kept it short: "The win is what matters." He finished with two goals...'
GOOD, if you do NOT have the quote: skip the "response" framing entirely and lead with what actually happened: "Messi's two goals beat Austria 2-0 and moved him to 17 career World Cup goals, past Klose's 16." Never assert a reaction you can't quote.

GOOD OPENING EXAMPLE (note the specificity and angle, and no em dashes):
"The Raiders made Fernando Mendoza the first pick of Thursday's draft, the third straight year a quarterback opened the proceedings and the fourth of the past five. Mendoza's rookie deal will top $50 million fully guaranteed, a number the franchise hasn't committed to a quarterback since Derek Carr's 2022 extension. The pick closes the Minshew-era holding pattern and opens the most consequential offseason build of Antonio Pierce's tenure."

## TASK 2 — DRAFT TRACKER

Scan the stories for specific NFL Draft picks. Today is April 23, 2026 — Round 1 of the 2026 NFL Draft is happening tonight. Extract every identifiable pick into a structured list.

Return:
- draftTracker: {
    active: true if any picks extracted, false otherwise,
    event: "2026 NFL Draft",
    picks: [
      {
        pick: 1,                    // overall pick number (integer)
        round: 1,                   // round number (integer)
        team: "Las Vegas Raiders",  // full team name
        player: "Fernando Mendoza", // full player name
        position: "QB",             // position abbreviation
        school: "Indiana",          // college
        note: "One sentence of analysis. Tone guide applies."
      }
    ]
  }

If no draft picks are identifiable, return draftTracker: { active: false, event: "", picks: [] }. Don't invent picks that aren't mentioned in the stories.

## TASK 3 — MARKET TRACKER: DEAL FLOW

Scan stories for CONFIRMED business deals. Each deal should have a reported dollar value or clear terms. Skip rumors and "reportedly discussing" stories.

Types to extract:
- "sponsorship" — jersey patch, stadium naming, category sponsorship, etc.
- "media_rights" — TV deals, streaming deals, league rights packages
- "apparel" — jersey/shoe/equipment deals
- "acquisition" — team or stake sales
- "extension" — notable player contract extensions with major money (skip minimum deals)
- "stadium" — new venue construction or renovation financing

Return:
- deals: [
    {
      type: "sponsorship" | "media_rights" | "apparel" | "acquisition" | "extension" | "stadium",
      parties: "Chase ⇄ Madison Square Garden" or "Las Vegas Raiders ⇄ Fernando Mendoza",
      value_usd: 350000000 (a NUMBER in raw USD. $350M = 350000000. If unstated, use null),
      term_years: 5 (integer; null if not stated),
      league: "NFL" | "NBA" | "MLB" | "NHL" | "MLS" | "SOCCER" | "MULTI" | "OTHER",
      headline: "Chiefs announce 5-year, $350M Chase jersey patch deal" (max 90 chars),
      storyIndex: the index of the source story (number),
      blurb: "One-sentence context with the key number." (max 140 chars)
    }
  ]

If no qualifying deals are identifiable, return deals: []. Don't fabricate values.

## TASK 4 — MARKET TRACKER: TV RATINGS

Scan stories for concrete TV/streaming viewership numbers (e.g. "averaged 18.7M viewers," "peaked at 24.2M").

Return:
- ratings: [
    {
      event: "Chiefs vs Bills AFC Championship" (event name, max 80 chars),
      network: "CBS" | "FOX" | "ESPN" | "NBC" | "TNT" | "Peacock" | "Amazon Prime" | "Apple TV+" | "Netflix" | string,
      viewers_m: 47.2 (average viewers in millions, as a number),
      peak_viewers_m: 52.8 (peak concurrent in millions; null if unstated),
      league: "NFL" | "NBA" | etc.,
      storyIndex: number,
      context: "Most-watched non-Super Bowl game of the season." (max 120 chars)
    }
  ]

If no concrete viewership numbers appear in the stories, return ratings: []. Don't estimate.

## TASK 5 — MARKET TRACKER: TICKET PRICES

Scan stories (especially TicketIQ posts, but any source) for concrete ticket-price data. We're looking for either:
  • Get-in / cheapest-available prices ("get-in is $48, down 12% week-over-week")
  • Average ticket prices ("average list price is $342")
  • Specific notable price points ("most expensive seat is $4,500")

Return:
- ticket_prices: [
    {
      event: "Lakers vs Warriors at Crypto.com Arena" (event/team/series, max 90 chars),
      league: "NFL" | "NBA" | "MLB" | "NHL" | "MLS" | "SOCCER" | "OTHER",
      get_in_usd: 48 (cheapest available, integer USD; null if not stated),
      avg_usd: 342 (average list price, integer USD; null if not stated),
      direction: "up" | "down" | "flat" | null (recent trend if mentioned),
      pct_change: 12 (percentage change as integer if mentioned; null otherwise),
      timeframe: "week-over-week" | "vs last season" | "since opener" | null,
      storyIndex: number,
      context: "One-line context with venue, date, or driver of the price." (max 140 chars)
    }
  ]

Quality bar: only include entries with at least one of get_in_usd or avg_usd populated. If a story mentions tickets but doesn't quote a number, don't include it. If no qualifying ticket data appears, return ticket_prices: []. Don't fabricate prices.

## TASK 6 — ALSO RETURN

- sidebar: 6 items from varied sources. Each: { headline, source, article }. Articles 100-150 words, tone guide applies.
- poll: { question, options: [exactly 4 option strings] }
- predictions: 4 items { statement, probability (0-100 integer), rationale (tone guide applies) }
- picks: []

## TASK 7 — INJURY EXTRACTION

Scan the stories for injury news. Be generous, readers want a populated injury desk, not an empty page. Include ANY player who is a starter, key rotation piece, or notable contributor with a meaningful status. Don't restrict to stars. ALSO scan the "SOCCER / WORLD CUP INJURY CANDIDATES" section at the very end (if present) and extract every real soccer/World Cup injury from it, not just from the clustered stories. Return an "injuries" array. For each injury, provide:

  injuries: [
    {
      player: "Player Name",
      team: "Team Name",
      league: "The player's ACTUAL sport. Use 'NBA' | 'NFL' | 'MLB' | 'NHL' for those leagues; 'SOCCER' ONLY for association football (World Cup, Premier League, La Liga, MLS, Champions League, etc.); 'TENNIS' | 'GOLF' | 'F1' | 'MMA' | 'CRICKET' for those; 'OTHER' for anything else. CRITICAL: NEVER label a tennis, golf, F1, cricket, or other non-football athlete as SOCCER — a Wimbledon/tennis injury is TENNIS, not SOCCER. Soccer means players who play association football only.",
      position: "Position abbreviation if known (e.g. 'QB','RB','WR' for NFL; 'PG','C' for NBA; 'SP','SS' for MLB; 'G','D' for NHL; 'GK','FW' for soccer). Empty string if not stated.",
      status: "OUT" | "QUESTIONABLE" | "DOUBTFUL" | "DAY_TO_DAY" | "IR" | "RETURNING",
      injury: "Brief description (e.g. 'sprained ankle', 'hamstring', 'knee surgery')",
      timeline: "Return window if reported (e.g. '2-4 weeks', 'out for season', 'game-time decision'); null if not stated",
      source: "Reporter or outlet name from the story",
      impact: "One sentence on team impact — what changes for the team without them (max 160 chars)",
      storyIndex: number
    }
  ]

INCLUDE:
- Players ruled OUT, IR, or DOUBTFUL for an upcoming game
- Players listed QUESTIONABLE, DAY-TO-DAY, or game-time decisions
- Players returning from injury (status: RETURNING)
- Starters AND key rotation/role players (not just superstars)
- Injuries with named diagnosis OR with a clear "ruled out / on IR / placed on injured list" framing

ALSO INCLUDE (treat as DAY_TO_DAY if no harder status given):
- Players "expected to miss" upcoming games per beat reporters
- Players who left a recent game early with an injury
- Players reported as "limited" in practice with an injury concern

EXCLUDE only:
- Pure rumors with no reporter attribution
- "Could miss" speculation without a confirmed status
- Off-the-field issues (suspensions, personal leave), which aren't injuries

SOCCER & WORLD CUP (these get under-captured, so pay attention):
The FIFA World Cup is live right now and the wire is full of soccer availability news. Soccer reports injuries in different words than US sports and never uses "IR" or "injured list", so map soccer language like this:
- "ruled out", "sidelined", "out for the season/tournament", "will miss the match", "set to miss" → OUT
- "doubtful", "a doubt", "rated doubtful", "facing a fitness test", "racing to be fit" → DOUBTFUL
- "game-time decision", "late call", "could feature" → QUESTIONABLE
- "knock", "minor problem", "carrying an issue", "limped off but expected to be okay" → DAY_TO_DAY
- "back in training", "passed a fitness test", "available again", "returns from injury" → RETURNING
Also capture players withdrawn from a national-team squad through injury, and players who came off injured during a World Cup or club match. Tag all of these league:"SOCCER" (club or international alike). Skip pure suspensions and red-card bans, which are not injuries.

Aim for 4-8 injuries on a normal news day. When the World Cup or another major soccer event is live, make sure soccer is represented whenever the wire carries any soccer injury news, don't let it skew all-US. Only return injuries: [] if today's stories truly have ZERO injury mentions across all leagues (rare). Don't fabricate.

## OUTPUT FORMAT

Return ONLY valid JSON. Top-level keys: clusters, draftTracker, deals, ratings, ticket_prices, sidebar, poll, predictions, injuries, picks, updatedAt.

Stories:
${list}${injBlock}`;

  // Retry up to 3 times if we hit a rate limit. Wait progressively longer each
  // attempt so the per-minute window has time to reset.
  let res, data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // Output budget: 5-7 clusters with 220-300 word articles + importance
        // scores + sidebar (6 items × 100-150 words) + deals + ratings + ticket
        // prices + poll + predictions + injuries. Real-world output is ~7-8k.
        // 8500 covers it with a small safety margin. We saw mid-JSON truncation
        // at 6500 once the importance field bumped per-cluster size up.
        max_tokens: 8500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    data = await res.json();
    if (res.ok) break;
    const isRateLimit = res.status === 429 || /rate limit|exceed.*tokens/i.test(data?.error?.message || '');
    if (!isRateLimit || attempt === 3) {
      throw new Error(data.error?.message || ('API error ' + res.status));
    }
    const waitSec = attempt * 35; // 35s, 70s, 105s — enough for the per-minute window to reset
    console.warn('[cluster] rate limited (attempt ' + attempt + '/3), waiting ' + waitSec + 's...');
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) throw new Error('No JSON in response');

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end+1));
  } catch(e) {
    // RECOVERY: Claude's output was truncated mid-JSON (most likely hit max_tokens
    // before finishing). The original error gives us a character position. We work
    // backward from there to find the last complete cluster, then synthesize a
    // valid JSON envelope around what we have.
    //
    // Strategy: scan the partial text for "clusters": [...], find the last fully
    // formed cluster object inside that array, and close everything cleanly.
    console.warn('[cluster] Initial JSON parse failed (' + e.message + '), attempting recovery from truncation...');
    const slice = text.slice(start);
    let recovered = null;

    // 1) Try the legacy recovery first: trim before ",\"picks\"" if it exists.
    if (slice.indexOf(',"picks"') !== -1) {
      const safe = slice.slice(0, slice.lastIndexOf(',"picks"'));
      try { recovered = JSON.parse(safe + ',"picks":[],"updatedAt":"' + new Date().toISOString() + '"}'); }
      catch (e2) { /* fall through to the harder recovery */ }
    }

    // 2) Hard recovery: incrementally remove trailing characters until JSON.parse
    // succeeds with manually-closed brackets. Walk back from the end, look for
    // the last `}` that closes a complete cluster object, then synthesize a
    // valid envelope.
    if (!recovered) {
      // Find "clusters":[ — everything before it is the JSON header we want to keep.
      const clustersStart = slice.indexOf('"clusters"');
      if (clustersStart > 0) {
        // From the start of slice up to and including the last complete "}" before
        // the truncation point, then close the clusters array and the object.
        // We probe backward by trimming one char at a time and trying to parse a
        // synthesized envelope. Cap iterations to keep it fast.
        for (let trim = slice.length - 1; trim > clustersStart + 12; trim--) {
          if (slice[trim] !== '}') continue;
          const candidate = slice.slice(0, trim + 1) + '],"sidebar":[],"deals":[],"ratings":[],"ticket_prices":[],"poll":{"question":"","options":[]},"predictions":[],"injuries":[],"picks":[],"updatedAt":"' + new Date().toISOString() + '"}';
          try {
            recovered = JSON.parse(candidate);
            console.warn('[cluster] Hard recovery succeeded after trimming to char ' + trim + '. Some clusters were lost to truncation.');
            break;
          } catch (e3) { /* keep trimming */ }
        }
      }
    }

    if (!recovered) throw new Error('JSON parse failed and recovery unsuccessful: ' + e.message);
    parsed = recovered;
  }

  // Patterns that indicate Claude returned a placeholder/template label as the
  // headline instead of an actual story title. When detected, we repair by
  // falling back to the source story's real title (which is always available
  // from the original RSS item that the cluster's storyIndexes point at).
  const PLACEHOLDER_HEADLINE_RX = /^(home page featured|featured story|top story|lead story|placeholder|main headline|cluster \d+)$/i;

  parsed.clusters = (parsed.clusters||[]).map(c => {
    const indexes = c.storyIndexes || [];
    // Find the story whose source matches the AI's leadSource
    const aiSource = (c.leadSource||'').split(' · ')[0].trim();
    let lead = null;
    if (aiSource) {
      const matchIdx = indexes.find(i => selected[i]?.source === aiSource);
      lead = selected[matchIdx !== undefined ? matchIdx : indexes[0]];
    } else {
      lead = selected[indexes[0]];
    }

    // Headline repair: if Claude returned a placeholder string instead of a real
    // headline (a known intermittent failure mode where the model describes the
    // field rather than filling it), substitute the actual source story title.
    let headline = c.leadHeadline || lead?.title || '';
    if (PLACEHOLDER_HEADLINE_RX.test(headline.trim()) && lead?.title) {
      console.log('[clusters] repairing placeholder headline "' + headline + '" → "' + lead.title + '"');
      headline = lead.title;
    }

    // Clamp importance to a usable integer. Default of 5 if Claude omitted it.
    let imp = (typeof c.importance === 'number') ? Math.round(c.importance) : 5;
    if (imp < 1) imp = 1;
    if (imp > 10) imp = 10;

    // Strip any Claude-style citation markup the model may leak into prose
    // (<cite index="...">...</cite>). Keep the text, drop the tags. This is the
    // server-side guarantee; the front end strips too as defense-in-depth.
    const stripCite = (s) => String(s == null ? '' : s).replace(/<\/?cite\b[^>]*>/gi, '');

    return {
      category:     c.category     || 'revenue',
      importance:   imp,
      leadHeadline: stripCite(headline),
      leadSource:   c.leadSource   || (lead?.source||'') + ' · ' + timeAgo(lead?.pubDate),
      leadUrl:      (lead?.link && lead.link.startsWith('http')) ? lead.link : '',
      summary:      stripCite(c.summary || ''),
      article:      stripCite(c.article || ''),
      tweets:       [], // populated by attachRealTweets() after clustering
    };
  });

  // Sort by importance descending so the day's top story leads. Tiebreaker:
  // when importance is equal, the more RECENT story wins (a fresh development
  // should outrank an older same-tier story), then stable by original index.
  // This stops a mid-tier story (e.g. a niche league investment) from leading
  // over a bigger, fresher one (e.g. a record being broken) just because they
  // scored the same.
  parsed.clusters.forEach((c, i) => { c._origIdx = i; });
  parsed.clusters.sort((a, b) => {
    const di = (b.importance || 0) - (a.importance || 0);
    if (di !== 0) return di;
    const ta = Date.parse(a.leadPubDate || a.pubDate || '') || 0;
    const tb = Date.parse(b.leadPubDate || b.pubDate || '') || 0;
    if (tb !== ta) return tb - ta;
    return a._origIdx - b._origIdx;
  });
  parsed.clusters.forEach(c => { delete c._origIdx; });

  if (!parsed.poll?.question) {
    parsed.poll = {
      question: 'Which sports business story will have the biggest impact this week?',
      options: (parsed.clusters||[]).slice(0,4).map(cl => cl.leadHeadline.slice(0,55)),
    };
  }
  parsed.predictions = (parsed.predictions||[]).filter(p => p?.statement && typeof p.probability === 'number');

  // Normalize draft tracker — ensure shape even if Claude omitted it.
  const dt = parsed.draftTracker || {};
  const dtPicks = Array.isArray(dt.picks) ? dt.picks : [];
  const cleanPicks = dtPicks
    .filter(p => p && p.team && p.player)
    .map(p => ({
      pick:     Number.isFinite(+p.pick)  ? +p.pick  : null,
      round:    Number.isFinite(+p.round) ? +p.round : 1,
      team:     String(p.team||'').trim(),
      player:   String(p.player||'').trim(),
      position: String(p.position||'').trim().toUpperCase(),
      school:   String(p.school||'').trim(),
      note:     String(p.note||'').trim(),
    }))
    .sort((a, b) => (a.pick||999) - (b.pick||999));
  parsed.draftTracker = {
    active: cleanPicks.length > 0,
    event:  dt.event || (cleanPicks.length > 0 ? '2026 NFL Draft' : ''),
    picks:  cleanPicks,
  };

  // ─── Normalize Market Tracker deals ────────────────────────────────────────
  const validDealTypes = new Set(['sponsorship','media_rights','apparel','acquisition','extension','stadium']);
  const validLeagues   = new Set(['NFL','NBA','MLB','NHL','MLS','SOCCER','MULTI','OTHER']);
  const rawDeals = Array.isArray(parsed.deals) ? parsed.deals : [];
  parsed.deals = rawDeals
    .filter(d => d && d.parties && d.headline)
    .map(d => ({
      type:       validDealTypes.has((d.type||'').toLowerCase()) ? d.type.toLowerCase() : 'sponsorship',
      parties:    String(d.parties||'').trim().slice(0, 120),
      value_usd:  Number.isFinite(+d.value_usd) && +d.value_usd > 0 ? +d.value_usd : null,
      term_years: Number.isFinite(+d.term_years) && +d.term_years > 0 ? +d.term_years : null,
      league:     validLeagues.has((d.league||'').toUpperCase()) ? d.league.toUpperCase() : 'OTHER',
      headline:   String(d.headline||'').trim().slice(0, 120),
      storyIndex: Number.isFinite(+d.storyIndex) ? +d.storyIndex : null,
      blurb:      String(d.blurb||'').trim().slice(0, 200),
      capturedAt: new Date().toISOString(),
    }));

  // ─── Normalize Market Tracker ratings ──────────────────────────────────────
  const rawRatings = Array.isArray(parsed.ratings) ? parsed.ratings : [];
  parsed.ratings = rawRatings
    .filter(r => r && r.event && Number.isFinite(+r.viewers_m) && +r.viewers_m > 0)
    .map(r => ({
      event:          String(r.event||'').trim().slice(0, 100),
      network:        String(r.network||'').trim().slice(0, 40),
      viewers_m:      +r.viewers_m,
      peak_viewers_m: Number.isFinite(+r.peak_viewers_m) && +r.peak_viewers_m > 0 ? +r.peak_viewers_m : null,
      league:         validLeagues.has((r.league||'').toUpperCase()) ? r.league.toUpperCase() : 'OTHER',
      storyIndex:     Number.isFinite(+r.storyIndex) ? +r.storyIndex : null,
      context:        String(r.context||'').trim().slice(0, 180),
      capturedAt:     new Date().toISOString(),
    }));

  // ─── Normalize Market Tracker ticket prices ───────────────────────────────
  const validDirections = new Set(['up','down','flat']);
  const rawTickets = Array.isArray(parsed.ticket_prices) ? parsed.ticket_prices : [];
  parsed.ticket_prices = rawTickets
    .filter(t => {
      if (!t || !t.event) return false;
      const hasGetIn = Number.isFinite(+t.get_in_usd) && +t.get_in_usd > 0;
      const hasAvg   = Number.isFinite(+t.avg_usd)    && +t.avg_usd > 0;
      return hasGetIn || hasAvg;
    })
    .map(t => ({
      event:      String(t.event||'').trim().slice(0, 110),
      league:     validLeagues.has((t.league||'').toUpperCase()) ? t.league.toUpperCase() : 'OTHER',
      get_in_usd: Number.isFinite(+t.get_in_usd) && +t.get_in_usd > 0 ? Math.round(+t.get_in_usd) : null,
      avg_usd:    Number.isFinite(+t.avg_usd)    && +t.avg_usd > 0    ? Math.round(+t.avg_usd)    : null,
      direction:  validDirections.has((t.direction||'').toLowerCase()) ? t.direction.toLowerCase() : null,
      pct_change: Number.isFinite(+t.pct_change) ? Math.round(+t.pct_change) : null,
      timeframe:  String(t.timeframe||'').trim().slice(0, 40) || null,
      storyIndex: Number.isFinite(+t.storyIndex) ? +t.storyIndex : null,
      context:    String(t.context||'').trim().slice(0, 180),
      capturedAt: new Date().toISOString(),
    }));

  parsed.picks = [];
  return parsed;
}

// ─── REAL X POST DISCOVERY ────────────────────────────────────────────────────
// For each cluster, ask Claude (with web_search) to find real tweet URLs that
// are reacting to the story. Then validate each URL via X's public oEmbed
// endpoint — which confirms the tweet exists and returns embed-ready HTML
// containing the REAL author, handle, text, timestamp, and link back to X.
//
// If oEmbed returns 404 or errors, we drop that URL silently. A cluster ends
// up with either 0-3 real, validated tweets or nothing. Never fake content.
function extractTweetId(u) {
  const m = String(u).match(/status\/(\d+)/);
  return m ? m[1] : null;
}
function syndicationToken(id) {
  // X derives the token as ((id / 1e15) * pi) in base-36, with the decimal
  // point removed and any trailing zeros stripped.
  const n = (Number(id) / 1e15) * Math.PI;
  return n.toString(36).replace(/(0+|\.)$/g, '').replace(/\./g, '');
}
function buildTweetHtml(text, name, handle, dateStr, tweetUrl) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const href = tweetUrl ? esc(tweetUrl) : '#';
  return '<blockquote class="twitter-tweet" data-dnt="true" data-theme="dark">' +
    '<p>' + esc(text) + '</p>&mdash; ' + esc(name) + ' (@' + esc(handle) + ') ' +
    '<a href="' + href + '">' + esc(dateStr || 'View on X') + '</a></blockquote>';
}

// Resolve a tweet URL to renderable data. Tries the syndication endpoint FIRST
// (cdn.syndication.twimg.com — what X's own embed widget uses; clean JSON, no
// auth, far more reliable than publish.twitter.com/oembed, which X has been
// progressively breaking). Falls back to oEmbed. Returns
// { url, html, author_name, author_url, dateMs } or null.
async function fetchTweetData(tweetUrl) {
  const id = extractTweetId(tweetUrl);
  if (!id) return null;
  const normalized = tweetUrl.replace(/^https?:\/\/x\.com\//, 'https://twitter.com/');

  try {
    const synUrl = 'https://cdn.syndication.twimg.com/tweet-result?id=' + id +
      '&token=' + syndicationToken(id) + '&lang=en';
    const r = await fetch(synUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 SportsBizNow/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const d = await r.json();
      if (d && d.text && d.user) {
        const dateMs = d.created_at ? Date.parse(d.created_at) : null;
        const dateStr = !dateMs ? '' : new Date(dateMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        return {
          url: normalized,
          html: buildTweetHtml(d.text, d.user.name, d.user.screen_name, dateStr, normalized),
          author_name: d.user.name,
          author_url: 'https://twitter.com/' + d.user.screen_name,
          dateMs: dateMs,
        };
      }
    }
  } catch (e) { /* fall through */ }

  try {
    const oembedUrl = 'https://publish.twitter.com/oembed?url=' +
      encodeURIComponent(normalized) +
      '&omit_script=true&dnt=true&theme=dark&align=left&hide_thread=true';
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.html || !data.author_name) return null;
    const dm = String(data.html).match(/>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>/);
    return {
      url: normalized,
      html: data.html,
      author_name: data.author_name,
      author_url: data.author_url || '',
      dateMs: dm ? Date.parse(dm[1]) : null,
    };
  } catch (e) {
    return null;
  }
}
const fetchTweetOEmbed = fetchTweetData;

async function attachRealTweets(clusters) {
  if (!Array.isArray(clusters) || clusters.length === 0) return;

  // Single Claude call with web_search enabled: given all cluster headlines,
  // return a mapping of cluster index -> tweet URLs Claude confidently found
  // discussing that specific story. This is cheaper than N calls and lets
  // Claude prioritize searches across the whole slate.
  const headlineList = clusters
    .map((c, i) => '[' + i + '] ' + c.leadHeadline + (c.summary ? ' — ' + String(c.summary).slice(0, 180) : ''))
    .join('\n');

  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const prompt = `You are attaching real public tweets (X posts) to sports-business news stories. Today is ${todayLabel}.

Your goal: find at least one genuinely relevant, current tweet for as many of these stories as you can. Most of these stories ARE being discussed on X right now (league accounts, team accounts, beat reporters, Sportico/FOS/ESPN writers, verified insiders), so an empty result for a major story usually means you didn't search hard enough — not that nothing exists.

PRIORITY: Story [0] is the day's lead story and gets the biggest display. Spend your first 1-2 searches making sure [0] has a relevant tweet if one exists at all — a thread on the lead story matters most. Then work through the rest.

SEARCH STRATEGY (important — plain site:twitter.com queries often return nothing):
- Search the KEY ENTITY + the EVENT, e.g. "Real Madrid Adidas deal" or "NBA Finals Game 3 ratings", and look for x.com / twitter.com status links in the results.
- Also try the relevant org or reporter handle directly, e.g. "@FrontOfficeSport Real Madrid Adidas", "@SporticoUSA", "@ESPNNBA Game 3 ratings".
- Run a search for EACH story that plausibly has X discussion. Don't spend your whole budget on one story.

HARD RULES:
- Return ONLY tweet URLs you actually saw in search results. Never fabricate a URL or guess a status ID.
- A valid tweet URL: https://twitter.com/username/status/1234567890 or https://x.com/username/status/1234567890
- RELEVANCE GATE: the tweet must be about the SPECIFIC EVENT in the headline, not merely the same team, league, or person. A tweet about an earlier game or a different storyline FAILS. (A tweet celebrating a Finals berth does NOT belong on a Game 3 TV-ratings story.)
- RECENCY GATE: skip tweets more than ~3 days old, or pre-event hype tweets for an event that has already happened.
- Between a loosely-related tweet and nothing, choose nothing. But between a clearly-relevant tweet and nothing, do the work to find the tweet.
- Prefer verified org/team accounts and beat reporters over random fans.
- 0-2 tweets per headline.

HEADLINES:
${headlineList}

Return ONLY valid JSON with no prose:
{"byIndex":{"0":["https://twitter.com/...","https://twitter.com/..."],"1":[],"2":["https://x.com/..."]}}`;

  let byIndex = {};
  try {
    console.log('[tweets] searching X for real reactions to ' + clusters.length + ' clusters...');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        // X/Twitter is the hardest platform to surface via general web search.
        // Cost-trim: dropped 8 → 4 searches. The batch still tries the lead and
        // a couple of top clusters; the focused retry below covers the lead if it
        // came back empty. Per our "show none rather than force one" stance, fewer
        // searches just means fewer threads on the smaller stories, which is fine.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('tweet-search API ' + res.status);
    const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1) throw new Error('no JSON in tweet-search response');
    const parsed = JSON.parse(text.slice(start, end+1));
    byIndex = parsed.byIndex || {};
  } catch (e) {
    console.warn('[tweets] search stage failed:', e.message);
    return; // leave clusters.tweets as empty arrays
  }

  // Now validate every URL via oEmbed in parallel (across all clusters). oEmbed
  // is the ground truth: if it resolves, the tweet is real and public.
  // If it doesn't, we drop the URL — no fake content survives.
  const tweetUrlRegex = /^https:\/\/(twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/;
  const jobs = [];
  for (const idx in byIndex) {
    const urls = Array.isArray(byIndex[idx]) ? byIndex[idx] : [];
    const validUrls = urls.filter(u => typeof u === 'string' && tweetUrlRegex.test(u)).slice(0, 3);
    for (const url of validUrls) {
      jobs.push(fetchTweetOEmbed(url).then(result => ({ clusterIdx: Number(idx), result })));
    }
  }
  const results = await Promise.all(jobs);

  // ─── DETERMINISTIC FRESHNESS FILTER (free, no API calls) ────────────────────
  // The oEmbed blockquote ends with the tweet's post date as anchor text, e.g.
  // ">June 1, 2026</a>". The prompt asks Claude to skip stale tweets, but
  // search snippets sometimes hide dates, so we enforce it here too: any tweet
  // older than TWEET_MAX_AGE_DAYS gets dropped. This is what let a pre-Finals
  // "tipping off June 3rd" tweet ride along on a Game 1 ratings story.
  const TWEET_MAX_AGE_DAYS = 4;
  const maxAgeMs = TWEET_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  function tweetIsFresh(t) {
    if (!t || typeof t.dateMs !== 'number' || isNaN(t.dateMs)) return true; // unknown date — keep
    return (Date.now() - t.dateMs) <= maxAgeMs;
  }

  // Group resolved tweets back onto clusters, deduped by tweet id, ONE per
  // cluster. The model sometimes returns the same tweet (or two near-identical
  // ones from the same account about the same moment) — show only the single
  // best one, never a duplicate stack.
  function tweetId(t) {
    var m = String(t && t.url || '').match(/status\/(\d+)/);
    return m ? m[1] : (t && t.url) || '';
  }
  for (const r of results) {
    if (!r.result) continue;
    if (!tweetIsFresh(r.result)) {
      console.log('[tweets] dropped stale tweet (>' + TWEET_MAX_AGE_DAYS + 'd old): ' + r.result.url);
      continue;
    }
    const cl = clusters[r.clusterIdx];
    if (!cl) continue;
    if (!Array.isArray(cl.tweets)) cl.tweets = [];
    if (cl.tweets.length >= 1) continue; // one tweet per cluster — no stacks
    if (cl.tweets.some(t => tweetId(t) === tweetId(r.result))) continue; // no dupes
    cl.tweets.push(r.result);
  }

  const totalAttached = clusters.reduce((n, c) => n + (c.tweets?.length || 0), 0);
  const clustersWithTweets = clusters.filter(c => (c.tweets?.length || 0) > 0).length;
  console.log('[tweets] attached ' + totalAttached + ' real tweets across ' + clustersWithTweets + ' clusters');

  // ─── LEAD-STORY GUARANTEE ───────────────────────────────────────────────────
  // The site should reliably carry at least one X thread a day, on the lead
  // story above all. If the main pass left cluster [0] without a tweet, make
  // ONE focused retry: a dedicated search just for the lead story, with a
  // higher search budget and explicit instruction to return the single best
  // current tweet. Still real-and-relevant only — if this also finds nothing,
  // we accept zero rather than force junk.
  // Guarantee a thread on the lead story (and try the next two as bonus). If
  // the main pass left cluster[0] empty, retry it hard; if that succeeds we're
  // done, otherwise try [1] and [2] so the page reliably carries SOME thread.
  // Cost-trim: retry only the lead story [0] (was top 3). The lead is the most
  // visible and most likely to have an official-account post; chasing threads for
  // the smaller stories was a big share of the per-run search spend.
  const retryTargets = clusters.slice(0, 1).filter(c => c && (!c.tweets || c.tweets.length === 0));
  let retriesUsed = 0;
  for (const target of retryTargets) {
    if (target !== clusters[0] && clusters[0].tweets && clusters[0].tweets.length > 0 && retriesUsed >= 2) break;
    retriesUsed++;
    try {
      console.log('[tweets] focused retry for: ' + target.leadHeadline);
      const focusPrompt = `Find ONE real, current public tweet (X post) about this specific sports story, posted in the last ~4 days:\n\n"${target.leadHeadline}"${target.summary ? '\n' + String(target.summary).slice(0,200) : ''}\n\nUse web_search aggressively (you have several searches). Strategy in priority order:\n1. The OFFICIAL account most likely to have posted it + a keyword — e.g. for World Cup: @FIFAWorldCup, @fifaworldcup_en, @ESPNFC, the national team accounts (@Argentina, @afaseleccion); for NBA: @NBA, the team account; for a league/business story: @FrontOfficeSport, @SporticoUSA, @TheAthletic.\n2. The beat reporter who covers it + the event.\n3. The key people/teams named + the event, looking for x.com or twitter.com /status/ links in the results.\nOfficial league/team/event accounts almost always post about major moments — find their tweet about THIS story.\n\nReturn ONLY the single most relevant, most recent tweet URL you actually saw, as JSON: {"url":"https://twitter.com/.../status/..."} — or {"url":null} if you genuinely cannot find a real, on-topic, recent one. Never fabricate a URL.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: [{ role: 'user', content: focusPrompt }],
        }),
      });
      const data = await r.json();
      if (r.ok) {
        const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        const s = text.indexOf('{'), e = text.lastIndexOf('}');
        if (s !== -1) {
          const url = (JSON.parse(text.slice(s, e+1)) || {}).url;
          const tweetUrlRegex = /^https:\/\/(twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/;
          if (url && tweetUrlRegex.test(url)) {
            const resolved = await fetchTweetData(url);
            if (resolved && tweetIsFresh(resolved)) {
              if (!Array.isArray(target.tweets)) target.tweets = [];
              if (target.tweets.length === 0) {
                target.tweets.push(resolved);
                console.log('[tweets] retry SUCCESS for "' + target.leadHeadline.slice(0,40) + '": ' + resolved.url);
              }
              if (target === clusters[0]) break; // lead has a tweet — that's the priority, stop
            } else {
              console.log('[tweets] retry: found URL but failed validation/freshness');
            }
          } else {
            console.log('[tweets] retry: no valid tweet found for this story');
          }
        }
      }
    } catch (e) {
      console.warn('[tweets] focused retry failed (non-fatal):', e.message);
    }
  }
}

// ─── ODDS HELPERS ────────────────────────────────────────────────────────────
// Convert American odds (e.g., -110, +145) to implied win probability.
// Used to compare market price against modeled probability.
function impliedProbability(americanOdds) {
  const o = Number(americanOdds);
  if (!Number.isFinite(o)) return null;
  if (o > 0) return 100 / (o + 100);
  return -o / (-o + 100);
}

// Given one event from The Odds API (with multiple bookmakers), find the BEST
// available price per market per side. This is real line-shopping — the same
// edge a sharp bettor gets by maintaining accounts at multiple books.
//
// Input: { home_team, away_team, commence_time, bookmakers: [...] }
// Output: { league, awayTeam, homeTeam, commence_time, markets: { ... } }
function consolidateBestLines(event, league) {
  const result = {
    league,
    awayTeam: event.away_team,
    homeTeam: event.home_team,
    commenceTime: event.commence_time,
    markets: {
      h2h: { away: null, home: null, draw: null },     // moneyline (draw for soccer)
      spreads: { away: null, home: null },              // point spread + price
      totals: { over: null, under: null },              // total + price
    },
  };
  const bookmakers = Array.isArray(event.bookmakers) ? event.bookmakers : [];
  // Track which bookmaker offered the best line so we can show it in the edge field.
  for (const bm of bookmakers) {
    const bmName = bm.title || bm.key || 'bookmaker';
    for (const market of (bm.markets || [])) {
      const outcomes = market.outcomes || [];
      if (market.key === 'h2h') {
        for (const o of outcomes) {
          const slot = o.name === event.home_team ? 'home'
                     : o.name === event.away_team ? 'away'
                     : o.name === 'Draw'          ? 'draw'
                     : null;
          if (!slot) continue;
          const cur = result.markets.h2h[slot];
          // Best moneyline = highest American price (best payout)
          if (!cur || Number(o.price) > Number(cur.price)) {
            result.markets.h2h[slot] = { price: o.price, book: bmName };
          }
        }
      } else if (market.key === 'spreads') {
        for (const o of outcomes) {
          const slot = o.name === event.home_team ? 'home' : o.name === event.away_team ? 'away' : null;
          if (!slot) continue;
          // For spreads, "best line" depends on which side: the team you're laying with
          // wants the smallest spread number (line moves your way), and either way you want
          // the best price. We track the most-favorable point + best price separately.
          const cur = result.markets.spreads[slot];
          if (!cur) {
            result.markets.spreads[slot] = { point: o.point, price: o.price, book: bmName };
          } else {
            // Prefer better point first (lower absolute laid value, higher absolute taken value),
            // then better price. Done as two passes: pick whichever has the better point;
            // if same point, pick whichever has the better price.
            if (Number(o.point) > Number(cur.point) ||
                (Number(o.point) === Number(cur.point) && Number(o.price) > Number(cur.price))) {
              result.markets.spreads[slot] = { point: o.point, price: o.price, book: bmName };
            }
          }
        }
      } else if (market.key === 'totals') {
        for (const o of outcomes) {
          const slot = (o.name || '').toLowerCase() === 'over'  ? 'over'
                     : (o.name || '').toLowerCase() === 'under' ? 'under'
                     : null;
          if (!slot) continue;
          const cur = result.markets.totals[slot];
          if (!cur) {
            result.markets.totals[slot] = { point: o.point, price: o.price, book: bmName };
          } else {
            // Over: lower total is better. Under: higher total is better. Then best price.
            const pointBetter = slot === 'over'
              ? Number(o.point) < Number(cur.point)
              : Number(o.point) > Number(cur.point);
            if (pointBetter ||
                (Number(o.point) === Number(cur.point) && Number(o.price) > Number(cur.price))) {
              result.markets.totals[slot] = { point: o.point, price: o.price, book: bmName };
            }
          }
        }
      }
    }
  }
  return result;
}

// Format consolidated odds into a compact text block Claude can consume.
function formatOddsForPrompt(odds) {
  if (!odds) return '';
  const m = odds.markets;
  const lines = [];
  lines.push('  BEST LINES (line-shopped across US books):');
  if (m.h2h.away || m.h2h.home) {
    const a = m.h2h.away ? (m.h2h.away.price + ' @' + m.h2h.away.book) : '?';
    const h = m.h2h.home ? (m.h2h.home.price + ' @' + m.h2h.home.book) : '?';
    const d = m.h2h.draw ? (' / Draw ' + m.h2h.draw.price + ' @' + m.h2h.draw.book) : '';
    lines.push('    Moneyline: ' + odds.awayTeam + ' ' + a + ' / ' + odds.homeTeam + ' ' + h + d);
  }
  if (m.spreads.away || m.spreads.home) {
    const a = m.spreads.away ? (signed(m.spreads.away.point) + ' (' + m.spreads.away.price + ' @' + m.spreads.away.book + ')') : '?';
    const h = m.spreads.home ? (signed(m.spreads.home.point) + ' (' + m.spreads.home.price + ' @' + m.spreads.home.book + ')') : '?';
    lines.push('    Spread: ' + odds.awayTeam + ' ' + a + ' / ' + odds.homeTeam + ' ' + h);
  }
  if (m.totals.over || m.totals.under) {
    const o = m.totals.over  ? ('Over '  + m.totals.over.point  + ' (' + m.totals.over.price  + ' @' + m.totals.over.book  + ')') : '?';
    const u = m.totals.under ? ('Under ' + m.totals.under.point + ' (' + m.totals.under.price + ' @' + m.totals.under.book + ')') : '?';
    lines.push('    Total: ' + o + ' / ' + u);
  }
  return lines.join('\n');
}
// Shared map: our league labels → The Odds API sport keys.
// Includes standing leagues AND major one-off tournaments (World Cup, etc.).
// When a tournament is in season its key returns fixtures; off-season it
// returns nothing and is harmless, so they can stay listed year-round.
const ODDS_SPORT_KEYS = {
  'NBA':'basketball_nba', 'NFL':'americanfootball_nfl', 'MLB':'baseball_mlb',
  'NHL':'icehockey_nhl', 'EPL':'soccer_epl', 'LA LIGA':'soccer_spain_la_liga',
  'BUNDESLIGA':'soccer_germany_bundesliga', 'SERIE A':'soccer_italy_serie_a',
  'LIGUE 1':'soccer_france_ligue_one', 'UCL':'soccer_uefa_champs_league', 'MLS':'soccer_usa_mls',
  // ─── Major tournaments ───
  'WORLD CUP':'soccer_fifa_world_cup',
  'EUROS':'soccer_uefa_european_championship',
  'COPA AMERICA':'soccer_conmebol_copa_america',
  'OLYMPIC BASKETBALL':'basketball_fiba_olympics', // best-effort; harmless if unrecognized off-cycle
};

// Fetch + consolidate live odds for one league into an oddsByGame map.
// Shared by the main pipeline (stage 0) and the off-cycle top-up.
async function fetchLeagueOdds(league, oddsByGame) {
  const sportKey = ODDS_SPORT_KEYS[league];
  if (!sportKey || !process.env.ODDS_API_KEY) return;
  const url = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
    '/odds?apiKey=' + process.env.ODDS_API_KEY +
    '&regions=us&markets=h2h,spreads,totals&oddsFormat=american';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.warn('[odds] fetch failed for ' + league + ': HTTP ' + r.status); return; }
    const remaining = r.headers.get('x-requests-remaining');
    const data = await r.json();
    if (!Array.isArray(data)) return;
    for (const ev of data) {
      const key = (ev.away_team + ' @ ' + ev.home_team).toLowerCase().replace(/\s+/g,' ').trim();
      oddsByGame[key] = consolidateBestLines(ev, league);
    }
    console.log('[odds] ' + league + ': ' + data.length + ' games priced (credits remaining: ' + remaining + ')');
  } catch (e) {
    console.warn('[odds] fetch error for ' + league + ':', e.message);
  }
}

// Off-cycle top-up: for each core US league that has a game starting within the
// next ~10 hours, ensure the slate carries at least 2 picks by adding
// deterministic market-fill picks from freshly fetched lines.
async function topUpMarketFills(currentPicks) {
  if (!process.env.ODDS_API_KEY) return [];
  // Which leagues are under-covered right now? Count ONLY renderable picks —
  // _pendingGrade picks are finished games held for grading and are hidden from
  // the page, so they must NOT count toward a sport's coverage. (This was the
  // bug: 2 stale pending MLB picks made MLB look "covered" so today's real
  // games never got filled, leaving the board empty.)
  const countByLeague = {};
  (currentPicks || []).forEach(p => {
    if (p._pendingGrade) return;
    const lg = String(p.league||'').toUpperCase();
    countByLeague[lg] = (countByLeague[lg]||0) + 1;
  });
  // Only bother pricing leagues that (a) are below 2 picks and (b) plausibly
  // have games today. We check ESPN cheaply for game presence first, then only
  // hit the paid odds API for leagues that need topping up.
  const CORE = [
    {label:'MLB', urlPath:'baseball/mlb'},
    {label:'NBA', urlPath:'basketball/nba'},
    {label:'NHL', urlPath:'hockey/nhl'},
    {label:'NFL', urlPath:'football/nfl'},
    {label:'WORLD CUP', urlPath:'soccer/fifa.world'},
  ];
  const oddsByGame = {};
  for (const lg of CORE) {
    if ((countByLeague[lg.label]||0) >= 2) continue; // already covered
    // Confirm the league plausibly has a game today before spending a credit.
    // Accept ANY game on today's scoreboard (scheduled, live, or even final —
    // the odds fetch + fill-window filter will sort out what's actually
    // bettable). If the ESPN check errors, price anyway rather than skip:
    // better to spend one credit than leave the sport empty.
    let hasGame = true;
    try {
      const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + lg.urlPath + '/scoreboard', { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const d = await res.json();
        hasGame = Array.isArray(d.events) && d.events.length > 0;
      }
    } catch (e) { hasGame = true; }
    if (!hasGame) continue;
    await fetchLeagueOdds(lg.label, oddsByGame);
  }
  if (Object.keys(oddsByGame).length === 0) return [];
  // buildMarketFillPicks already dedupes against existing picks and respects
  // the 2-4 per-sport bounds and the start-time window.
  return buildMarketFillPicks(oddsByGame, currentPicks || [], 2, 4);
}

function signed(n) { const v = Number(n); return (v > 0 ? '+' : '') + v; }

// ─── GUARANTEED PER-SPORT VOLUME: MARKET FILL PICKS ──────────────────────────
// The LLM slate cannot be trusted to deliver volume — research budgets run out,
// briefings come back thin, and the model under-returns. This builder is pure
// code: given the real bookmaker lines already fetched, it guarantees every
// sport with priced games carries at least `minPerSport` picks. Fill picks are
// always labeled "low" confidence, always carry a real marketSnapshot, and say
// plainly in the writeup that they're market-consensus plays, so they can never
// pollute the tracked high-confidence record. Zero API calls.
function etTimeLabel(isoTime) {
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '';
  const fmtDate = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(x);
  const gameDay = fmtDate(d), today = fmtDate(new Date());
  const tomorrow = fmtDate(new Date(Date.now() + 86400000));
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  const dayWord = gameDay === today ? 'Today' : gameDay === tomorrow ? 'Tomorrow'
    : new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
  return dayWord + ' ' + time + ' ET';
}

function buildMarketFillPicks(oddsByGame, existingPicks, minPerSport, maxPerSport) {
  const fills = [];
  const games = Object.values(oddsByGame || {}).filter(o => {
    const ts = Date.parse(o.commenceTime || '');
    // Include games starting within the next 24h AND games that started up to
    // 3h ago (still live / bettable pre-close, and so the board isn't empty in
    // the afternoon when day games have already begun). Excludes only games
    // that are clearly over.
    return !isNaN(ts) && ts > Date.now() - 3 * 3600 * 1000 && ts < Date.now() + 24 * 3600 * 1000;
  });
  if (games.length === 0) return fills;

  // Count existing picks per league and note which games are already used.
  const perLeague = {};
  const usedGames = new Set();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  existingPicks.forEach(p => {
    const lg = String(p.league || '').toUpperCase();
    // Pending-grade picks are hidden finished games — don't count them toward
    // coverage (or a sport with only stale picks never gets filled). But DO
    // mark their game used so we never double up on the same matchup.
    if (!p._pendingGrade) perLeague[lg] = (perLeague[lg] || 0) + 1;
    if (p.marketSnapshot && p.marketSnapshot.awayTeam) {
      usedGames.add(norm(p.marketSnapshot.awayTeam) + '|' + norm(p.marketSnapshot.homeTeam));
    }
  });

  const byLeague = {};
  games.forEach(g => {
    const lg = String(g.league || '').toUpperCase();
    (byLeague[lg] = byLeague[lg] || []).push(g);
  });

  for (const lg of Object.keys(byLeague)) {
    let count = perLeague[lg] || 0;
    if (count >= minPerSport) continue;
    const candidates = byLeague[lg]
      .filter(g => !usedGames.has(norm(g.awayTeam) + '|' + norm(g.homeTeam)))
      .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));

    for (const g of candidates) {
      if (count >= minPerSport || count >= maxPerSport) break;
      const m = g.markets || {};
      const matchup = g.awayTeam + ' @ ' + g.homeTeam;
      const when = etTimeLabel(g.commenceTime);
      let pick = null;

      // Heuristic 1: moneyline favorite at a sane price (-105 to -220).
      const h = m.h2h || {};
      const sides = [
        h.home ? { slot: 'home', team: g.homeTeam, price: h.home.price, book: h.home.book } : null,
        h.away ? { slot: 'away', team: g.awayTeam, price: h.away.price, book: h.away.book } : null,
      ].filter(Boolean);
      const fav = sides.filter(s => s.price < 0).sort((a, b) => a.price - b.price)[0];
      const dog = sides.find(s => fav && s.slot !== fav.slot);
      if (fav && fav.price <= -105 && fav.price >= -220) {
        pick = {
          type: 'moneyline',
          pick: fav.team + ' ML',
          odds: String(fav.price),
          edge: 'Market fill from live lines: ' + fav.team + ' is the books\' favorite at ' + fav.price + ' (best price @ ' + fav.book + ')' +
            (dog ? ' against ' + dog.team + ' at ' + signed(dog.price) : '') +
            (fav.slot === 'home' ? ', with home ice/court/field behind them' : ', favored even on the road') +
            '. No researched edge here — this is a low-confidence market-consensus play added to round out the slate. Low confidence is honest confidence.',
        };
      }
      // Heuristic 2: favorite spread.
      if (!pick) {
        const s = m.spreads || {};
        const spFav = [s.home && { ...s.home, team: g.homeTeam }, s.away && { ...s.away, team: g.awayTeam }]
          .filter(Boolean).find(x => x.point < 0);
        if (spFav) {
          pick = {
            type: 'spread',
            pick: spFav.team + ' ' + signed(spFav.point),
            odds: String(spFav.price),
            edge: 'Market fill from live lines: the books lay ' + signed(spFav.point) + ' with ' + spFav.team + ' at ' + spFav.price + ' (best @ ' + spFav.book + '). No researched edge — a low-confidence market-consensus play so this sport isn\'t empty today.',
          };
        }
      }
      // Heuristic 3: total, on whichever side has the better juice.
      if (!pick) {
        const t = m.totals || {};
        const tSide = [t.over && { ...t.over, label: 'Over' }, t.under && { ...t.under, label: 'Under' }]
          .filter(Boolean).sort((a, b) => b.price - a.price)[0];
        if (tSide) {
          pick = {
            type: 'total',
            pick: tSide.label + ' ' + tSide.point,
            odds: String(tSide.price),
            edge: 'Market fill from live lines: total posted at ' + tSide.point + ', taking the ' + tSide.label.toLowerCase() + ' at the better price (' + signed(tSide.price) + ' @ ' + tSide.book + '). No researched edge — low-confidence market-consensus play.',
          };
        }
      }
      if (!pick) continue;

      fills.push({
        ...pick,
        matchup,
        league: g.league,
        when,
        confidence: 'low',
        _autofill: true,
        _scheduledTs: Date.parse(g.commenceTime),
        marketSnapshot: {
          capturedAt: new Date().toISOString(),
          markets: g.markets,
          awayTeam: g.awayTeam,
          homeTeam: g.homeTeam,
        },
      });
      usedGames.add(norm(g.awayTeam) + '|' + norm(g.homeTeam));
      count++;
      console.log('[picks] market fill [' + lg + ']: ' + pick.pick + ' (' + matchup + ')');
    }
  }
  return fills;
}

// Generate sports value picks via a three-stage research pipeline:
//
//   1. SCOUT    — given today's real ESPN schedule, Claude picks 8-10 candidate
//                 games worth researching and writes a specific research question
//                 for each (injury status, recent form, line movement, etc.).
//   2. RESEARCH — Claude runs web_search to answer each research question,
//                 citing real sources. Produces a short briefing per candidate.
//   3. FINALIZE — Armed with verified research, Claude returns 5-8 picks. Only
//                 candidates where research revealed genuine edge make the cut;
//                 candidates without edge get dropped.
//
// This trades latency (~60-90s vs ~5s) for ground truth. The 12-hour cron can
// easily absorb that. If any stage fails, falls back to simpler single-pass
// generation so the site never renders without picks.
async function generatePicks() {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  let games = [];
  const leagues = [
    {label:'NBA',        urlPath:'basketball/nba'},
    {label:'MLB',        urlPath:'baseball/mlb'},
    {label:'NHL',        urlPath:'hockey/nhl'},
    {label:'NFL',        urlPath:'football/nfl'},
    {label:'EPL',        urlPath:'soccer/eng.1'},
    {label:'LA LIGA',    urlPath:'soccer/esp.1'},
    {label:'BUNDESLIGA', urlPath:'soccer/ger.1'},
    {label:'SERIE A',    urlPath:'soccer/ita.1'},
    {label:'LIGUE 1',    urlPath:'soccer/fra.1'},
    {label:'UCL',        urlPath:'soccer/uefa.champions'},
    {label:'MLS',        urlPath:'soccer/usa.1'},
    // ─── Tournaments: only produce games while in season, harmless otherwise ───
    {label:'WORLD CUP',  urlPath:'soccer/fifa.world'},
    {label:'EUROS',      urlPath:'soccer/uefa.euro'},
    {label:'COPA AMERICA', urlPath:'soccer/conmebol.america'},
  ];
  const espnFailed = []; // leagues whose scoreboard fetch errored (NOT "no games")
  for (const lg of leagues) {
    let d = null;
    // Two attempts — a single 6s timeout at 7 AM ET was silently wiping entire
    // sports (one MLB flake = zero MLB picks all day).
    for (let attempt = 1; attempt <= 2 && !d; attempt++) {
      try {
        const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + lg.urlPath + '/scoreboard', {signal:AbortSignal.timeout(attempt === 1 ? 6000 : 10000)});
        if (res.ok) d = await res.json();
        else if (attempt === 2) espnFailed.push(lg.label);
      } catch(e) {
        if (attempt === 2) {
          espnFailed.push(lg.label);
          console.warn('[picks] ESPN scoreboard failed twice for ' + lg.label + ': ' + e.message);
        }
      }
    }
    if (!d) continue;
    try {
      for (const ev of (d.events||[]).slice(0,4)) {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors||[];
        const home = teams.find(t=>t.homeAway==='home')||teams[0];
        const away = teams.find(t=>t.homeAway==='away')||teams[1];
        if (ev.status?.type?.name === 'STATUS_FINAL' || ev.status?.type?.name === 'STATUS_FULL_TIME') continue;
        const gt = new Date(ev.date).toLocaleString('en-US',{weekday:'short',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}) + ' ET';
        const awayName = away?.team?.displayName || '';
        const homeName = home?.team?.displayName || '';
        const awayRec  = away?.records?.[0]?.summary || '';
        const homeRec  = home?.records?.[0]?.summary || '';
        games.push(lg.label + ': ' + awayName + (awayRec ? ' (' + awayRec + ')' : '') +
                   ' @ ' + homeName + (homeRec ? ' (' + homeRec + ')' : '') + ' — ' + gt);
      }
    } catch(e) {}
  }

  if (games.length === 0) {
    if (!process.env.ODDS_API_KEY) {
      console.warn('[picks] no games returned from ESPN and no odds key — skipping pick generation');
      return [];
    }
    console.warn('[picks] ESPN returned no games — falling back to The Odds API for the slate');
  }

  // (the games list for prompts is built AFTER odds pricing, as gamesListWithOdds)

  // ─── STAGE 0: REAL MARKET ODDS ─────────────────────────────────────────────
  // Fetch actual bookmaker lines from The Odds API. This is the foundation —
  // without real lines, "value" calculations are fiction. We line-shop across
  // multiple US books and pick the BEST price per side per game. That's a
  // genuine, measurable edge that any sharp bettor would use.
  //
  // Budget discipline: free tier = 500 credits/month. h2h+spreads+totals × us
  // region = 3 credits per league call. We hit only leagues with games today,
  // so a typical day uses ~10-15 credits. Roughly 30-50 cycles per month.
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  const oddsByGame = {}; // matchup-key → bookmaker odds
  if (ODDS_API_KEY) {
    // Map our internal labels to The Odds API's sport keys (shared constant).
    const oddsSportKeys = ODDS_SPORT_KEYS;
    // Identify which leagues actually have games on the schedule today.
    const leaguesWithGames = new Set();
    games.forEach(g => {
      const m = g.match(/^([A-Z][A-Z0-9 ]+):/);
      if (m && oddsSportKeys[m[1].trim()]) leaguesWithGames.add(m[1].trim());
    });
    // ESPN-side hardening: a league whose scoreboard fetch FAILED (as opposed
    // to legitimately having no games) still gets priced from the odds side, so
    // an ESPN flake can't blank a sport. The far-future filter downstream
    // discards offseason opener lines this might pull in.
    espnFailed.forEach(l => {
      if (oddsSportKeys[l] && !leaguesWithGames.has(l)) {
        console.log('[picks] ESPN failed for ' + l + ' — pricing it from The Odds API as backup');
        leaguesWithGames.add(l);
      }
    });
    // Total ESPN outage: price the core US leagues and build the slate from odds.
    if (games.length === 0) {
      ['NBA','MLB','NHL','NFL'].forEach(l => leaguesWithGames.add(l));
    }
    console.log('[picks] stage 0: fetching real odds for ' + leaguesWithGames.size + ' leagues...');
    for (const league of leaguesWithGames) {
      await fetchLeagueOdds(league, oddsByGame);
    }
    console.log('[picks] stage 0: priced ' + Object.keys(oddsByGame).length + ' total games');
    // If ESPN gave us nothing, rebuild the prompt's games list from the priced
    // odds (only games starting within 36h, so offseason lines don't leak in).
    if (games.length === 0) {
      Object.values(oddsByGame).forEach(o => {
        const ts = Date.parse(o.commenceTime || '');
        if (isNaN(ts) || ts < Date.now() - 3600000 || ts > Date.now() + 36 * 3600 * 1000) return;
        games.push(o.league + ': ' + o.awayTeam + ' @ ' + o.homeTeam + ' — ' + etTimeLabel(o.commenceTime));
      });
      console.log('[picks] synthesized ' + games.length + ' games from odds data (ESPN outage fallback)');
      if (games.length === 0) return [];
    }
  } else {
    console.warn('[picks] ODDS_API_KEY not set — pipeline will run without real market lines (degraded mode)');
  }

  // Rebuild gamesList with odds inlined under each game so Claude sees real
  // bookmaker prices, not just team records. This is the input for both the
  // scout and the finalize stages — the line is what makes the math real.
  const enrichedGames = games.map(g => {
    // The first segment of g looks like "NBA: Away @ Home (rec) — Day H:MM ET"
    // Extract the matchup portion and try to match against oddsByGame.
    const m = g.match(/^[A-Z][A-Z0-9 ]+:\s*(.+?)\s+@\s+(.+?)(?:\s+\(|$)/);
    if (!m) return g;
    const awayName = m[1].trim();
    const homeNamePart = g.substring(g.indexOf('@') + 1).trim();
    // Find which oddsByGame entry matches this matchup. Try fuzzy team-name match.
    const candidate = Object.values(oddsByGame).find(o =>
      o.awayTeam && o.homeTeam &&
      (awayName.includes(o.awayTeam) || o.awayTeam.includes(awayName.split(' ')[0])) &&
      (homeNamePart.includes(o.homeTeam) || o.homeTeam.includes(homeNamePart.split(/[(\s]/)[0]))
    );
    if (!candidate) return g;
    return g + '\n' + formatOddsForPrompt(candidate);
  });
  const gamesListWithOdds = enrichedGames.join('\n\n');
  // ─── STAGE 1: SCOUT ────────────────────────────────────────────────────────
  // Pick 5-8 candidate games worth researching, plus a SPECIFIC question each.
  // Note: scout prompt now includes real bookmaker lines so Claude can spot
  // games where the line itself looks soft before deciding to research.
  const scoutPrompt = `You are a professional sports handicapper. Today is ${today}.

Here are the real games scheduled today, WITH live bookmaker lines (line-shopped across US books for best price per side):
${gamesListWithOdds}

Select 6-10 CANDIDATE bets where you suspect REAL edge might exist. Mix game-line bets AND player props. Quality over quantity, but the downstream pipeline needs enough variety to land 2-4 final picks across multiple sports — give it diverse candidates.

**SPORT DIVERSITY (important):** If 2 or more sports have games today, your candidate list MUST include at least 1 candidate from each active sport. Even on quiet nights for a sport, surface its single best candidate. The downstream finalize stage decides what survives — don't pre-filter so hard that the slate looks single-sport.

WHAT MAKES A BET WORTH RESEARCHING:

GAME LINES (spread / moneyline / total):
• A key player has injury news that may not be priced in yet
• A clear scheduling spot (back-to-back, long road trip, lookahead spot before a marquee game)
• A significant lineup/rotation change reported recently
• A statistical mismatch you can plausibly verify (elite defense vs slumping offense, pace mismatch, etc.)
• A weather/venue factor (outdoor sports)
• Recent coaching change or system shift
• Sharp line movement or reverse line movement reported

PLAYER PROPS (player_prop) — equally valid, often overlooked:
• Player faces a defense ranked top-3 (or bottom-3) at their position — line hasn't fully adjusted
• Player on minutes restriction / coming off injury — under on their stat is live
• Pace/usage spike expected (teammate out, opponent plays fast) — over is live
• Recent stat trend over last 5-10 games diverges from the season line
• Specific matchup mismatch (small-ball lineup forces a center out, etc.)
• Reverse engineer: which propped player has the clearest path to over/under given today's expected gameflow?

DO NOT pick candidates just to fill quota. But DO surface at least one candidate per active sport unless that sport truly has zero researchable edges.

For each candidate, specify:
- The exact matchup (copy from the list)
- The league (use exact label from the list)
- The bet TYPE (spread | moneyline | total | player_prop | first_half)
- For player_prop: name the specific player AND the stat (e.g. "Jalen Brunson points")
- A SPECIFIC, ANSWERABLE research question — something that could change the pick if answered.

GOOD research questions (specific, decision-altering):
- "Is Rudy Gobert playing tonight, and what's the Timberwolves' offensive rating without him in 2026?"
- "What is Jalen Brunson's points per game vs top-10 defenses in 2026, and where is his prop line set tonight?"
- "Did the Astros formally announce their rotation for this series? Is the matchup confirmed?"
- "What's Lens's scoring average in away matches in 2026, and Brest's goals-allowed rate at home?"

BAD research questions (vague, can't be answered concretely):
- "Is this a good bet?"
- "Who has the edge?"
- "Will the Knicks cover?"

Return ONLY valid JSON:
{"candidates":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","question":"Specific researchable question"}]}

Aim for at least 1 candidate per active sport. Empty array is only acceptable if literally every game today has zero researchable angle: {"candidates":[]}`;

  let candidates = [];
  try {
    console.log('[picks] stage 1/3: scouting candidates...');
    const scoutRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // Scout output is tiny JSON: 5-8 candidates × ~50 tokens each ≈ 400 tokens.
        // 1500 leaves comfortable headroom; 2500 was 60% wasted.
        max_tokens: 1500,
        messages: [{ role:'user', content: scoutPrompt }],
      }),
    });
    const scoutData = await scoutRes.json();
    if (!scoutRes.ok) throw new Error('scout API ' + scoutRes.status + ': ' + (scoutData.error?.message||''));
    const scoutText = (scoutData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const start = scoutText.indexOf('{'), end = scoutText.lastIndexOf('}');
    if (start === -1) throw new Error('scout returned no JSON');
    candidates = (JSON.parse(scoutText.slice(start,end+1)).candidates||[])
      .filter(c => c && c.matchup && c.league && c.type && c.question);
    console.log('[picks] stage 1/3: got ' + candidates.length + ' candidates');
  } catch (e) {
    console.warn('[picks] scout stage failed:', e.message);
    // Fall through to legacy one-shot generation below
  }

  // ─── STAGE 2: RESEARCH ─────────────────────────────────────────────────────
  // Hand candidates + questions to Claude with web_search enabled. Budget one
  // combined call rather than per-candidate to save tokens and latency.
  let researchBriefings = '';
  if (candidates.length > 0) {
    const candidateList = candidates.map((c, i) =>
      `[${i+1}] ${c.league} — ${c.matchup} (bet type: ${c.type})\n    QUESTION: ${c.question}`
    ).join('\n\n');

    const researchPrompt = `You are a professional sports handicapper doing research to inform betting recommendations. Use the web_search tool aggressively — this is what it's for.

Today is ${today}. For each candidate below, search the web to answer the specific question. Cite concrete facts: exact stats, dates, quotes from beat reporters, lineup news, line movement. If a question can't be confidently answered from search results, say so plainly — do NOT make up numbers.

CANDIDATES:
${candidateList}

Format your output as a BRIEFING per candidate, like a handicapper's notebook:

---
[1] LEAGUE — Matchup (type)
Verified facts from research:
• Fact with source (e.g., "Gobert listed OUT per Shams, ESPN Apr 23")
• Fact with source
• Fact with source
Edge assessment: CLEAR / MODERATE / NONE — one sentence why.
---

Prioritize answering the question asked. 2-4 facts per candidate is ideal. Be ruthless about flagging NO EDGE when research contradicts the premise — a candidate getting dropped is a win for the reader.`;

    try {
      console.log('[picks] stage 2/3: researching ' + candidates.length + ' candidates via web_search...');
      const researchRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          // Research briefings are ~3-4k tokens (5-8 candidates × short bullet
          // facts). 5000 is enough; 8000 was unused. max_uses dropped 6 → 4
          // because each search pulls full page contents into input — biggest
          // single cost in this call. 4 searches still covers 5-8 candidates.
          max_tokens: 5000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
          messages: [{ role:'user', content: researchPrompt }],
        }),
      });
      const researchData = await researchRes.json();
      if (!researchRes.ok) throw new Error('research API ' + researchRes.status + ': ' + (researchData.error?.message||''));
      researchBriefings = (researchData.content||[])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      console.log('[picks] stage 2/3: research complete, ' + researchBriefings.length + ' chars of briefing');
    } catch (e) {
      console.warn('[picks] research stage failed:', e.message);
      researchBriefings = '';
    }
  }

  // ─── STAGE 3: FINALIZE ────────────────────────────────────────────────────
  // Hand research briefings back to Claude and ask for the final curated picks.
  // Default posture: ZERO PICKS unless something genuinely stands out.
  // The goal is hit rate, not pick volume.
  const hasResearch = !!researchBriefings;
  const hasOdds = !!(gamesListWithOdds && gamesListWithOdds.length > 50);

  // When ODDS_API_KEY is unset (degraded mode), gamesListWithOdds is empty.
  // Previously Claude would interpret "no lines" as "no schedule" and return
  // {"picks":[]} — exactly what we want to avoid. The degraded-mode preamble
  // tells Claude: lines are missing today, evaluate on research strength alone,
  // and STILL produce 1 pick from the researched candidates.
  const degradedPreamble = hasOdds ? '' : `
**IMPORTANT: TODAY IS DEGRADED MODE.** Live bookmaker lines are temporarily unavailable. Do NOT return an empty picks array because of missing lines. Instead, evaluate each researched candidate based on the strength of its named edge (injury severity, scheduling spot, statistical mismatch) and return the candidates with verified edges. Without real lines NOTHING can be labeled high confidence today — cap everything at medium and note in the edge text that lines weren't available for cross-verification.

`;

  const ctx = hasResearch
    ? `${degradedPreamble}RESEARCH BRIEFINGS (web-verified facts from searches just performed):\n\n${researchBriefings}${hasOdds ? `\n\nSCHEDULE WITH REAL BOOKMAKER LINES (line-shopped across US books):\n${gamesListWithOdds}` : '\n\n(No live bookmaker lines available today — evaluate edges from research alone.)'}`
    : `${degradedPreamble}Real upcoming games${hasOdds ? ' WITH live bookmaker lines (line-shopped across US books)' : ''}:\n${gamesListWithOdds || '(odds API unavailable today)'}`;

  const finalPrompt = `You are a professional sports handicapper grading your own bets. Today is ${today}.

${ctx}

YOUR JOB: PRODUCE A FULL DAILY SLATE — 2-4 PICKS FOR EVERY SPORT WITH GAMES.

Confidence is the ONLY hierarchy, and it must be earned:
• "high" picks carry the site's tracked record. A pick may ONLY be labeled high when BOTH are true: (1) the research briefings confirm a specific, sourced edge for it, AND (2) it is placed on a real bookmaker line copied EXACTLY from the lines list. One missing → it is not high.
• "medium" and "low" picks fill out each sport's slate honestly. They still need a stated angle, but the bar is lighter.

This is a daily morning post. The picks go up at 7 AM ET and are graded that night. The site MUST have at least 1 pick visible — empty days are not acceptable unless the entire schedule is empty (zero games, e.g. an All-Star break with no games anywhere).

Random picks at -110 lose money long-term — you need 52.4% just to break even, and "fair line, slight lean" picks historically hit ~50%. So a "lean" without a real edge is a losing bet by definition. Don't take it.

PICKS ARE RANKED. Lead with your single highest-conviction play of the day. Then, only if a second and third play also clear the full bar, include them in conviction order. ALWAYS include at least your single best play — even on a quiet slate, your top researched candidate goes in as a medium-confidence pick.

═══════════════════════════════════════════════════════════════
THE BAR FOR A PICK (ALL THREE REQUIRED)
═══════════════════════════════════════════════════════════════

A pick must clear ALL THREE of these tests. If any one fails, drop it.

TEST 1 — A SPECIFIC, NAMEABLE EDGE
The edge must be one of these, with concrete evidence from the research briefings:

For game lines (spread / moneyline / total):
  • Confirmed injury/absence with a quantifiable team impact (e.g. "team is -8 net rating without star X over Y-game sample")
  • Confirmed lineup/rotation change reported by a beat reporter (cite the source)
  • Clear scheduling spot (back-to-back, 3rd road game in 4 nights, lookahead spot, altitude/travel)
  • Stat mismatch where you can name the specific numbers on both sides
  • Sharp line movement OR reverse line movement reported in the briefings
  • Public-money trap: heavy public on one side, line not moving toward it

For player props:
  • Player faces a defense ranked top-3 or bottom-3 vs their position, AND the prop line doesn't reflect that mismatch
  • Player on minutes restriction or returning from injury (under live), or teammate out boosting usage (over live)
  • Recent 5-10 game stat trend clearly diverges from the season line — cite the specific numbers
  • Pace/usage spike from confirmed lineup change (e.g., starter out, sixth man inherits role)
  • Specific position mismatch you can name (small-ball forces center out, etc.)

NOT edges: "better team," "playing at home," "form looks good," "due for a win," "hot shooter," "bad matchup," "tough spot."

TEST 2 — THE LINE GIVES YOU PRICE
The market line shown in the schedule must actually offer value given the edge above. Examples:
  • Edge: Star out → spread should be moving toward the depleted team and you're getting it before it does, OR the line hasn't moved enough yet
  • Edge: Sharp move → you're catching the same side at a still-available number
If the line has already fully absorbed the edge ("market knows"), there's no pick. Drop it.

TEST 3 — RESEARCH ACTUALLY CONFIRMS IT
The research briefing must contain specific facts (numbers, sources, dates) that support the edge. If the briefing says "no edge found" or "research couldn't confirm," DROP THE PICK. Don't argue around the briefing — the briefing's whole job is to catch you.

═══════════════════════════════════════════════════════════════
HOW MANY PICKS — AND HOW TO PICK THEM
═══════════════════════════════════════════════════════════════

• For EVERY sport that has games in the lines list: 2-4 picks. A sport with games and zero picks is a failure.
• HIGH confidence: 0-2 per day across the whole slate. These must clear ALL THREE tests above AND sit on a real listed line copied exactly. If nothing clears that bar today, ship zero high picks — a 0-high day is honest, a fake-high day poisons the record.
• MEDIUM confidence: a solid angle backed by at least one concrete number (rest spot, road/home split, pace matchup, price value where one book is off consensus, a research finding that's real but not overwhelming).
• LOW confidence: a defensible lean at a fair price, labeled honestly. Most volume picks should be low or medium — that's correct.
• Every pick comes from a game in the lines list, on the EXACT line and price shown. NEVER write a model-projected number as the line: "Over 6.2" is not a bookable bet — books post 5.5, 6, 6.5. If the listed total is 5.5, your pick is "Over 5.5". No exceptions, any tier.
• Player props (no listed lines available): allowed as medium or low only, never high.
• Writeups: high picks get the full 2-3 paragraph treatment below. Medium/low picks get ONE short paragraph naming the angle and the price.
• Don't double the same game+side at two confidence levels. Different side or different market of the same game is fine.
• If the lines list is empty (degraded mode), return researched picks only, ALL capped at medium.

PICK ORDER: high first (conviction order), then medium, then low, grouped by sport within each level.

TIE-BREAKER FOR THE TOP HIGH PICK:
1. Largest verified edge (most concrete supporting facts)
2. Most favorable line (sharpest priced wrong)
3. Most reliable bet type for the named edge (spread/total for game-line edges)

If you genuinely cannot find ANY confirmed edge across the entire slate, that's fine — ship a slate of medium/low picks and zero highs.

═══════════════════════════════════════════════════════════════
CONFIDENCE LABELS — THE RECORD ONLY TRACKS "HIGH"
═══════════════════════════════════════════════════════════════

  • "high"   = research-verified edge (multiple supporting facts, sources) on a real listed line copied exactly. You'd bet 2 units. These are graded into the public record, so a sloppy high pick damages the site directly. 0-2 per day, often 0.
  • "medium" = one strong concrete fact, fair-to-good price.
  • "low"    = a defensible lean at a fair price, labeled honestly.

The published hit rate counts high picks ONLY. Mislabeling a lean as high is the single worst thing you can do in this job.

═══════════════════════════════════════════════════════════════
EDGE FIELD FORMAT
═══════════════════════════════════════════════════════════════

2–3 short paragraphs. The first paragraph names the edge with concrete numbers and a source. The second paragraph explains why the market hasn't fully priced it. The third paragraph (optional) names the risk that would make this pick lose.

GOOD EXAMPLE:
"Devin Booker is OUT (Shams, 2hr ago). Phoenix is -8.4 net rating without him in a 12-game sample this season, and they're on the second night of a back-to-back after losing in LA last night. Their offense ranks 27th over that stretch.

Line opened Nuggets -5 and is currently -7.5 on DraftKings — moving toward Denver but not all the way to where the no-Booker number historically lands (-9 to -10 against playoff-tier home teams). Sharp money has been on Denver per VSiN line tracker.

Risk: Durant has carried stretches solo before, and a back-door cover at -7.5 is one missed FT away."

This is a real pick. Specific numbers, named sources, the line's history, sharp-side confirmation, and an honest acknowledgment of the bust case.

═══════════════════════════════════════════════════════════════
WHAT TO AVOID (HARD FAILURES)
═══════════════════════════════════════════════════════════════

• Generic narrative: "Team A is the better team and should win at home." Only acceptable at LOW confidence, and only when backed by a concrete number from the lines list or schedule (record differential, rest days).
• Stats with no source: "they cover 67% of the time in this spot" without the research briefing backing it. Drop.
• Hedge language in HIGH picks: "lean," "small edge," "could go either way," "feels like." If you wrote those words, the pick is not high. Relabel it low.
• "Fair line, here's the side I prefer" as a HIGH pick. This is the exact profile of a -110 coin flip and it is the reason records like 9-14 happen. Label it low or drop it.
• Inventing, rounding, or projecting a line/price ANYWHERE. Every number must come from the schedule's listed lines. "Over 6.2" because a model projects 6.2 goals is an instant hard failure — the bet is on the BOOK'S number.

═══════════════════════════════════════════════════════════════
FORMATS
═══════════════════════════════════════════════════════════════

TIME: "Today H:MM PM ET" or "Tonight H:MM PM ET"

TYPE: "spread" | "moneyline" | "total" | "player_prop" | "first_half"

PICK by type:
  spread      → "Team +/-X.X"         e.g. "Knicks -5.5", "Arsenal -0.5"
  moneyline   → "Team ML"             e.g. "Thunder ML"
  total       → "Over/Under X.X"      e.g. "Under 218.5", "Over 5.5" — the book's listed number, never a projection
  player_prop → "Player O/U X.X Stat" e.g. "Jalen Brunson Over 28.5 Points"
  first_half  → "Team +/-X.X (1H)"    e.g. "Celtics -3.5 (1H)"

ODDS: copy the price from the schedule. Don't invent.
MATCHUP: copy the matchup line from the schedule verbatim, including team names exactly as shown.
LEAGUE: NBA, NFL, MLB, NHL, EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, MLS

PICK ORDER IN THE OUTPUT ARRAY MATTERS: high picks first in conviction order, then medium, then low.

═══════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON:

{"picks":[
  {"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","pick":"Team -4.5","odds":"-110","edge":"Specific named edge with source. Why the market hasn't adjusted. The bust case.","confidence":"high"},
  {"matchup":"Away @ Home","league":"NHL","type":"moneyline","when":"Today 8:00 PM ET","pick":"Team ML","odds":"-135","edge":"One paragraph: the angle and the price, copied from the lines list.","confidence":"low"}
]}

You MUST return at least 1 pick if there are any games on the slate. Pick your single best researched candidate even if no clear "edge" emerged — flag it as medium confidence and explain what made it the best of an unclear slate. Empty arrays ONLY when the schedule itself has zero games (rare; All-Star break, off-season day with no major leagues active).

A day with zero picks is not a failure. It's discipline.`;

  console.log('[picks] stage 3/3: finalizing picks...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model:'claude-haiku-4-5-20251001',
      // Tiered slate: up to 3 edge picks (~250 tokens each) plus 1-3 board
      // picks per active sport (~80 tokens each). 4500 covers a 4-sport day
      // with headroom. Still one call — only the output budget grew.
      max_tokens: 4500,
      messages:[{role:'user',content:finalPrompt}]
    }),
  });
  const data = await res.json();
  if (!res.ok) return [];
  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s===-1) return [];
  try {
    const raw = (JSON.parse(text.slice(s,e+1)).picks||[]).filter(p=>p&&p.matchup&&p.pick);
    const validTypes = new Set(['spread','moneyline','total','player_prop','first_half']);
    let finalPicks = raw.map(p => {
      const t = String(p.type||'').toLowerCase().replace(/\s+/g,'_').replace(/prop$/,'player_prop');
      const c = String(p.confidence||'').toLowerCase();
      return {
        ...p,
        type: validTypes.has(t) ? t : 'spread',
        confidence: (c === 'high' || c === 'low') ? c : 'medium'
      };
    });
    console.log('[picks] stage 3/3: finalized ' + finalPicks.length + ' picks');
    finalPicks.forEach((p, i) => {
      console.log('[picks] candidate ' + (i+1) + ' [' + p.confidence + ']: ' + (p.league||'?') + ' / ' + (p.pick||'?') + ' (edge len: ' + (p.edge||'').length + ')');
    });

    // ─── RETRY: ZERO-PICKS RESCUE ─────────────────────────────────────────────
    // If Claude returned exactly zero picks despite having research briefings
    // to work from, re-prompt with a much more direct ask: pick ONE candidate,
    // any candidate, from the briefings — your single best researched play.
    // This costs one extra small Claude call only on the failure path, and
    // ensures the morning post never goes up empty when research existed.
    if (finalPicks.length === 0 && hasResearch) {
      console.log('[picks] stage 3/3 returned 0 picks despite research; triggering rescue call...');
      const rescuePrompt = `You just returned an empty picks array. That is not acceptable for today's slate.

Below are the same research briefings you already saw. Pick ONE — your single best researched candidate. Even if no edge is screaming, the briefing with the most concrete supporting facts wins. Mark it medium confidence and explain in the edge text what made it the best of an unclear slate.

${ctx}

Return ONLY valid JSON:
{"picks":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","pick":"Team -4.5","odds":"-110","edge":"Why this researched candidate has the strongest supporting facts. What makes it the best of today's slate.","confidence":"medium"}]}

You MUST return exactly 1 pick. Not zero. Pick the candidate with the most concrete supporting facts from the briefings above.`;

      try {
        const rescueRes = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({
            model:'claude-haiku-4-5-20251001',
            max_tokens: 1500,
            messages:[{role:'user',content:rescuePrompt}]
          }),
        });
        const rescueData = await rescueRes.json();
        if (rescueRes.ok) {
          const rescueText = (rescueData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          const rs = rescueText.indexOf('{'), re = rescueText.lastIndexOf('}');
          if (rs !== -1) {
            const rescueRaw = (JSON.parse(rescueText.slice(rs, re+1)).picks||[]).filter(p=>p&&p.matchup&&p.pick);
            finalPicks = rescueRaw.map(p => {
              const t = String(p.type||'').toLowerCase().replace(/\s+/g,'_').replace(/prop$/,'player_prop');
              // Rescue picks come from an "unclear slate" by definition — never high.
              const c = String(p.confidence||'').toLowerCase();
              return { ...p, type: validTypes.has(t) ? t : 'spread', confidence: c === 'low' ? 'low' : 'medium' };
            });
            console.log('[picks] rescue call returned ' + finalPicks.length + ' picks');
          }
        }
      } catch (rescueErr) {
        console.warn('[picks] rescue call failed:', rescueErr.message);
      }
    }

    // ─── DISCIPLINE FILTER ─────────────────────────────────────────────────────
    // The prompt enforces quality, but the filter is the safety net. We drop
    // picks that exhibit the structural signatures of a weak pick: low confidence,
    // thin edge text, no concrete numbers, or hedge language ("lean", "slight edge",
    // "feels like"). HOWEVER — this is a daily morning post and the site needs
    // at least one pick visible. If the strict filter zeroes everything out,
    // we fall back to the BEST candidate Claude returned (longest sourced edge)
    // rather than publishing an empty slate.
    const beforeCount = finalPicks.length;
    const HEDGE_PHRASES = [
      /\bslight (?:edge|lean)\b/i,
      /\bsmall edge\b/i,
      /\bfair line\b/i,
      /\bfeels? like\b/i,
      /\bcould go either way\b/i,
      /\btough (?:one to )?call\b/i,
      /\bcoin[- ]flip\b/i,
      /\bno (?:real |strong )?edge\b/i,
      /\bjust a lean\b/i,
    ];

    // Score each candidate by how thoroughly it clears the bar. We use this
    // both to filter (score >= 4 passes) AND to rank fallback picks if every
    // candidate fails the strict filter.
    function scoreCandidate(p) {
      const conf = String(p.confidence||'').toLowerCase();
      const edge = String(p.edge||'');
      let score = 0;
      const reasons = [];
      if (conf === 'high') { score += 2; reasons.push('high-conf'); }
      else if (conf === 'medium') { score += 1; reasons.push('med-conf'); }
      else { reasons.push('low/no-conf'); }
      if (edge.length >= 120) { score += 1; reasons.push('edge-length-ok'); }
      else { reasons.push('edge-short'); }
      const numCount = (edge.match(/\d+(?:\.\d+)?/g) || []).length;
      if (numCount >= 2) { score += 1; reasons.push('has-numbers'); }
      else { reasons.push('thin-numbers'); }
      const hasSourceMarker = /\b(?:per|via|reported|confirmed|official|out|inactive|listed|ESPN|Shams|Wojnarowski|Woj|Athletic|sources?)\b/i.test(edge);
      if (hasSourceMarker) { score += 1; reasons.push('has-source'); }
      else { reasons.push('no-source'); }
      const hedgeHit = HEDGE_PHRASES.find(rx => rx.test(edge));
      if (hedgeHit) { score -= 2; reasons.push('hedge-language'); }
      return { score, reasons };
    }

    // ─── CONFIDENCE GATES ──────────────────────────────────────────────────────
    // High confidence is a CLAIM, not a label. Two gates verify it:
    //   GATE 1 (here, research): the edge text must score like a researched
    //     pick — concrete numbers, a source marker, no hedge language. Fail →
    //     downgraded to medium, never dropped.
    //   GATE 2 (after odds matching below, real lines): the pick must carry a
    //     real bookmaker snapshot AND, for spreads/totals, the number in the
    //     pick must equal the book's listed line. Fail → downgraded to medium.
    // Medium/low picks get a light sanity gate: stated rationale, per-sport cap,
    // no duplicates. They're volume; the record doesn't count them.
    finalPicks.forEach(p => {
      if (p.confidence !== 'high') return;
      const { score, reasons } = scoreCandidate(p);
      const hedged = HEDGE_PHRASES.some(rx => rx.test(String(p.edge||'')));
      if (score < 4 || hedged) {
        console.log('[picks] HIGH→MEDIUM (research gate failed: score ' + score + ', ' + reasons.join(', ') + '): ' + p.pick);
        p.confidence = 'medium';
      }
    });

    // Cap high picks at 2/day — the prompt asks for 0-2; enforce it. Extras
    // become medium (keep the best-scoring ones high).
    const highs = finalPicks.filter(p => p.confidence === 'high');
    if (highs.length > 2) {
      highs.map(p => ({ p, ...scoreCandidate(p) }))
        .sort((a,b) => b.score - a.score)
        .slice(2)
        .forEach(s => {
          console.log('[picks] HIGH→MEDIUM (max 2 high/day): ' + s.p.pick);
          s.p.confidence = 'medium';
        });
    }

    // Sanity gate for the whole slate.
    const MAX_PER_SPORT = 4;
    const sportCount = {};
    const seenIds = new Set();
    finalPicks = finalPicks.filter(p => {
      if (String(p.edge||'').trim().length < 40) {
        console.log('[picks] DROP (no rationale): ' + p.pick);
        return false;
      }
      const id = pickId(p);
      if (seenIds.has(id)) {
        console.log('[picks] DROP (duplicate game+side): ' + p.pick);
        return false;
      }
      seenIds.add(id);
      const lg = String(p.league||'other').toUpperCase();
      sportCount[lg] = (sportCount[lg]||0) + 1;
      if (sportCount[lg] > MAX_PER_SPORT) {
        console.log('[picks] DROP (>' + MAX_PER_SPORT + ' for ' + lg + '): ' + p.pick);
        return false;
      }
      return true;
    });
    console.log('[picks] gates: ' + beforeCount + ' → ' + finalPicks.length + ' picks (' + finalPicks.filter(p=>p.confidence==='high').length + ' high)');

    // Annotate picks with the market line at pick time — needed for closing line
    // value tracking later. This is what real bettors use to evaluate skill.
    //
    // Matching is fuzzy because Claude can return matchups in many shapes:
    // "Houston Astros @ Cincinnati Reds", "Astros @ Reds", "Houston @ Cincinnati",
    // sometimes with city or nickname only. We tokenize both sides and look for
    // any meaningful (>3 char) token overlap on both away and home halves.
    const tokenize = (s) => String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 3); // drop "the", "fc", "vs", etc.

    finalPicks = finalPicks.map(p => {
      const matchupStr = String(p.matchup || '');
      const atIdx = matchupStr.indexOf('@');
      if (atIdx === -1) return p;
      const pickAwayTokens = tokenize(matchupStr.slice(0, atIdx));
      const pickHomeTokens = tokenize(matchupStr.slice(atIdx + 1));

      // Find an oddsByGame entry whose away/home full names share at least one
      // meaningful token with the pick's away/home halves (respectively).
      const matched = Object.values(oddsByGame).find(o => {
        if (!o || !o.awayTeam || !o.homeTeam) return false;
        const oAwayTokens = tokenize(o.awayTeam);
        const oHomeTokens = tokenize(o.homeTeam);
        const awayHit = pickAwayTokens.some(t => oAwayTokens.includes(t));
        const homeHit = pickHomeTokens.some(t => oHomeTokens.includes(t));
        return awayHit && homeHit;
      });

      if (matched) {
        p.marketSnapshot = {
          capturedAt: new Date().toISOString(),
          markets: matched.markets,
          awayTeam: matched.awayTeam,
          homeTeam: matched.homeTeam,
          commenceTime: matched.commenceTime,
        };
        // The odds feed knows the REAL game time — trust it over the model's
        // "Today H:MM" guess. This both fixes the displayed time and powers
        // the far-future filter below.
        const realTs = Date.parse(matched.commenceTime || '');
        if (!isNaN(realTs)) {
          p._scheduledTs = realTs;
          p.when = etTimeLabel(matched.commenceTime) || p.when;
        }
        console.log('[picks] matched odds for: ' + p.matchup + ' → ' + matched.awayTeam + ' @ ' + matched.homeTeam);
      } else {
        console.log('[picks] NO odds match for: ' + p.matchup);
      }
      return p;
    });

    // ─── STRICT VALIDITY GATE — REAL GAME, REAL LINE, REAL TIME ────────────────
    // Every published pick MUST be a real, bookable game happening soon. The old
    // filter only dropped picks with a timestamp PAST the cutoff, which let two
    // kinds of garbage through: (1) hallucinated offseason games (e.g. an NFL
    // pick in June) that never got a real line so never got a timestamp, and
    // (2) stale picks carried forward with an old timestamp. Both crush
    // credibility. Now a pick survives ONLY if it clears ALL of:
    //   • has a real bookmaker line snapshot (marketSnapshot.markets), AND
    //   • has a resolvable game time (_scheduledTs is a number), AND
    //   • that game time is in the window [now - 3h, now + 36h].
    // No real line OR no resolvable time OR outside the window → DROPPED.
    // Player props are the one allowed exception to the line requirement (The
    // Odds API base plan doesn't price props), but they STILL must have a valid
    // near-future timestamp — which a real, scheduled game always produces.
    const now = Date.now();
    const windowStart = now - 3 * 3600 * 1000;   // 3h grace for in-progress games
    const windowEnd   = now + 36 * 3600 * 1000;   // tonight + tomorrow, nothing further
    const beforeValidity = finalPicks.length;
    finalPicks = finalPicks.filter(p => {
      const hasLine = !!(p.marketSnapshot && p.marketSnapshot.markets);
      const isProp  = String(p.type||'').toLowerCase() === 'player_prop';
      const ts      = (typeof p._scheduledTs === 'number') ? p._scheduledTs : null;

      // Must have a real line, unless it's a player prop (props can ride on
      // research alone, but only if everything else checks out).
      if (!hasLine && !isProp) {
        console.log('[picks] DROP (no real bookmaker line): ' + p.league + ' ' + p.pick);
        return false;
      }
      // Must have a resolvable game time. No timestamp = we can't prove the game
      // is real and soon = it does not ship. This is what kills the phantom
      // "Saints +7.5, Sunday 1:00 PM ET" offseason pick.
      if (ts === null) {
        console.log('[picks] DROP (no resolvable game time — likely phantom/offseason): ' + p.league + ' ' + p.pick + ' [' + (p.when||'?') + ']');
        return false;
      }
      // Must be in the near-future window.
      if (ts < windowStart) {
        console.log('[picks] DROP (game already finished — stale pick): ' + p.league + ' ' + p.pick + ' @ ' + new Date(ts).toISOString());
        return false;
      }
      if (ts > windowEnd) {
        console.log('[picks] DROP (game >36h out — offseason/future line): ' + p.league + ' ' + p.pick + ' @ ' + new Date(ts).toISOString());
        return false;
      }
      return true;
    });
    if (finalPicks.length !== beforeValidity) {
      console.log('[picks] validity gate: ' + beforeValidity + ' → ' + finalPicks.length + ' real, current, bookable picks');
    }

    // ─── GATE 2: HIGH CONFIDENCE = VERIFIED REAL LINE ──────────────────────────
    // This is the process link between research and the sportsbooks: a pick may
    // only stay "high" if it carries a live bookmaker snapshot AND its number is
    // the book's actual listed line. This is what catches model-projection bets
    // like "Over 6.2" — no book posts 6.2, so it can't match the snapshot and
    // gets downgraded. Failures downgrade to medium (the pick still ships, it
    // just doesn't touch the tracked record). In degraded mode nothing can be
    // high, period.
    function pickNumberMatchesSnapshot(p) {
      const snap = p.marketSnapshot && p.marketSnapshot.markets;
      if (!snap) return false;
      const type = String(p.type||'').toLowerCase();
      const numMatch = String(p.pick||'').match(/([+-]?\d+(?:\.\d+)?)/);
      if (type === 'moneyline') return !!(snap.h2h && (snap.h2h.home || snap.h2h.away));
      if (!numMatch) return false;
      const num = parseFloat(numMatch[1]);
      if (type === 'spread') {
        const s = snap.spreads || {};
        // The book lists mirrored numbers (home -1.5 / away +1.5); accept either.
        return [s.home, s.away].some(side => side && Math.abs(Math.abs(side.point) - Math.abs(num)) < 0.01);
      }
      if (type === 'total') {
        const t = snap.totals || {};
        return [t.over, t.under].some(side => side && Math.abs(side.point - num) < 0.01);
      }
      return false; // player_prop / first_half — no listed lines to verify, can't be high
    }

    finalPicks.forEach(p => {
      if (p.confidence !== 'high') return;
      if (!hasOdds || !(p.marketSnapshot && p.marketSnapshot.markets)) {
        console.log('[picks] HIGH→MEDIUM (line gate: no real bookmaker snapshot): ' + p.pick);
        p.confidence = 'medium';
        return;
      }
      if (!pickNumberMatchesSnapshot(p)) {
        console.log('[picks] HIGH→MEDIUM (line gate: pick number does not match the listed line): ' + p.pick);
        p.confidence = 'medium';
      }
    });

    // Final order: high → medium → low (stable within each level).
    const confRankOut = { high: 3, medium: 2, low: 1 };
    finalPicks = finalPicks
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (confRankOut[b.p.confidence]||0) - (confRankOut[a.p.confidence]||0) || a.i - b.i)
      .map(x => x.p);
    console.log('[picks] line gate complete: ' + finalPicks.filter(p=>p.confidence==='high').length + ' verified high-confidence picks');

    // ─── GUARANTEED VOLUME: PER-SPORT MARKET FILL ──────────────────────────────
    // Code, not the model, enforces "multiple picks per sport." Any sport with
    // priced games and fewer than 2 picks gets deterministic fill picks built
    // straight from the live lines (low confidence, real snapshots, honest
    // writeups). This can't run without odds — without ODDS_API_KEY there are
    // no real lines to fill from.
    if (hasOdds) {
      const fills = buildMarketFillPicks(oddsByGame, finalPicks, 2, 4);
      if (fills.length > 0) {
        finalPicks = finalPicks.concat(fills);
        console.log('[picks] market fill: +' + fills.length + ' picks to guarantee per-sport volume');
      }
    } else {
      console.warn('[picks] market fill SKIPPED — no live odds this run. Set ODDS_API_KEY in repo secrets for per-sport volume.');
    }

    // Stamp the real UTC instant of game time NOW, while "Today"/"Tomorrow"
    // still refers to the day the pick was written. Later runs use this stamp
    // instead of re-parsing the relative string on the wrong calendar day.
    finalPicks.forEach(p => {
      if (typeof p._scheduledTs === 'number') return; // fill picks carry an exact game time already
      const ts = etScheduleTs(p.when);
      if (ts) p._scheduledTs = ts;
    });

    console.log('[picks] TOTAL picks returned: ' + finalPicks.length);
    return finalPicks;
  }
  catch(e) {
    // Previously this was a silent `return []` — which meant any error in the
    // picks pipeline (Claude API hiccup, malformed JSON, odds API timeout, etc.)
    // produced an empty slate with NO trace in the logs. That made "picks empty"
    // impossible to diagnose. Now we log the error and the stage it came from,
    // and still return [] so the workflow doesn't crash the whole stories.json
    // generation — the rest of the site (clusters, sidebar, etc.) still ships.
    console.error('[picks] FATAL error in generatePicks:', e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    return [];
  }
}

async function fetchHighlights() {
  // Channel IDs verified via Wikidata/YouTube April 2026.
  // NFL's own channel blocks embedding, so we use "NFL on ESPN" which allows it.
  // SOCCER uses ESPN FC — global soccer coverage leaning Premier League / Champions
  // League / La Liga / MLS, all embed-friendly.
  const CHANNELS = [
    {name:'NBA',    id:'UCWJ2lWNubArHWmf3FIHbfcQ'},  // NBA
    {name:'NFL',    id:'UCiio0ydw439X13KyZgMIcHw'},  // NFL on ESPN (official NFL channel blocks embeds)
    {name:'MLB',    id:'UCoLrcjPV5PbUrUyXq5mjc_A'},  // MLB
    {name:'NHL',    id:'UCqFMzb-4AUf6WAIbl132QKA'},  // NHL
    {name:'WNBA',   id:'UCO9a_ryN_l7DIDS-VIt-zmw'},  // WNBA
    {name:'SOCCER', id:'UC6c1z7bA__85CIWZ_jpCK-Q'},  // ESPN FC — global soccer (EPL/UCL/La Liga/MLS)
  ];

  function timeAgoString(pubDate) {
    if (!pubDate) return 'Recent';
    const h = Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000);
    if (isNaN(h)) return 'Recent';
    if (h < 1) return 'Just now';
    if (h < 24) return h + 'h ago';
    return Math.round(h/24) + 'd ago';
  }

  // Parse a YouTube RSS XML blob directly (avoids RSS2JSON rate limits entirely).
  // Returns the first/newest entry as {videoId, title, pubDate} or null.
  function parseYoutubeXml(xml) {
    const all = parseYoutubeXmlAll(xml);
    return all.length ? all[0] : null;
  }

  // All entries (YouTube channel RSS carries up to 15 recent uploads). This
  // powers the Reels feed — the old client-side approach fetched these through
  // rss2json.com in the browser, which rate-limits constantly and left the
  // Reels tab showing "No clips available." Server-side direct RSS is reliable
  // and free, and the feed ships inside stories.json.
  function parseYoutubeXmlAll(xml) {
    const out = [];
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const body = m[1];
      const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(body) || [])[1] || '';
      const title   = (/<title>([\s\S]*?)<\/title>/.exec(body) || [])[1] || '';
      const pub     = (/<published>([^<]+)<\/published>/.exec(body) || [])[1] || '';
      if (videoId) out.push({ videoId, title: title.trim(), pubDate: pub });
    }
    return out;
  }

  const results = [];
  const reels = [];
  for (const ch of CHANNELS) {
    const ytRssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id;
    let item = null;

    // 1) Try direct fetch of YouTube's RSS (public XML, no auth, fastest)
    try {
      const res = await fetch(ytRssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 SportsBizNow/1.0' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const xml = await res.text();
        const entries = parseYoutubeXmlAll(xml);
        item = entries[0] || null;
        if (item) console.log('Highlight DIRECT ' + ch.name + ': ' + item.videoId);
        // Reels: up to 8 recent uploads per channel, max 10 days old.
        entries
          .filter(e => {
            const t = Date.parse(e.pubDate || '');
            return isNaN(t) || (Date.now() - t) < 10 * 86400000;
          })
          .slice(0, 8)
          .forEach(e => reels.push({
            league:  ch.name,
            title:   e.title,
            videoId: e.videoId,
            author:  ch.name === 'NFL' ? 'NFL on ESPN' : ch.name === 'SOCCER' ? 'ESPN FC' : ch.name,
            pubDate: e.pubDate,
            link:    'https://www.youtube.com/watch?v=' + e.videoId,
          }));
      }
    } catch (e) {
      console.warn('Highlight DIRECT ' + ch.name + ' failed: ' + e.message);
    }

    // 2) Fall back to RSS2JSON if direct fetch didn't yield a videoId
    if (!item) {
      try {
        const r = await fetch(
          'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(ytRssUrl) + '&count=1',
          { signal: AbortSignal.timeout(10000) }
        );
        const d = await r.json();
        if (d.status === 'ok' && d.items?.length > 0) {
          const first = d.items[0];
          const videoId = (first.link || '').split('v=')[1]?.split('&')[0] || '';
          if (videoId) {
            item = { videoId, title: first.title || '', pubDate: first.pubDate || '' };
            console.log('Highlight RSS2JSON ' + ch.name + ': ' + videoId);
          }
        }
      } catch (e) {
        console.warn('Highlight RSS2JSON ' + ch.name + ' failed: ' + e.message);
      }
    }

    if (item) {
      results.push({
        league:    ch.name,
        title:     item.title,
        videoId:   item.videoId,
        thumbnail: 'https://img.youtube.com/vi/' + item.videoId + '/mqdefault.jpg',
        timeAgo:   timeAgoString(item.pubDate),
        isFallback:false,
      });
      // If the direct path failed and we only have the rss2json single item,
      // make sure the league still has at least one reel.
      if (!reels.some(r => r.league === ch.name)) {
        reels.push({
          league:  ch.name,
          title:   item.title,
          videoId: item.videoId,
          author:  ch.name === 'NFL' ? 'NFL on ESPN' : ch.name === 'SOCCER' ? 'ESPN FC' : ch.name,
          pubDate: item.pubDate || '',
          link:    'https://www.youtube.com/watch?v=' + item.videoId,
        });
      }
    } else {
      console.warn('Highlight ' + ch.name + ' — no video from either source');
    }
  }
  // Newest first across all leagues, capped so stories.json stays lean.
  reels.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return { highlights: results, reels: reels.slice(0, 40) };
}

async function fetchNflDraftLive() {
  const year = new Date().getFullYear();
  // Try current year first. Fall back to previous year only if current returns
  // no picks at all (handles edge case where ESPN hasn't populated the new
  // season's draft feed until the first pick is announced).
  const candidates = [year, year - 1];
  console.log('[draft] fetching live NFL draft, candidates:', candidates.join(', '));

  const fetchJson = async (url) => {
    try {
      const r = await fetch(url.replace(/^http:/, 'https:'), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  };

  let rounds = null;
  let pickedYear = null;
  for (const y of candidates) {
    const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/draft/rounds?limit=300`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.items)) {
      console.warn(`[draft] no rounds for ${y}`);
      continue;
    }
    const totalListed = data.items.reduce((n, r) => n + ((Array.isArray(r.picks) ? r.picks.length : 0)), 0);
    console.log(`[draft] year ${y}: ${data.items.length} rounds, ${totalListed} picks listed`);
    if (totalListed > 0) { rounds = data; pickedYear = y; break; }
  }

  if (!rounds) { console.warn('[draft] no year returned picks'); return null; }

  try {
    // Collect picks. Filter by ref-PRESENCE (both athlete + team refs must be
    // populated) rather than by status name — ESPN's status names change over
    // time and we'd rather be permissive than drop real picks.
    // Also handles $ref-only children by resolving them inline.
    const rawPicks = [];
    for (const round of rounds.items) {
      const roundNum = round.number || 1;
      let picks = round.picks;
      if (picks && picks.$ref && !Array.isArray(picks)) {
        const sub = await fetchJson(picks.$ref);
        picks = sub?.items || [];
      }
      if (!Array.isArray(picks)) continue;

      for (let p of picks) {
        if (p && p.$ref && !p.status && !p.overall) {
          p = await fetchJson(p.$ref);
          if (!p) continue;
        }
        const teamRef    = p?.team?.$ref;
        const athleteRef = p?.athlete?.$ref;
        if (teamRef && athleteRef) {
          rawPicks.push({
            pick:       p.overall || p.pick || null,
            round:      roundNum,
            teamRef, athleteRef,
            tradeNote:  p.tradeNote || '',
          });
        }
      }
    }

    console.log(`[draft] pickable (has player + team ref): ${rawPicks.length}`);
    if (rawPicks.length === 0) return null;

    // Resolve team + athlete refs in parallel batches of 15
    const resolved = [];
    const BATCH = 15;
    for (let i = 0; i < rawPicks.length; i += BATCH) {
      const batch = rawPicks.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async p => {
        const [team, ath] = await Promise.all([
          p.teamRef    ? fetchJson(p.teamRef)    : null,
          p.athleteRef ? fetchJson(p.athleteRef) : null,
        ]);
        return {
          pick:     p.pick,
          round:    p.round,
          team:     team ? (team.displayName || team.name || team.shortDisplayName || '') : '',
          player:   ath  ? (ath.fullName || ath.displayName || ((ath.firstName||'') + ' ' + (ath.lastName||'')).trim()) : '',
          position: ath?.position?.abbreviation || ath?.position?.name || '',
          school:   ath?.college?.name || '',
          note:     p.tradeNote ? `Trade: ${p.tradeNote}` : '',
        };
      }));
      resolved.push(...results);
    }

    const clean = resolved.filter(p => p && p.team && p.player);
    clean.sort((a, b) => (a.pick || 999) - (b.pick || 999));
    console.log(`[draft] resolved ${clean.length} picks with full team + player names`);

    if (clean.length === 0) return null;
    return {
      active: true,
      event:  `${pickedYear} NFL Draft`,
      picks:  clean,
      source: 'espn',
    };
  } catch (err) {
    console.warn('[draft] ESPN live fetch threw:', err.message);
    return null;
  }
}

// ─── LEAD-STORY ENRICHMENT ──────────────────────────────────────────────────
// The clustering model only sees RSS snippets (title + ~400 chars), so the lead
// story can promise something its snippet doesn't contain (a quote, a "response")
// and then paper over the hole with filler. This pass re-writes ONLY the top
// story's summary + article using web_search, so the lead (which gets the biggest
// display on the site) is grounded in real, fetched facts and actually delivers
// what the headline promises. Scoped to story[0] to bound cost; one extra
// search-enabled call per refresh. Flip ENRICH_LEAD_WITH_SEARCH to false to skip.
const ENRICH_LEAD_WITH_SEARCH = true;
const ENRICH_LEAD_COUNT = 1; // number of top stories to enrich

async function enrichLeadStories(clusters) {
  if (!ENRICH_LEAD_WITH_SEARCH || !Array.isArray(clusters) || clusters.length === 0) return;
  const targets = clusters.slice(0, ENRICH_LEAD_COUNT).filter(Boolean);
  for (const c of targets) {
    if (!c || !c.leadHeadline) continue;
    const prompt = `You are a sports reporter rewriting ONE story for a sports-business site. Use the web_search tool (you have a few searches) to find the ACTUAL specifics behind this headline, then rewrite it tight and human.

HEADLINE: "${c.leadHeadline}"
SOURCE: ${c.leadSource || ''}
CURRENT DRAFT (likely vague; may assert a reaction it cannot back up): ${c.article || c.summary || ''}

YOUR JOB:
1. Search for the concrete specifics this headline implies: exact numbers/score, the record and its previous holder, dates, dollar figures, and CRUCIALLY any real quote or response if the headline mentions a "response", "reaction", "responds", "addresses", "speaks out", or "reveals".
2. Rewrite the story so it actually delivers what the headline promises, led by hard facts.

HARD RULES:
- If the headline promises a quote or response, include what the person ACTUALLY said: a short direct quote UNDER 15 WORDS, otherwise paraphrase the substance in your own words. If after searching you genuinely cannot find what they said, DROP the response framing and just report the news. Never write "the response was understated/measured/defiant" or similar without the actual words.
- Use only facts you found via search or that are well-established history. Never invent a number, quote, or date. If sources disagree on a number, use the most recent authoritative one.
- Tone: wire-service sports reporter. Lead, facts, context, done. Mix short punchy sentences with longer ones. Name names, cite numbers. Sound like a person, not an AI.
- BANNED: em dashes (use commas, periods, or parentheses), and slop like "cements his status", "another layer to a legacy", "defies expectation", "remains the story of", "for the ages", "isn't just X, it's Y". No vague intensifiers ("brilliance", "ruthlessness", "masterclass") without a number attached.
- Copyright: at most one short quoted phrase per source; paraphrase everything else.

Return ONLY valid JSON, no markdown fences: {"summary":"2 sentences, under 180 chars, with a real fact","article":"up to 250 words, only as long as the real facts support"}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1600,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error('API ' + res.status + ': ' + (data.error?.message || ''));
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('no JSON in response');
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj.article === 'string' && obj.article.trim().length > 40) {
        c.article = obj.article.trim();
        if (typeof obj.summary === 'string' && obj.summary.trim()) c.summary = obj.summary.trim();
        console.log('[enrich] rewrote lead story via search: "' + String(c.leadHeadline).slice(0, 50) + '"');
      } else {
        console.warn('[enrich] response too thin; kept original for "' + String(c.leadHeadline).slice(0, 40) + '"');
      }
    } catch (e) {
      console.warn('[enrich] lead-story enrichment failed, keeping original:', e.message);
    }
  }
}

async function main() {
  console.log('Fetching RSS feeds...');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = dedup(results.flat());
  console.log('Total stories: ' + all.length);
  if (all.length < 3) { console.error('Too few stories — preserving existing stories.json'); process.exit(0); }

  console.log('Clustering...');
  const clustered = await cluster(all);
  console.log('Clusters: ' + clustered.clusters?.length);

  // Re-ground the lead story in real, searched facts so it delivers what its
  // headline promises (runs before tweets; story[0] is already sorted to top).
  console.log('Enriching lead story via web_search...');
  try {
    await enrichLeadStories(clustered.clusters || []);
  } catch (e) {
    console.error('[main] lead enrichment failed, continuing:', e.message);
  }

  console.log('Attaching real X posts...');
  try {
    await attachRealTweets(clustered.clusters || []);
  } catch (e) {
    console.error('[main] tweet stage failed, continuing without new tweets:', e.message);
  }

  // ─── PICKS: morning anchor only ────────────────────────────────────────────
  // The picks pipeline is the most expensive thing this script does (3 Claude
  // calls + up to 6 web_searches). Sportsbook lines and lineup news are stable
  // enough through the day that regenerating picks every 2 hours was burning
  // credits without changing the output. Run picks ONLY on:
  //   • the 12:00 UTC morning anchor (after lines + lineups are out), or
  //   • a manual workflow_dispatch (so you can force a fresh run), or
  //   • a fallback RECOVERY attempt during the day if the morning anchor
  //     somehow produced zero picks and we're still within the day window
  // On all other scheduled runs, preserve whatever picks are already in
  // stories.json so the site keeps showing them.
  const nowUtcHour = new Date().getUTCHours();
  const isManual   = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  // 11:00 UTC = 7 AM ET during DST (March-Nov) = 6 AM ET in EST (Nov-March).
  // 12:00 UTC = 8 AM ET during DST = 7 AM ET in EST.
  // Accepting both means picks always post somewhere in the 6-8 AM ET window
  // year-round without needing a manual edit when clocks change.
  const isMorningAnchor = nowUtcHour === 11 || nowUtcHour === 12;

  // RECOVERY trigger: if existing stories.json has zero picks AND we're still
  // before the evening cutoff (23 UTC = 6 PM ET), retry generation. This is
  // the safety net for "morning anchor failed, no picks for the rest of the
  // day." Costs at most one extra picks run on a bad day, but prevents the
  // "no picks for days" failure mode entirely.
  let priorPicksCount = 0;
  try {
    if (existsSync('stories.json')) {
      const prev = JSON.parse(readFileSync('stories.json', 'utf8'));
      // _pendingGrade picks are finished games waiting on ESPN finals — they
      // aren't visible content, so they don't count against recovery mode.
      priorPicksCount = (Array.isArray(prev.picks) ? prev.picks : [])
        .filter(p => !p._pendingGrade).length;
    }
  } catch (e) { /* ignore — treat as 0 */ }
  const isRecoveryAttempt =
    !isMorningAnchor &&
    !isManual &&
    priorPicksCount === 0 &&
    nowUtcHour <= 23; // before 6 PM ET — past that, accept the empty day

  const shouldRunPicks = isMorningAnchor || isManual || isRecoveryAttempt || !process.env.GITHUB_ACTIONS;

  // ─── PRUNE + GRADE STORED PICKS (runs on EVERY cycle) ───────────────────────
  // This used to live only in the off-cycle branch. That was the root cause of
  // the empty record strips: the morning anchor (and any manual run) replaced
  // clustered.picks with freshly generated ones WITHOUT grading the finished
  // picks already in stories.json. Any pick that hadn't been graded by an
  // off-cycle run before the morning anchor fired was lost forever, so
  // pick_history.json stayed empty and the tracker showed "No history yet".
  //
  // Now: every run first splits stored picks into fresh vs finished, grades
  // the finished ones from ESPN finals, and re-queues ungradeable ones (marked
  // _pendingGrade so the front-end never renders them as live content).
  async function pruneAndGradeStoredPicks() {
    let fresh = [];
    let finished = [];
    try {
      if (existsSync('stories.json')) {
        const prev = JSON.parse(readFileSync('stories.json', 'utf8'));
        const prevPicks = Array.isArray(prev.picks) ? prev.picks : [];
        const nowMs = Date.now();
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        prevPicks.forEach(p => {
          // Prefer the absolute timestamp stamped at generation time; fall back
          // to ET-aware parsing of the relative string for legacy picks.
          const ts = (typeof p._scheduledTs === 'number') ? p._scheduledTs : etScheduleTs(p.when);
          // No resolvable game time = we cannot prove this is a real, current
          // game and cannot ever grade it. DROP it rather than carrying a
          // phantom pick (e.g. an offseason "Sunday 1:00 PM ET" NFL line in
          // June) forward run after run. This was the leak that kept fake picks
          // on the page.
          if (!ts) {
            console.log('[picks] DROP from carry-forward (no resolvable game time — phantom/stale): ' + p.pick + ' [' + (p.when||'?') + ']');
            return;
          }
          if (nowMs > ts + TWO_HOURS) {
            console.log('[picks] queueing for grading (game finished): ' + p.pick + ' @ ' + p.when);
            finished.push(p);
          } else {
            fresh.push(p);
          }
        });
      }
    } catch (e) {
      console.warn('Could not read existing picks from stories.json:', e.message);
    }

    let requeued = [];
    if (finished.length > 0) {
      try {
        console.log('[grading] checking final scores for ' + finished.length + ' finished picks...');
        const graded = await gradeFinishedPicks(finished);
        if (graded.length > 0) {
          mergePickHistory(graded);
          console.log('[grading] persisted ' + graded.length + ' graded picks to pick_history.json');
        }
        // Anything ESPN hasn't posted as FINAL yet gets carried forward and
        // retried next run, flagged so it never renders as a visible pick.
        requeued = finished
          .filter(p => !graded.find(g => g.id === pickId(p)))
          .map(p => ({ ...p, _pendingGrade: true }));
        if (requeued.length > 0) {
          console.log('[grading] re-queued ' + requeued.length + ' picks for next run');
        }
      } catch (gradeErr) {
        console.error('[grading] FATAL error during grading, re-queueing all picks:', gradeErr.message);
        requeued = finished.map(p => ({ ...p, _pendingGrade: true }));
      }
    }
    return { fresh, requeued };
  }

  const { fresh: storedFreshPicks, requeued: gradeQueue } = await pruneAndGradeStoredPicks();

  if (shouldRunPicks) {
    if (isRecoveryAttempt) {
      console.log('[picks] RECOVERY mode: prior stories.json has 0 picks and we\'re still in the day window — retrying generation');
    } else {
      console.log('Generating picks (morning anchor / manual run)...');
    }
    try {
      const newPicks = await generatePicks();
      clustered.picks = newPicks.concat(gradeQueue);
      console.log('Picks: ' + newPicks.length + ' new, ' + gradeQueue.length + ' awaiting grade');
      // CRITICAL: generatePicks() can return an EMPTY array without throwing
      // (e.g. the AI stage found no edge, or odds came back thin). That is NOT
      // an error, so the catch below never fires — yet the board would still be
      // empty. So: whenever we have zero RENDERABLE picks, run the deterministic
      // market-fill from real bookmaker lines so every sport playing today gets
      // picks. This is the missing path that left the page blank for days.
      var renderableCount = clustered.picks.filter(function(p){ return !p._pendingGrade; }).length;
      if (renderableCount === 0) {
        console.log('[picks] generation returned 0 renderable picks — running market-fill fallback');
        try {
          const fills = await topUpMarketFills(clustered.picks);
          if (fills.length > 0) {
            clustered.picks = clustered.picks.concat(fills);
            console.log('[picks] market-fill produced ' + fills.length + ' real-line picks');
          } else {
            console.log('[picks] market-fill produced 0 (no games with lines in window today)');
          }
        } catch (eFill) {
          console.warn('[picks] market-fill fallback failed (non-fatal):', eFill.message);
        }
      }
    } catch (e) {
      // Picks generation is the most failure-prone stage (3 Claude calls + odds
      // + web searches). If it throws, DO NOT abort the whole run — keep the
      // picks already on disk so the page isn't blanked, and let the next
      // refresh retry. This is what kept freezing the entire site.
      console.error('[picks] generation FAILED, preserving existing picks and continuing:', e.message);
      clustered.picks = storedFreshPicks.concat(gradeQueue);
      // FALLBACK: generation died, but the sports playing today still deserve
      // picks. Build them deterministically from real bookmaker lines (no Claude
      // calls, same validity guarantees — real line + real near-future game).
      // This is what keeps the board populated on a day the AI stage fails,
      // instead of leaving it empty.
      try {
        const fillFallback = await topUpMarketFills(clustered.picks);
        if (fillFallback.length > 0) {
          clustered.picks = clustered.picks.concat(fillFallback);
          console.log('[picks] fallback market-fill after generation failure: +' + fillFallback.length + ' real-line picks');
        }
      } catch (e2) {
        console.warn('[picks] fallback market-fill also failed (non-fatal):', e2.message);
      }
    }
  } else {
    // Off-cycle run: keep the still-fresh picks already on disk so the site
    // doesn't go blank, plus anything waiting on an ESPN final.
    clustered.picks = storedFreshPicks.concat(gradeQueue);
    console.log('Skipped picks generation (off-cycle run); preserved ' + storedFreshPicks.length + ' non-stale picks, ' + gradeQueue.length + ' awaiting grade');

    // ─── OFF-CYCLE MARKET-FILL TOP-UP ──────────────────────────────────────────
    // The morning run can't fill a sport whose bookmaker lines aren't posted yet
    // at 7 AM ET (typical for MLB day games and afternoon slates). Without this,
    // those sports stay empty all day even after their lines appear. So on every
    // off-cycle refresh we re-fetch odds for the active leagues and top up any
    // sport sitting below 2 picks. Pure deterministic fills (low confidence,
    // real lines) — no Claude calls. Cost: the same odds fetch the page already
    // relies on, only for leagues that currently have a game starting soon.
    try {
      const topUps = await topUpMarketFills(clustered.picks);
      if (topUps.length > 0) {
        clustered.picks = clustered.picks.concat(topUps);
        console.log('[picks] off-cycle top-up: +' + topUps.length + ' market-fill picks for under-covered sports');
      }
    } catch (e) {
      console.warn('[picks] off-cycle top-up failed (non-fatal):', e.message);
    }
  }

  console.log('Fetching highlights...');
  try {
    const videoFeeds = await fetchHighlights();
    clustered.highlights = videoFeeds.highlights;
    clustered.reels = videoFeeds.reels;
    console.log('Highlights: ' + clustered.highlights?.length + ' | Reels: ' + clustered.reels?.length);
  } catch (e) {
    console.error('[main] highlights stage failed, continuing:', e.message);
  }

  // Live NFL draft — runs in parallel with rest. ESPN Core API, no CORS issues server-side.
  // Overrides the Claude-extracted news picks when available; those become the fallback.
  try {
    const liveDraft = await fetchNflDraftLive();
    if (liveDraft && liveDraft.picks.length > 0) {
      clustered.draftTracker = liveDraft;
      console.log('Draft tracker: using ESPN live feed (' + liveDraft.picks.length + ' picks)');
    } else if (clustered.draftTracker && clustered.draftTracker.active) {
      clustered.draftTracker.source = 'news';
      console.log('Draft tracker: ESPN unavailable, using news extraction (' + clustered.draftTracker.picks.length + ' picks)');
    }
  } catch (e) {
    console.error('[main] draft stage failed, continuing:', e.message);
  }

  writeFileSync('stories.json', JSON.stringify(clustered, null, 2));
  console.log('Written stories.json');
}

main().catch(err => {
  // A fatal error here means stories.json was NOT rewritten this run. Do NOT
  // exit non-zero: that aborts the workflow before the push/deploy step, which
  // would be fine (old file stays) EXCEPT it also marks the run failed and can
  // interrupt the schedule. Exit 0 so the workflow completes and simply
  // re-publishes the existing stories.json untouched. The next scheduled run
  // retries. This guarantees the site never goes dark from a transient error.
  console.error('FATAL (run produced no new stories.json; existing file preserved):', err && err.stack || err);
  process.exit(0);
});
