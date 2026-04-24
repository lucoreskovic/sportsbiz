import { writeFileSync } from 'fs';

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
];

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
          description: stripTags(i.description || '').slice(0, 200),
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
    ).slice(0, 200);
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
  // Interleave stories from ALL sources for even distribution
  const sourceGroups = {};
  for (const s of stories) {
    if (!sourceGroups[s.source]) sourceGroups[s.source] = [];
    if (sourceGroups[s.source].length < 5) sourceGroups[s.source].push(s);
  }
  const interleaved = [];
  for (let i = 0; i < 5; i++) {
    for (const src of Object.keys(sourceGroups)) {
      if (sourceGroups[src][i]) interleaved.push(sourceGroups[src][i]);
    }
  }
  const selected = interleaved.slice(0, 35);
  const list = selected.map((s, i) =>
    '[' + i + '] SOURCE:' + s.source + ' | ' + s.title + ' | ' + s.description
  ).join('\n');
  const srcList = [...new Set(selected.map(s=>s.source))].join(', ');

  const prompt = `You are a sports business columnist — the voice of The Athletic, Sportico, Pablo Torre Finds Out. Confident, specific, editorial. Stories from: ${srcList}.

## TASK 1 — CREATE 6-8 STORY CLUSTERS

Spread cluster leads across sources. No more than 2 leads from any single outlet (especially not Front Office Sports or Sportico).

For each cluster return:
- category: "media" | "contracts" | "leagues" | "revenue" | "labor"
- leadHeadline: exact title from a source story (copy verbatim)
- leadSource: exact source name from the [index] prefix + " · Xh ago"
- summary: 2 sentences, under 180 chars — tone guide applies
- article: 300-400 words — tone guide applies
- storyIndexes: [story indexes that belong in this cluster, from multiple sources when possible]
- posts: []

## TONE GUIDE (applies to every piece of prose you write)

Write like a columnist with 20 years on the beat, not a press-release intern.

DO:
- Open with the fact or the angle. No throat-clearing.
- Name names, cite numbers, contracts, dates, prior context.
- Deliver an analytical line: what this means, who wins, who loses, what comes next.
- Vary sentence rhythm — short punches alongside longer analytical sentences.
- Make claims you can defend. Don't hedge with "might" and "could" when a stronger verb works.
- Reference prior events where it adds weight ("This follows Goodell's October memo", "The third straight year a QB went No. 1").

NEVER use these clichés or patterns:
- "game-changer", "paradigm shift", "uncertain times", "pivotal moment", "new era", "watershed"
- "ushers in", "underscores", "highlights the", "the landscape", "the space"
- "In a recent development…", "In the world of sports…", "It remains to be seen…"
- Restating the headline verbatim in the first sentence
- Moralizing about what a league "needs" or "should do"
- Empty transition phrases: "That said", "Moving forward", "At the end of the day"

GOOD OPENING EXAMPLE (note the specificity and angle):
"The Raiders made Fernando Mendoza the first pick of Thursday's draft — the third straight year a quarterback opened the proceedings and the fourth of the past five. Mendoza's rookie deal will top $50 million fully guaranteed, a number the franchise hasn't committed to a quarterback since Derek Carr's 2022 extension. The pick closes the Minshew-era holding pattern and opens the most consequential offseason build of Antonio Pierce's tenure."

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

## TASK 3 — ALSO RETURN

- sidebar: 8 items from varied sources. Each: { headline, source, article }. Articles 150-220 words, tone guide applies.
- poll: { question, options: [exactly 4 option strings] }
- predictions: 4 items { statement, probability (0-100 integer), rationale (tone guide applies) }
- picks: []

## OUTPUT FORMAT

Return ONLY valid JSON. Top-level keys: clusters, draftTracker, sidebar, poll, predictions, picks, updatedAt.

Stories:
${list}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 14000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || ('API error ' + res.status));

  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) throw new Error('No JSON in response');

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end+1));
  } catch(e) {
    // Try recovery
    const safe = text.slice(start, text.lastIndexOf(',"picks"'));
    try { parsed = JSON.parse(safe + ',"picks":[],"updatedAt":"' + new Date().toISOString() + '"}'); }
    catch(e2) { throw new Error('JSON parse failed: ' + e.message); }
  }

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
    return {
      category:     c.category     || 'revenue',
      leadHeadline: c.leadHeadline || lead?.title || '',
      leadSource:   c.leadSource   || (lead?.source||'') + ' · ' + timeAgo(lead?.pubDate),
      leadUrl:      (lead?.link && lead.link.startsWith('http')) ? lead.link : '',
      summary:      c.summary      || '',
      article:      c.article      || '',
      posts:        [],
    };
  });

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

  parsed.picks = [];
  return parsed;
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
// This trades latency (~60-90s vs ~5s) for ground truth. The 2-hour cron can
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
  ];
  for (const lg of leagues) {
    try {
      const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + lg.urlPath + '/scoreboard', {signal:AbortSignal.timeout(6000)});
      if (!res.ok) continue;
      const d = await res.json();
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
    console.warn('[picks] no games returned from ESPN, skipping pick generation');
    return [];
  }

  const gamesList = games.join('\n');

  // ─── STAGE 1: SCOUT ────────────────────────────────────────────────────────
  // Pick 8-10 candidate games worth researching, plus a SPECIFIC question each.
  const scoutPrompt = `You are a professional sports handicapper. Today is ${today}.

Here are the real games scheduled today across major leagues:
${gamesList}

Select 8-10 CANDIDATE games where focused research might reveal betting value. Pick a MIX of sports (NBA, NFL, MLB, NHL, and especially soccer — EPL/La Liga/Bundesliga/Serie A/Ligue 1/UCL/MLS).

For each candidate, specify:
- The exact matchup (copy from the list)
- The league (use exact label from the list)
- The bet TYPE to evaluate (spread | moneyline | total | player_prop | first_half)
- A SPECIFIC, ANSWERABLE research question — something that could change the pick if answered.

GOOD research questions (specific, decision-altering):
- "Is Rudy Gobert playing tonight, and what's the Timberwolves' offensive rating without him?"
- "Has Juan Soto been batting leadoff or 3rd this series, and what's his OBP vs lefties?"
- "What's Lens's scoring average in away matches in 2026, and Brest's goals-allowed rate at home?"

BAD research questions (vague, can't be answered concretely):
- "Is this a good bet?"
- "Who has the edge?"
- "Will the Knicks cover?"

Return ONLY valid JSON:
{"candidates":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","question":"Specific researchable question"}]}`;

  let candidates = [];
  try {
    console.log('[picks] stage 1/3: scouting candidates...');
    const scoutRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
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
          max_tokens: 8000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 20 }],
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
  // Only candidates whose research revealed genuine edge should appear.
  const ctx = researchBriefings
    ? `RESEARCH BRIEFINGS (web-verified facts from searches just performed):\n\n${researchBriefings}\n\nORIGINAL SCHEDULE:\n${gamesList}`
    : `Real upcoming games from ESPN:\n${gamesList}`;

  const finalPrompt = `You are a sharp sports bettor. Today is ${today}.\n\n${ctx}\n\n` +
`Produce 5-8 final picks. CRITICAL selection rules:\n` +
`• Only include a pick if the research reveals GENUINE EDGE — if a candidate's research said "NO EDGE" or contradicted the premise, DROP IT, don't force a pick.\n` +
`• Quality over quantity: 5 well-researched picks > 8 speculative ones. If you have only 4 high-confidence plays, return 4.\n` +
`• Include a MIX of bet types: spread, moneyline, total, player_prop, first_half.\n` +
`• Spread sport coverage across US leagues AND soccer — NBA, NFL, MLB, NHL, EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, MLS.\n\n` +
`EDGE FIELD FORMAT: state the verified research insight that justifies the pick. Use concrete numbers and sources when available. Avoid generic fluff. Example:\n` +
`  "Gobert ruled OUT (Woj). Timberwolves' defensive rating drops from 3rd to 19th without him. Thunder average 8.2 PPG higher when opponents miss their starting C this season. Value on Thunder -6.5 at this number."\n\n` +
`TIME FORMAT: "when" field MUST be "Today H:MM PM ET" or "Tomorrow H:MM PM ET".\n\n` +
`TYPE FIELD: exactly one of: "spread" | "moneyline" | "total" | "player_prop" | "first_half".\n\n` +
`PICK FIELD format by type:\n` +
`  spread      → "Team +/-X.X"         e.g. "Knicks -5.5", "Arsenal -0.5"\n` +
`  moneyline   → "Team ML"             e.g. "Thunder ML", "Man City ML"\n` +
`  total       → "Over/Under X.X"      e.g. "Under 8.5", "Over 2.5 goals"\n` +
`  player_prop → "Player O/U X.X Stat" e.g. "Jalen Brunson Over 28.5 Points"\n` +
`  first_half  → "Team +/-X.X (1H)"    e.g. "Celtics -3.5 (1H)"\n\n` +
`CONFIDENCE: "high" only for picks where research revealed multiple confirming facts. "medium" for one solid fact. "low" should be rare — if low, probably just drop the pick.\n\n` +
`LEAGUE FIELD: use one of these exact values — NBA, NFL, MLB, NHL, EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, MLS.\n\n` +
`Return ONLY valid JSON:\n` +
`{"picks":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","pick":"Team +4.5","odds":"-110","edge":"Research-backed reason with specific numbers and source","confidence":"high|medium|low"}]}`;

  console.log('[picks] stage 3/3: finalizing picks...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model:'claude-haiku-4-5-20251001',
      max_tokens: 3000,
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
    const finalPicks = raw.map(p => {
      const t = String(p.type||'').toLowerCase().replace(/\s+/g,'_').replace(/prop$/,'player_prop');
      return { ...p, type: validTypes.has(t) ? t : 'spread' };
    });
    console.log('[picks] stage 3/3: finalized ' + finalPicks.length + ' picks');
    return finalPicks;
  }
  catch(e) { return []; }
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
    // First <entry> is the newest upload. Extract videoId, title, published.
    const entryMatch = /<entry>([\s\S]*?)<\/entry>/.exec(xml);
    if (!entryMatch) return null;
    const body = entryMatch[1];
    const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(body) || [])[1] || '';
    const title   = (/<title>([\s\S]*?)<\/title>/.exec(body) || [])[1] || '';
    const pub     = (/<published>([^<]+)<\/published>/.exec(body) || [])[1] || '';
    if (!videoId) return null;
    return { videoId, title: title.trim(), pubDate: pub };
  }

  const results = [];
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
        item = parseYoutubeXml(xml);
        if (item) console.log('Highlight DIRECT ' + ch.name + ': ' + item.videoId);
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
    } else {
      console.warn('Highlight ' + ch.name + ' — no video from either source');
    }
  }
  return results;
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

async function main() {
  console.log('Fetching RSS feeds...');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = dedup(results.flat());
  console.log('Total stories: ' + all.length);
  if (all.length < 3) { console.error('Too few stories'); process.exit(1); }

  console.log('Clustering...');
  const clustered = await cluster(all);
  console.log('Clusters: ' + clustered.clusters?.length);

  console.log('Generating picks...');
  clustered.picks = await generatePicks();
  console.log('Picks: ' + clustered.picks?.length);

  console.log('Fetching highlights...');
  clustered.highlights = await fetchHighlights();
  console.log('Highlights: ' + clustered.highlights?.length);

  // Live NFL draft — runs in parallel with rest. ESPN Core API, no CORS issues server-side.
  // Overrides the Claude-extracted news picks when available; those become the fallback.
  const liveDraft = await fetchNflDraftLive();
  if (liveDraft && liveDraft.picks.length > 0) {
    clustered.draftTracker = liveDraft;
    console.log('Draft tracker: using ESPN live feed (' + liveDraft.picks.length + ' picks)');
  } else if (clustered.draftTracker && clustered.draftTracker.active) {
    clustered.draftTracker.source = 'news';
    console.log('Draft tracker: ESPN unavailable, using news extraction (' + clustered.draftTracker.picks.length + ' picks)');
  }

  writeFileSync('stories.json', JSON.stringify(clustered, null, 2));
  console.log('Written stories.json');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
