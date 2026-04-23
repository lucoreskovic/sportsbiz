// generate.js
// Run by GitHub Actions every 2 hours.
// Fetches RSS feeds, filters for business stories,
// clusters with one AI call, writes stories.json.

import { writeFileSync } from 'fs';

const FEEDS = [
  { url: 'https://frontofficesports.com/feed/',                        source: 'Front Office Sports' },
  { url: 'https://sportico.com/feed/',                                 source: 'Sportico'            },
  { url: 'https://www.sportsbusinessjournal.com/rss/Top-Stories.aspx', source: 'Sports Business Journal' },
  { url: 'https://feeds.reuters.com/reuters/sportsNews',               source: 'Reuters Sports'      },
  { url: 'https://theathletic.com/rss/feed/',                          source: 'The Athletic'        },
  { url: 'https://apnews.com/hub/sports/rss',                          source: 'AP Sports'           },
];

const BIZ_KEYWORDS = [
  'deal','contract','billion','million','revenue','rights','broadcast',
  'media','streaming','sponsor','naming rights','salary','cap','expansion',
  'franchise','valuation','investment','private equity','stadium','arena',
  'ticket','gambling','betting','cba','labor','collective bargaining',
  'ownership','sale','acquire','merger','partnership','commissioner',
  'extension','buyout','equity','fund','ipo','profit','loss','earnings',
  'fee','penalty','fine',
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
    const link  = (parseField(b, 'link') || (/<link>(.*?)<\/link>/i.exec(b)||[])[1] || '').trim();
    const desc  = parseField(b, 'description');
    const date  = parseField(b, 'pubDate') || parseField(b, 'dc:date');
    if (title && title.length > 10) {
      items.push({ title, link, description: desc, pubDate: date, source: sourceName });
    }
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'SportsBizNow/1.0 RSS Reader' },
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseRSS(await res.text(), feed.source);
  } catch (e) {
    console.warn(`Feed failed (${feed.source}): ${e.message}`);
    return [];
  }
}

function isBiz(story) {
  const text = (story.title + ' ' + story.description).toLowerCase();
  return BIZ_KEYWORDS.some(kw => text.includes(kw));
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

// ── URL validation ───────────────────────────────────────────────────────

const SOURCE_HOMEPAGES = {
  'Front Office Sports':        'https://frontofficesports.com',
  'Sportico':                   'https://sportico.com',
  'Sports Business Journal':    'https://www.sportsbusinessjournal.com',
  'Reuters Sports':             'https://www.reuters.com/sports',
  'The Athletic':               'https://theathletic.com',
  'AP Sports':                  'https://apnews.com/hub/sports',
};

async function validateUrl(url, sourceName) {
  if (!url || !url.startsWith('http')) return SOURCE_HOMEPAGES[sourceName] || '';
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'SportsBizNow/1.0' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (res.ok) return url;
    return SOURCE_HOMEPAGES[sourceName] || url;
  } catch(e) {
    return SOURCE_HOMEPAGES[sourceName] || url;
  }
}

// ── AI clustering ────────────────────────────────────────────────────────

async function cluster(stories) {
  const list = stories.slice(0, 40).map((s, i) =>
    `[${i}] SOURCE: ${s.source} | TITLE: ${s.title} | DESC: ${(s.description||'').slice(0,120)}`
  ).join('\n');

  const prompt = `You are a sports business news editor. Group these ${Math.min(stories.length,40)} RSS stories into 6-8 clusters of related stories. Focus only on business angles: media rights, contracts, salaries, expansion, sponsorship, stadium deals, valuations, gambling, ownership, labor/CBA. Ignore pure game results unless they have clear business implications. IMPORTANT: Order the clusters by importance and reach — the first cluster should be the story with the most sources covering it, the biggest dollar figures, or the widest industry impact. The last cluster should be the least significant. Think of it like a newspaper front page — lead with what matters most.

For each cluster:
- category: one of "media", "contracts", "leagues", "revenue", "labor"
- leadHeadline: clear specific headline under 90 chars
- leadSource: source name + time (e.g. "Front Office Sports · 3h ago")
- leadUrl: URL of lead story
- summary: 2 sentences on business significance, under 200 chars
- storyIndexes: array of story index numbers in this cluster
- posts: 2-3 real social media posts from X or Bluesky reacting to this topic. Search the web for real posts. Each: { platform: "x" or "bluesky", name, handle, content, time, url }. Only include real posts you find — leave empty array if none found. Never invent posts.

Also return sidebar: 6-8 quick-hit items (minor stories or ones that don't fit a cluster). Each: { headline, source, url }

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
      max_tokens: 4000,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);

  const text  = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) throw new Error('No JSON in AI response:\n' + text.slice(0,300));

  const parsed = JSON.parse(text.slice(start, end+1));

  // Hydrate URLs from source list
  const rawClusters = (parsed.clusters||[]).map(c => {
    const idx  = (c.storyIndexes||[])[0];
    const lead = stories[idx];
    return {
      category:     c.category     || 'revenue',
      leadHeadline: c.leadHeadline || lead?.title || '',
      leadSource:   c.leadSource   || `${lead?.source||''} · ${timeAgo(lead?.pubDate)}`,
      leadUrl:      c.leadUrl      || lead?.link  || '',
      leadSourceName: lead?.source || '',
      summary:      c.summary      || '',
      posts:        Array.isArray(c.posts) ? c.posts.filter(p => p && p.content) : [],
    };
  });

  // Validate URLs — fall back to source homepage on 404
  parsed.clusters = await Promise.all(rawClusters.map(async cl => {
    const validUrl = await validateUrl(cl.leadUrl, cl.leadSourceName);
    return { ...cl, leadUrl: validUrl };
  }));

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

// ── Separate picks generation ────────────────────────────────────────────

async function generatePicks() {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const prompt = `You are a sharp sports bettor with access to current data. Today is ${today}. Search for real games being played TODAY across NBA, MLB, NHL, and NFL. For each game you find today, look up: current injury reports, recent team form (last 5 games), line movement, back-to-back situations, home/away splits, and any relevant team news. Then identify 3-4 games with genuine betting value.

Only use real, specific information you can verify — actual injury reports, actual line movements, actual team records. Do not make up connections or use vague reasoning.

Return ONLY raw JSON, nothing else:
{
  "picks": [
    {
      "matchup": "Team A vs Team B",
      "league": "NBA",
      "pick": "Team A -4.5",
      "odds": "-110",
      "edge": "Specific reason: e.g. Team B missing starting PG (knee), on second night of back-to-back, 2-8 ATS on road this season",
      "confidence": "high"
    }
  ]
}

Rules: ONLY real games today. No futures or season totals. confidence = high, medium, or low. 3-4 picks max. Each edge must cite a specific, verifiable fact. If you cannot find real games with clear edges today, return empty picks array.`;

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
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1) { console.warn('No JSON in picks response'); return []; }
  try {
    const parsed = JSON.parse(text.slice(start, end+1));
    return (parsed.picks||[]).filter(p => p && p.matchup && p.pick);
  } catch(e) { console.warn('Picks parse error:', e.message); return []; }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching RSS feeds...');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all     = results.flat();
  console.log(`Raw stories: ${all.length}`);

  const biz = dedup(all.filter(isBiz));
  console.log(`After biz filter + dedup: ${biz.length}`);

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
