// generate.js
// Run by GitHub Actions every 2 hours.
// Fetches RSS feeds, filters for business stories,
// clusters with one AI call, writes stories.json.

import { writeFileSync } from 'fs';

// Using RSS2JSON.com free API to reliably fetch feeds from many sources
const FEEDS = [
  { url: 'https://frontofficesports.com/feed/',                     source: 'Front Office Sports'  },
  { url: 'https://sportico.com/feed/',                              source: 'Sportico'             },
  { url: 'https://nypost.com/sports/feed/',                         source: 'NY Post Sports'       },
  { url: 'https://www.theguardian.com/sport/rss',                   source: 'The Guardian'         },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml', source: 'NY Times Sports'      },
  { url: 'https://feeds.bbci.co.uk/sport/rss.xml',                  source: 'BBC Sport'            },
  { url: 'https://bleacherreport.com/articles/feed',                source: 'Bleacher Report'      },
  { url: 'https://www.si.com/rss/si_top_stories.rss',               source: 'Sports Illustrated'   },
  { url: 'https://www.sportingnews.com/us/rss.xml',                 source: 'Sporting News'        },
  { url: 'https://www.sportsnet.ca/feed/',                          source: 'Sportsnet'            },
  { url: 'https://www.tsn.ca/rss/tsn-top-stories',                  source: 'TSN'                  },
];

const BIZ_KEYWORDS = [
  // Financial terms
  'deal','contract','billion','million','revenue','rights','broadcast',
  'media','streaming','sponsor','naming rights','salary','cap','expansion',
  'franchise','valuation','investment','private equity','stadium','arena',
  'ticket','gambling','betting','cba','labor','collective bargaining',
  'ownership','sale','acquire','merger','partnership','commissioner',
  'extension','buyout','equity','fund','ipo','profit','loss','earnings',
  'fee','penalty','fine',
  // Broader business terms that other sources use
  'trade','signing','free agent','draft pick','pay','market','league',
  'team','owner','agent','roster','budget','payroll','negotiate',
  'television','tv rights','broadcast deal','media rights','streaming deal',
  'lawsuit','settlement','antitrust','collective','union','escrow',
  'relocation','expansion team','new arena','new stadium','renovation',
  'rating','audience','viewership','sponsor deal','endorsement',
];

// ── RSS helpers ──────────────────────────────────────────────────────────

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#\d+;/g,'')
    .trim();
}

function parseField(xml, tag) {
  const cd = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cd) return stripTags(cd[1]);
  const pl = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return pl ? stripTags(pl[1]) : '';
}

function parseRSS(xml, sourceName) {
  const items = [];
  const rx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const b     = m[1];
    const title = parseField(b, 'title');
    const desc  = parseField(b, 'description');
    const date  = parseField(b, 'pubDate') || parseField(b, 'dc:date');

    // Try multiple URL sources in order of reliability
    let link = '';
    // 1. <link> tag (most common)
    const linkTag = /<link>([^<]+)<\/link>/i.exec(b);
    if (linkTag) link = linkTag[1].trim();
    // 2. CDATA link
    if (!link) { const cd = /<link><!\[CDATA\[([^\]]+)\]\]><\/link>/i.exec(b); if (cd) link = cd[1].trim(); }
    // 3. guid as URL
    if (!link) { const guid = /<guid[^>]*>([^<]+)<\/guid>/i.exec(b); if (guid && guid[1].startsWith('http')) link = guid[1].trim(); }
    // 4. feedburner:origLink
    if (!link) { const fb = /<feedburner:origLink>([^<]+)<\/feedburner:origLink>/i.exec(b); if (fb) link = fb[1].trim(); }
    // 5. atom:link href
    if (!link) { const al = /<atom:link[^>]+href="([^"]+)"/i.exec(b); if (al) link = al[1].trim(); }

    if (title && title.length > 10) {
      items.push({ title, link, description: desc, pubDate: date, source: sourceName });
    }
  }
  return items;
}

async function fetchFeed(feed) {
  // Try direct fetch first
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SportsBizNow/1.0)' },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseRSS(await res.text(), feed.source);
    if (items.length > 0) {
      console.log(`OK [${items.length} items] ${feed.source}`);
      return items;
    }
    throw new Error('Empty RSS');
  } catch (e) {
    // Fallback: try RSS2JSON free API
    try {
      const r2j = await fetch(
        `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}&count=20`,
        { signal: AbortSignal.timeout(8000) }
      );
      const data = await r2j.json();
      if (data.status === 'ok' && data.items && data.items.length > 0) {
        const items = data.items.map(item => ({
          title: item.title || '',
          link: item.link || '',
          description: item.description ? item.description.replace(/<[^>]*>/g,'').slice(0,200) : '',
          pubDate: item.pubDate || '',
          source: feed.source,
        })).filter(i => i.title && i.title.length > 10);
        console.log(`OK via RSS2JSON [${items.length} items] ${feed.source}`);
        return items;
      }
      throw new Error('RSS2JSON empty');
    } catch (e2) {
      console.warn(`FAIL ${feed.source}: ${e.message} | rss2json: ${e2.message}`);
      return [];
    }
  }
}

function isBiz(story) {
  // Pass all stories through - AI will filter for business relevance
  // Only exclude obvious non-sports content
  const text = (story.title + ' ' + story.description).toLowerCase();
  const exclude = ['recipe','fashion','beauty','celebrity','horoscope','crossword','travel'];
  return !exclude.some(kw => text.includes(kw));
}

function dedup(stories) {
  const seen = new Set();
  return stories.filter(s => {
    const k = s.title.toLowerCase().replace(/[^a-z0-9 ]/g,'').slice(0,60).trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return 'recently';
  const d    = new Date(dateStr);
  if (isNaN(d)) return 'recently';
  const h    = Math.round((Date.now() - d.getTime()) / 3600000);
  if (h < 1)  return 'Just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h/24)}d ago`;
}

// ── AI clustering ────────────────────────────────────────────────────────

async function cluster(stories) {
  const list = stories.slice(0, 25).map((s, i) =>
    `[${i}] SOURCE: ${s.source} | URL: ${s.link} | TITLE: ${s.title} | DESC: ${(s.description||'').slice(0,120)}`
  ).join('\n');

  const prompt = `You are a sports business news editor. Group these ${Math.min(stories.length,40)} RSS stories into 6-8 clusters of related stories. Focus only on business angles: media rights, contracts, salaries, expansion, sponsorship, stadium deals, valuations, gambling, ownership, labor/CBA. Ignore pure game results unless they have clear business implications. IMPORTANT: Order the clusters by importance and reach — the first cluster should be the story with the most sources covering it, the biggest dollar figures, or the widest industry impact. The last cluster should be the least significant. Think of it like a newspaper front page — lead with what matters most.

For each cluster:
- category: one of "media", "contracts", "leagues", "revenue", "labor"
- leadHeadline: clear specific headline under 90 chars
- leadSource: source name + time (e.g. "Front Office Sports · 3h ago")
- leadUrl: URL of lead story
- summary: 2 sentences on business significance, under 200 chars
- article: a 120-150 word original article in sharp sports business journalism style. Cover the who, what, why it matters financially, and what to watch. No fluff, concrete facts only.
- storyIndexes: array of story index numbers in this cluster
- posts: 2-3 real social media posts from X or Bluesky reacting to this topic. Each: { platform: "x" or "bluesky", name, handle, content, time, url }. Only include real posts you find — leave empty array if none found. Never invent posts.

Also return sidebar: 6-8 quick-hit items (minor stories or ones that don't fit a cluster). Each: { headline, source, url, article: "60-80 word summary of this story for inline reading" }

Also return poll: a single timely poll based on the biggest story or theme in today's news. Format: { question: "...", options: ["...", "...", "...", "..."] }. The question should be opinionated and engaging. Options should be 3-4 short distinct answers.

Also return predictions: an array of 4-5 sports business predictions grounded in current news. Each prediction should have a specific outcome, a probability percentage (0-100) based on current evidence, and a one-line rationale. Format: [ { statement: "NFL adopts 18-game season by 2027", probability: 72, rationale: "Owners approved framework; player pushback remains only hurdle" }, ... ]

Return ONLY raw JSON, no markdown, no explanation:
{
  "clusters": [...],
  "sidebar": [...],
  "updatedAt": "${new Date().toISOString()}",
  "poll": { "question": "...", "options": ["...", "..."] },
  "predictions": [ { "statement": "...", "probability": 70, "rationale": "..." } ],
}

Stories:
${list}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);

  const text  = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) throw new Error('No JSON in AI response:\n' + text.slice(0,300));

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end+1));
  } catch(e) {
    // Try to recover truncated JSON by finding last complete cluster
    console.warn('JSON parse failed, attempting recovery...');
    const partial = text.slice(start);
    const lastCluster = partial.lastIndexOf('{"category"');
    if (lastCluster > 0) {
      // Find a safe truncation point before the last incomplete cluster
      const safe = partial.slice(0, lastCluster);
      const fixedJson = safe.replace(/,\s*$/, '') + ']}';
      try {
        const recovered = JSON.parse('{"clusters":' + fixedJson.slice(fixedJson.indexOf('[')) + ',"sidebar":[],"updatedAt":"' + new Date().toISOString() + '"}');
        parsed = recovered;
        console.log('JSON recovery succeeded with', parsed.clusters?.length, 'clusters');
      } catch(e2) {
        throw new Error('JSON parse failed and recovery failed: ' + e.message);
      }
    } else {
      throw new Error('JSON parse failed: ' + e.message);
    }
  }

  // Hydrate URLs from source list
  parsed.clusters = (parsed.clusters||[]).map(c => {
    const idx  = (c.storyIndexes||[])[0];
    const lead = stories[idx];
    // ALWAYS use the RSS link from the source story — it is the actual article URL
    // Never trust the AI-generated leadUrl as it may hallucinate URLs
    const url = (lead?.link && lead.link.startsWith('http')) ? lead.link : '';
    return {
      category:     c.category     || 'revenue',
      leadHeadline: c.leadHeadline || lead?.title || '',
      leadSource:   c.leadSource   || `${lead?.source||''} · ${timeAgo(lead?.pubDate)}`,
      leadUrl:      url,
      summary:      c.summary      || '',
      article:      c.article      || '',
      posts:        Array.isArray(c.posts) ? c.posts.filter(p => p && p.content) : [],
    };
  });

  // Ensure poll is valid
  if (!parsed.poll || !parsed.poll.question || !Array.isArray(parsed.poll.options)) {
    parsed.poll = {
      question: 'Which sports business story will have the biggest impact this week?',
      options: (parsed.clusters||[]).slice(0,4).map(cl => cl.leadHeadline.slice(0,60))
    };
  }

  // Ensure predictions are valid
  if (!Array.isArray(parsed.predictions) || parsed.predictions.length === 0) {
    parsed.predictions = [];
  }
  parsed.predictions = parsed.predictions.filter(p => p && p.statement && typeof p.probability === 'number');

  return parsed;
}

// ── YouTube highlights fetcher ───────────────────────────────────────────

// ── Highlights: static curated + ESPN video search ──────────────────────
// We use a guaranteed set of search queries that always produce results
// The frontend embeds them via YouTube's search embed (no API key needed)

async function fetchHighlights() {
  // These search queries always have fresh results — YouTube search embed
  // handles finding the most recent matching videos
  const searches = [
    { league: 'NBA',  query: 'NBA playoffs highlights 2026',       icon: '🏀' },
    { league: 'MLB',  query: 'MLB highlights today 2026',          icon: '⚾' },
    { league: 'NHL',  query: 'NHL playoffs highlights 2026',       icon: '🏒' },
    { league: 'NFL',  query: 'NFL news highlights 2026',           icon: '🏈' },
    { league: 'WNBA', query: 'WNBA highlights 2026',               icon: '🏀' },
    { league: 'MLS',  query: 'MLS soccer highlights this week',    icon: '⚽' },
  ];

  // Try to get real video IDs from YouTube RSS first
  const CHANNELS = [
    { name: 'NBA',  id: 'UCWJ2lWNubArHWmf3FIHbfcQ' },
    { name: 'MLB',  id: 'UCzWQYUVCpZqtN93H8RR44Qw' },
    { name: 'NHL',  id: 'UCqFCMJ17JCBqjR8_9yx9wqg' },
    { name: 'NFL',  id: 'UCDVYQ4Zhbm3S2dlz7P1GBDg' },
    { name: 'ESPN', id: 'UCiWLfSweyRNmLpgEHekhoAg' },
  ];

  const realVideos = [];
  for (const ch of CHANNELS) {
    try {
      const res = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) { console.warn(`${ch.name} RSS: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const vidMatch = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(xml);
      const titleMatch = /<title>([^<]+)<\/title>/.exec(xml.slice(xml.indexOf('<entry>')));
      const pubMatch = /<published>([^<]+)<\/published>/.exec(xml);
      if (vidMatch) {
        const vid = vidMatch[1].trim();
        const title = titleMatch ? titleMatch[1].replace(/&amp;/g,'&').trim() : ch.name + ' Latest Highlights';
        const published = pubMatch ? new Date(pubMatch[1]) : new Date();
        const h = Math.round((Date.now() - published.getTime()) / 3600000);
        const timeAgo = h < 24 ? h + 'h ago' : Math.round(h/24) + 'd ago';
        realVideos.push({ league: ch.name, title, videoId: vid, thumbnail: `https://img.youtube.com/vi/${vid}/mqdefault.jpg`, timeAgo, isFallback: false });
        console.log(`Got real video for ${ch.name}: ${vid}`);
      }
    } catch(e) { console.warn(`${ch.name} RSS failed:`, e.message); }
  }

  if (realVideos.length >= 4) {
    console.log(`Using ${realVideos.length} real YouTube videos`);
    return realVideos;
  }

  // Fallback: use search-based embeds — always works, always has content
  console.log(`Only ${realVideos.length} real videos found, using search embeds for the rest`);
  const result = [...realVideos];
  const usedLeagues = new Set(realVideos.map(v => v.league));
  for (const s of searches) {
    if (usedLeagues.has(s.league)) continue;
    result.push({
      league:    s.league,
      title:     'Latest ' + s.league + ' Highlights',
      videoId:   '',
      searchQuery: s.query,
      thumbnail: '',
      timeAgo:   'Latest',
      isFallback: true,
    });
    if (result.length >= 6) break;
  }
  return result;
}

// ── Separate picks generation ────────────────────────────────────────────

async function fetchEspnGames() {
  const leagues = [
    { id: 'nba',  sport: 'basketball', name: 'NBA'  },
    { id: 'mlb',  sport: 'baseball',   name: 'MLB'  },
    { id: 'nhl',  sport: 'hockey',     name: 'NHL'  },
    { id: 'nfl',  sport: 'football',   name: 'NFL'  },
    { id: 'mls',  sport: 'soccer',     name: 'MLS'  },
  ];
  const games = [];
  for (const lg of leagues) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${lg.sport}/${lg.id}/scoreboard`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || []).slice(0, 6)) {
        const comp   = ev.competitions?.[0];
        const teams  = comp?.competitors || [];
        const home   = teams.find(t => t.homeAway === 'home') || teams[0];
        const away   = teams.find(t => t.homeAway === 'away') || teams[1];
        const status = ev.status?.type?.name || '';
        if (status === 'STATUS_FINAL') continue; // skip finished games
        const gametime = new Date(ev.date).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}) + ' ET';
        const homeName = home?.team?.displayName || '';
        const awayName = away?.team?.displayName || '';
        const homeRecord = home?.records?.[0]?.summary || '';
        const awayRecord = away?.records?.[0]?.summary || '';
        games.push(`${lg.name}: ${awayName} (${awayRecord}) @ ${homeName} (${homeRecord}) — ${gametime}`);
      }
    } catch(e) { console.warn(`ESPN ${lg.id} failed:`, e.message); }
  }
  return games;
}

async function generatePicks() {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  console.log('Fetching ESPN games for picks...');
  const games = await fetchEspnGames();
  console.log(`ESPN games found: ${games.length}`);

  const gameContext = games.length > 0
    ? `REAL GAMES FROM ESPN TODAY:\n${games.join('\n')}`
    : `Use your knowledge of today's sports schedule (${today}).`;

    const prompt = `You are a professional sports handicapper with 20 years experience. Today is ${today}.

${gameContext}

For each game, analyze:
1. Injury report - who is OUT or QUESTIONABLE and how does it affect the line
2. Rest advantage - back-to-backs, travel, days of rest
3. Recent ATS record - last 5-10 games against the spread
4. Home/away splits - how each team performs at home vs road
5. Motivation - playoff positioning, elimination games, revenge spots
6. Line value - is the spread too high or too low given the situation

Pick 3-4 games where you have a CLEAR edge from the above factors. Be very specific - name actual players who are hurt, cite actual records. If you are not confident, do not pick that game.

Return ONLY raw JSON:
{
  "picks": [
    {
      "matchup": "Away Team @ Home Team",
      "league": "NBA",
      "when": "Today 7:30 PM ET",
      "pick": "Away Team +5.5",
      "odds": "-110",
      "edge": "Specific verifiable edge: Home team missing Embiid (knee, out), Away team 8-2 ATS last 10 as road dog, Back-to-back for home team",
      "confidence": "high"
    }
  ]
}

confidence = high (strong edge, multiple factors), medium (1-2 factors), low (slight lean). Return exactly 3-4 picks. Never return empty.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.warn('Picks API error:', data.error?.message); return []; }
  const text  = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  console.log('Picks raw response:', text.slice(0,300));
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) { console.warn('No JSON in picks response'); return []; }
  try {
    const parsed = JSON.parse(text.slice(start, end+1));
    return (parsed.picks||[]).filter(p => p && p.matchup && p.pick);
  } catch(e) { console.warn('Picks parse error:', e.message); console.warn('Raw picks text:', text.slice(0,500)); return []; }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching RSS feeds...');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all     = results.flat();
  console.log(`Raw stories: ${all.length}`);

  const biz = dedup(all.filter(isBiz));
  console.log(`After biz filter + dedup: ${biz.length}`);
  // Log first 3 URLs to debug link quality
  biz.slice(0,3).forEach((s,i) => console.log(`Story ${i} URL: ${s.link} (${s.source})`));

  if (biz.length < 3) {
    console.error('Too few stories found — aborting to avoid overwriting good cache');
    process.exit(1);
  }

  console.log('Clustering with AI...');
  const clustered = await cluster(biz);
  console.log(`Clusters: ${clustered.clusters?.length}, Sidebar: ${clustered.sidebar?.length}`);

  console.log('Generating picks...');
  clustered.picks = await generatePicks();
  console.log(`Picks: ${clustered.picks.length}`);

  writeFileSync('stories.json', JSON.stringify(clustered, null, 2));
  console.log('Written to stories.json ✓');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
