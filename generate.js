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
  // Cap at 22 stories. Lower = better fit within 50K input tokens/min rate limit.
  // Higher = more variety. 22 with truncated descriptions is the sweet spot.
  const selected = interleaved.slice(0, 22);
  const list = selected.map((s, i) =>
    // Truncate descriptions to 140 chars — preserves the headline meaning while
    // halving the token footprint. Full descriptions weren't adding clustering
    // value over titles + first sentence anyway.
    '[' + i + '] SOURCE:' + s.source + ' | ' + s.title + ' | ' + (s.description||'').slice(0, 140)
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
- posts: [] (real X posts are attached separately after clustering — leave empty here)

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

## TASK 5 — ALSO RETURN

- sidebar: 8 items from varied sources. Each: { headline, source, article }. Articles 150-220 words, tone guide applies.
- poll: { question, options: [exactly 4 option strings] }
- predictions: 4 items { statement, probability (0-100 integer), rationale (tone guide applies) }
- picks: []

## OUTPUT FORMAT

Return ONLY valid JSON. Top-level keys: clusters, draftTracker, deals, ratings, sidebar, poll, predictions, picks, updatedAt.

Stories:
${list}`;

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
        max_tokens: 14000,
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
      tweets:       [], // populated by attachRealTweets() after clustering
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
async function fetchTweetOEmbed(tweetUrl) {
  try {
    // Normalize x.com to twitter.com — oEmbed still routes through twitter.com
    const normalized = tweetUrl.replace(/^https?:\/\/x\.com\//, 'https://twitter.com/');
    const oembedUrl = 'https://publish.twitter.com/oembed?url=' +
      encodeURIComponent(normalized) +
      '&omit_script=true&dnt=true&theme=dark&align=left&hide_thread=true';
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.html || !data.author_name) return null;
    return {
      url:         normalized,
      html:        data.html,
      author_name: data.author_name,
      author_url:  data.author_url || '',
    };
  } catch (e) {
    return null;
  }
}

async function attachRealTweets(clusters) {
  if (!Array.isArray(clusters) || clusters.length === 0) return;

  // Single Claude call with web_search enabled: given all cluster headlines,
  // return a mapping of cluster index -> tweet URLs Claude confidently found
  // discussing that specific story. This is cheaper than N calls and lets
  // Claude prioritize searches across the whole slate.
  const headlineList = clusters
    .map((c, i) => '[' + i + '] ' + c.leadHeadline)
    .join('\n');

  const prompt = `You are attaching real public tweets (X posts) to news stories. For each headline below, use the web_search tool to find REAL tweets from beat reporters, insiders, verified accounts, or high-engagement fan reactions discussing that specific story. Search for phrases from the headline combined with "site:twitter.com OR site:x.com".

HARD RULES:
- Return ONLY tweet URLs you actually saw in search results. If a search returned no tweet URLs, return an empty array for that headline. Do NOT fabricate URLs.
- A valid tweet URL looks like: https://twitter.com/username/status/1234567890 or https://x.com/username/status/1234567890
- Skip promotional/spam tweets. Prefer beat reporters, team accounts, verified insiders.
- 0-3 tweets per headline. Quality > quantity. An empty array is a correct answer when nothing credible surfaces.
- It's fine if most headlines have no matching tweets — that's expected.

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
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 15 }],
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

  // Group resolved tweets back onto clusters
  for (const r of results) {
    if (!r.result) continue;
    const cl = clusters[r.clusterIdx];
    if (!cl) continue;
    if (!Array.isArray(cl.tweets)) cl.tweets = [];
    cl.tweets.push(r.result);
  }

  const totalAttached = clusters.reduce((n, c) => n + (c.tweets?.length || 0), 0);
  const clustersWithTweets = clusters.filter(c => (c.tweets?.length || 0) > 0).length;
  console.log('[tweets] attached ' + totalAttached + ' real tweets across ' + clustersWithTweets + ' clusters');
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
function signed(n) { const v = Number(n); return (v > 0 ? '+' : '') + v; }

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
    // Map our internal labels to The Odds API's sport keys.
    const oddsSportKeys = {
      'NBA':        'basketball_nba',
      'NFL':        'americanfootball_nfl',
      'MLB':        'baseball_mlb',
      'NHL':        'icehockey_nhl',
      'EPL':        'soccer_epl',
      'LA LIGA':    'soccer_spain_la_liga',
      'BUNDESLIGA': 'soccer_germany_bundesliga',
      'SERIE A':    'soccer_italy_serie_a',
      'LIGUE 1':    'soccer_france_ligue_one',
      'UCL':        'soccer_uefa_champs_league',
      'MLS':        'soccer_usa_mls',
    };
    // Identify which leagues actually have games on the schedule today.
    const leaguesWithGames = new Set();
    games.forEach(g => {
      const m = g.match(/^([A-Z][A-Z0-9 ]+):/);
      if (m && oddsSportKeys[m[1].trim()]) leaguesWithGames.add(m[1].trim());
    });
    console.log('[picks] stage 0: fetching real odds for ' + leaguesWithGames.size + ' leagues...');
    for (const league of leaguesWithGames) {
      const sportKey = oddsSportKeys[league];
      const url = 'https://api.the-odds-api.com/v4/sports/' + sportKey +
        '/odds?apiKey=' + ODDS_API_KEY +
        '&regions=us&markets=h2h,spreads,totals&oddsFormat=american';
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { console.warn('[picks] odds fetch failed for ' + league + ': HTTP ' + r.status); continue; }
        const remaining = r.headers.get('x-requests-remaining');
        const data = await r.json();
        if (!Array.isArray(data)) continue;
        // Each event: { home_team, away_team, commence_time, bookmakers: [{ markets: [{ key, outcomes }] }] }
        for (const ev of data) {
          // Build matchup key matching how we pass games to Claude
          const key = (ev.away_team + ' @ ' + ev.home_team).toLowerCase().replace(/\s+/g,' ').trim();
          oddsByGame[key] = consolidateBestLines(ev, league);
        }
        console.log('[picks] ' + league + ': ' + data.length + ' games priced (credits remaining: ' + remaining + ')');
      } catch (e) {
        console.warn('[picks] odds fetch error for ' + league + ':', e.message);
      }
    }
    console.log('[picks] stage 0: priced ' + Object.keys(oddsByGame).length + ' total games');
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

Select 5-8 CANDIDATE games where you suspect REAL edge might exist. Quality over quantity. Most days have few real edges; do not pad the list.

WHAT MAKES A GAME WORTH RESEARCHING (any one is enough):
• A key player has injury news that may not be priced in yet
• A clear scheduling spot (back-to-back, long road trip, lookahead spot before a marquee game)
• A significant lineup/rotation change reported recently
• A statistical mismatch you can plausibly verify (e.g., elite shutdown defense vs offense in scoring slump)
• A weather/venue factor (outdoor sports)
• Recent coaching change or system shift
• Sharp line movement or reverse line movement reported

DO NOT pick candidates just to fill quota. If only 3 games look interesting, return 3.

DO NOT use "balanced sport coverage" as a reason to include a candidate. If today has zero interesting NHL games, skip NHL. The downstream picks are scored on hit rate, not breadth.

For each candidate, specify:
- The exact matchup (copy from the list)
- The league (use exact label from the list)
- The bet TYPE to evaluate (spread | moneyline | total | player_prop | first_half)
- A SPECIFIC, ANSWERABLE research question — something that could change the pick if answered.

GOOD research questions (specific, decision-altering):
- "Is Rudy Gobert playing tonight, and what's the Timberwolves' offensive rating without him in 2026?"
- "Did the Astros formally announce their rotation for this series? Is the matchup confirmed?"
- "What's Lens's scoring average in away matches in 2026, and Brest's goals-allowed rate at home?"
- "Is Rodri back in Man City's XI, and what's their xG differential in matches he starts?"

BAD research questions (vague, can't be answered concretely):
- "Is this a good bet?"
- "Who has the edge?"
- "Will the Knicks cover?"

Return ONLY valid JSON:
{"candidates":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","question":"Specific researchable question"}]}

Empty array is acceptable: {"candidates":[]}`;

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
  // Default posture: ZERO PICKS unless something genuinely stands out.
  // The goal is hit rate, not pick volume.
  const hasResearch = !!researchBriefings;
  const ctx = hasResearch
    ? `RESEARCH BRIEFINGS (web-verified facts from searches just performed):\n\n${researchBriefings}\n\nSCHEDULE WITH REAL BOOKMAKER LINES (line-shopped across US books):\n${gamesListWithOdds}`
    : `Real upcoming games WITH live bookmaker lines (line-shopped across US books):\n${gamesListWithOdds}`;

  const finalPrompt = `You are a professional sports handicapper. Today is ${today}.

${ctx}

YOUR JOB: FIND THE BEST EDGES, NOT TO PICK EVERY GAME.

Sportsbooks operate at razor-thin margins. The goal is to find the games where genuine edge exists — not to fill a quota across every sport.

On a typical day with a full sports schedule (30+ games across leagues), there are usually 2-5 spots that meet the bar. Some days fewer; rarely zero. If you've gone through every research briefing and found zero defensible edges, returning [] is correct. But if you find 2-3 spots where the math genuinely works, return them — don't artificially withhold.

Calibration check: if you're returning 0 picks on a day with NBA playoffs, full MLB slate, and NHL postseason, you're being too cautious. If you're returning 6+, you're not being selective enough. The sweet spot is usually 2-4.

The mathematical reality:
• -110 vig means you need 52.4% just to break even
• Most "looks like value" plays are 50/50 in disguise
• A 3-1 day is irrelevant if the 1 loss outweighs the 3 wins in size
• Adding low-conviction picks to "smooth out the day" GUARANTEES negative ROI long-term

═══════════════════════════════════════════════════════════════
SELECTION CRITERIA — A pick must clear ALL THREE bars:
═══════════════════════════════════════════════════════════════

BAR 1 — TWO INDEPENDENT EDGES
A pick needs TWO separate, verifiable factors pointing the same direction. Not just "team is hot" — that's one factor and it's already priced in. Acceptable edge factors include:
  - Confirmed injury/scratch with quantified replacement-level dropoff
  - Quantified situational spot (back-to-back, travel, rest disparity ≥ 2 days)
  - Significant lineup/rotation change reported by beat writer
  - Statistical mismatch with verified per-game numbers (e.g., team allows 8.4 hits/game, opposing pitcher whiffs 11/9)
  - Public-money fade with sharp money on the other side (only if explicitly reported)
  - Weather (outdoor sports only) with quantified historical impact
  - Known coaching tendency in this exact spot type
  
NOT edges (these are noise):
  - "Team is on a hot streak" — already priced
  - "Better record" — already priced
  - "Home field advantage" — already priced
  - "Recent head-to-head" — small sample, already priced

BAR 2 — QUANTIFIED EDGE VS. THE ACTUAL MARKET LINE
The market line is shown above in the schedule for every game. Use that exact number — do not estimate where the line probably is. Your edge field MUST state:
  1. The MODEL line you think is fair (your honest estimate of true probability)
  2. The MARKET line shown in the input (verbatim, including which book is best)
  3. The GAP between them in points (spreads/totals) or implied probability (moneylines)

Required minimum thresholds — drop the pick if not met:
  - Spreads: model line vs market line gap ≥ 1.0 points
  - Totals:  model total vs market total gap ≥ 1.0 points
  - Moneylines: model probability vs market implied probability gap ≥ 4 percentage points
  - Player props: player's recent-form average vs line gap ≥ 15% of the line

Format examples (the structure is mandatory):
  Spread:    "Model line: Nuggets -10. Market: Nuggets -7.5 (DraftKings). Gap: 2.5 pts."
  Moneyline: "Fair price: -180 (64.3% win prob). Market best: -135 (57.4%) at FanDuel. Gap: 6.9 pts of probability."
  Total:     "Model total: 218. Market: 224.5 (BetMGM). Gap: 6.5 points (UNDER side)."
  Prop:      "Brunson averaged 28.4 over last 8 games. Line: 24.5 at DraftKings. Gap: 3.9 pts (16% over line)."

If your model line and the market line are within the threshold, this is NOT a value pick — drop it. The point of comparing to the real number is to enforce honesty about whether edge actually exists.

BAR 3 — RESEARCH CONFIRMED, NOT JUST PLAUSIBLE
The research briefing must contain SPECIFIC FACTS supporting the pick. If the briefing said "NO EDGE" or "MODERATE" without strong corroboration, drop the pick. "Plausible" is not "edge."

═══════════════════════════════════════════════════════════════
HARD LIMITS
═══════════════════════════════════════════════════════════════

• MAX 4 picks total. Most days will be 2-4. Some days fewer.
• ZERO picks is a valid answer. Returning [] when nothing meets the bar is the right call.
• NO low-confidence picks. If you'd label it "low," it doesn't belong on the board.
• Confidence breakdown:
    "high"   = both edges strong + 3+ corroborating facts in research
    "medium" = both edges present, 2 corroborating facts
    (no "low" tier — drop it instead)
• Spread coverage by sport is NOT a goal. It's irrelevant. If 3 picks today are all NBA totals, fine.
• Mix of bet types is NOT a goal. Take the picks where edge is clearest, regardless of type.

═══════════════════════════════════════════════════════════════
EDGE FIELD FORMAT (mandatory structure)
═══════════════════════════════════════════════════════════════

Every edge field must follow this 4-part template:

  Edge 1: [Specific verified fact with source]
  Edge 2: [Second independent verified fact with source]
  Quantified value: [Points/probability gap with brief math]
  Why market hasn't adjusted: [One sentence on why this is still available]

Example of a pick that meets the bar:
  matchup: "Phoenix Suns @ Denver Nuggets"
  pick: "Nuggets -7.5"
  edge: "Edge 1: Devin Booker ruled OUT (Shams, 2hr ago) — Suns score 14.2 fewer ppg without him in 8-game sample. Edge 2: Nuggets coming off 3 days rest vs Suns 2nd of back-to-back, traveling. Quantified value: True line is Nuggets -10 (Booker = ~3.5 pts, rest gap = ~2 pts), market still at -7.5 = 2.5 pts of value. Why market hasn't adjusted: News broke 90 minutes before kickoff, books haven't moved fully."

If you can't write all four parts truthfully, drop the pick.

═══════════════════════════════════════════════════════════════
FORMATS
═══════════════════════════════════════════════════════════════

TIME: "Today H:MM PM ET" or "Tomorrow H:MM PM ET"

TYPE: "spread" | "moneyline" | "total" | "player_prop" | "first_half"

PICK by type:
  spread      → "Team +/-X.X"         e.g. "Knicks -5.5", "Arsenal -0.5"
  moneyline   → "Team ML"             e.g. "Thunder ML"
  total       → "Over/Under X.X"      e.g. "Under 218.5", "Over 2.5 goals"
  player_prop → "Player O/U X.X Stat" e.g. "Jalen Brunson Over 28.5 Points"
  first_half  → "Team +/-X.X (1H)"    e.g. "Celtics -3.5 (1H)"

LEAGUE: NBA, NFL, MLB, NHL, EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, MLS

═══════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON. Empty array is correct when nothing clears the bar:

{"picks":[{"matchup":"Away @ Home","league":"NBA","type":"spread","when":"Today 7:30 PM ET","pick":"Team -4.5","odds":"-110","edge":"Edge 1: ... Edge 2: ... Quantified value: ... Why market hasn't adjusted: ...","confidence":"high"}]}

Or simply: {"picks":[]}

A day with zero picks is not a failure. It's discipline.`;

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
    let finalPicks = raw.map(p => {
      const t = String(p.type||'').toLowerCase().replace(/\s+/g,'_').replace(/prop$/,'player_prop');
      return { ...p, type: validTypes.has(t) ? t : 'spread' };
    });
    console.log('[picks] stage 3/3: finalized ' + finalPicks.length + ' picks');
    finalPicks.forEach((p, i) => {
      console.log('[picks] candidate ' + (i+1) + ': ' + (p.league||'?') + ' / ' + (p.pick||'?') + ' (conf: ' + (p.confidence||'?') + ', edge len: ' + (p.edge||'').length + ')');
    });

    // ─── DISCIPLINE FILTER ─────────────────────────────────────────────────────
    // Defense in depth — drop weak picks server-side, with explicit logging so
    // we can see which picks got cut and why. This is the diagnostic that lets
    // us tune the bar correctly: too strict and we starve, too loose and we
    // pollute the hit rate.
    const hadOdds = Object.keys(oddsByGame).length > 0;
    const beforeCount = finalPicks.length;
    finalPicks = finalPicks.filter(p => {
      const conf = String(p.confidence||'').toLowerCase();
      const edge = String(p.edge||'');
      if (conf === 'low') {
        console.log('[picks] DROP (low confidence): ' + p.pick);
        return false;
      }
      if (edge.length < 100) {
        console.log('[picks] DROP (edge too short, ' + edge.length + ' chars): ' + p.pick);
        return false;
      }
      if (!/\d/.test(edge)) {
        console.log('[picks] DROP (no numbers in edge): ' + p.pick);
        return false;
      }
      if (hadOdds) {
        const hasMarketCompare = /\b(market|line|book|gap|fair|model)\b/i.test(edge);
        if (!hasMarketCompare) {
          console.log('[picks] DROP (no market comparison language): ' + p.pick);
          return false;
        }
      }
      return true;
    });
    console.log('[picks] discipline filter: ' + beforeCount + ' → ' + finalPicks.length + ' picks');

    // Annotate picks with the market line at pick time — needed for closing line
    // value tracking later. This is what real bettors use to evaluate skill.
    finalPicks = finalPicks.map(p => {
      // Attempt to find the matching odds entry for this pick's matchup
      const key = String(p.matchup||'').toLowerCase().replace(/\s+/g,' ').trim();
      const matched = oddsByGame[key];
      if (matched) {
        p.marketSnapshot = {
          capturedAt: new Date().toISOString(),
          markets: matched.markets,
        };
      }
      return p;
    });

    // ─── PER-SPORT BACKSTOP — INTENTIONALLY DISABLED ──────────────────────────
    // Previous version filled in any sport that had games but no pick. That
    // contradicts the new "fewer better picks" philosophy: backstopping is
    // padding, padding hurts long-term hit rate. If a sport has no edge today,
    // it gets zero picks today. The user sees an honest empty section and the
    // record stays clean.

    console.log('[picks] TOTAL picks returned: ' + finalPicks.length);
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

  console.log('Attaching real X posts...');
  await attachRealTweets(clustered.clusters || []);

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
