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
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h/24)}d ago`;
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
        console.log(`DIRECT OK [${items.length}] ${feed.source}`);
        return items;
      }
    }
  } catch(e) {}

  // Fallback to RSS2JSON
  try {
    const r2j = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}&count=20`,
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
      console.log(`RSS2JSON OK [${items.length}] ${feed.source}`);
      return items;
    }
  } catch(e) {}

  console.warn(`FAIL ${feed.source}`);
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
    `[${i}] SOURCE:${s.source} | ${s.title} | ${s.description}`
  ).join('\n');
  const srcList = [...new Set(selected.map(s=>s.source))].join(', ');

  const prompt = `You are a sports business editor. Stories from: ${srcList}.

Create 6-8 clusters with EVENLY DISTRIBUTED sources as leads. Each cluster lead MUST come from a different source. Do not use Front Office Sports or Sportico for more than 2 leads total.

For each cluster return JSON fields:
- category: "media"|"contracts"|"leagues"|"revenue"|"labor"
- leadHeadline: exact title from story (copy it)
- leadSource: exact source name from [index] prefix plus " · Xh ago"  
- summary: 2 sentences under 180 chars
- article: 120 word sports business article
- storyIndexes: [indexes] including stories from multiple sources
- posts: []

Return sidebar (8 items from varied sources, each with headline/source/article fields), poll (question + 4 options), predictions (4 items with statement/probability/rationale), picks=[].

Return ONLY valid JSON with keys: clusters, sidebar, poll, predictions, picks, updatedAt.

Stories:
${list}\`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

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
      leadSource:   c.leadSource   || `${lead?.source||''} · ${timeAgo(lead?.pubDate)}`,
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
  parsed.picks = [];
  return parsed;
}

async function generatePicks() {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  let games = [];
  const leagues = [
    {id:'nba',sport:'basketball'},{id:'mlb',sport:'baseball'},
    {id:'nhl',sport:'hockey'},{id:'nfl',sport:'football'},
  ];
  for (const lg of leagues) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${lg.sport}/${lg.id}/scoreboard`, {signal:AbortSignal.timeout(6000)});
      if (!res.ok) continue;
      const d = await res.json();
      for (const ev of (d.events||[]).slice(0,4)) {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors||[];
        const home = teams.find(t=>t.homeAway==='home')||teams[0];
        const away = teams.find(t=>t.homeAway==='away')||teams[1];
        if (ev.status?.type?.name === 'STATUS_FINAL') continue;
        const gt = new Date(ev.date).toLocaleString('en-US',{weekday:'short',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}) + ' ET';
        games.push(`${lg.id.toUpperCase()}: ${away?.team?.displayName||''} (${away?.records?.[0]?.summary||''}) @ ${home?.team?.displayName||''} (${home?.records?.[0]?.summary||''}) — ${gt}`);
      }
    } catch(e) {}
  }

  const ctx = games.length > 0
    ? `Real upcoming games from ESPN:\n${games.join('\n')}`
    : `Use your knowledge of today's sports schedule (${today}).`;

  const prompt = `You are a sharp sports bettor. Today is ${today}. ${ctx}

Find 3-4 games with genuine betting value. For each cite specific verifiable facts: injury status, ATS record, rest situation, home/away splits.

Return ONLY JSON:
{"picks":[{"matchup":"Away @ Home","league":"NBA","when":"Today 7:30 PM ET","pick":"Team +4.5","odds":"-110","edge":"Specific reason with real data","confidence":"high"}]}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:800,messages:[{role:'user',content:prompt}]}),
  });
  const data = await res.json();
  if (!res.ok) return [];
  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s===-1) return [];
  try { return (JSON.parse(text.slice(s,e+1)).picks||[]).filter(p=>p&&p.matchup&&p.pick); }
  catch(e) { return []; }
}

async function fetchHighlights() {
  const CHANNELS = [
    {name:'NBA', id:'UCWJ2lWNubArHWmf3FIHbfcQ'},
    {name:'NFL', id:'UCDVYQ4Zhbm3S2dlz7P1GBDg'},
    {name:'MLB', id:'UCzWQYUVCpZqtN93H8RR44Qw'},
    {name:'NHL', id:'UCqFCMJ17JCBqjR8_9yx9wqg'},
    {name:'WNBA',id:'UCvFZOh6gkFVVPbSNt9ohEiA'},
    {name:'MLS', id:'UCiWLfSweyRNmLpgEHekhoAg'},
  ];
  const results = [];
  for (const ch of CHANNELS) {
    try {
      const ytUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
      const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(ytUrl)}&count=1`,
        {signal:AbortSignal.timeout(10000)});
      const d = await r.json();
      if (d.status==='ok' && d.items?.length > 0) {
        const item = d.items[0];
        const videoId = (item.link||'').split('v=')[1]?.split('&')[0] || '';
        if (videoId) {
          const h = Math.round((Date.now()-new Date(item.pubDate).getTime())/3600000);
          results.push({league:ch.name,title:item.title,videoId,thumbnail:`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,timeAgo:h<24?h+'h ago':Math.round(h/24)+'d ago',isFallback:false});
          console.log(`Highlight ${ch.name}: ${videoId}`);
        }
      }
    } catch(e) { console.warn(`Highlight ${ch.name} failed:`, e.message); }
  }
  return results;
}

async function main() {
  console.log('Fetching RSS feeds...');
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = dedup(results.flat());
  console.log(`Total stories: ${all.length}`);
  if (all.length < 3) { console.error('Too few stories'); process.exit(1); }

  console.log('Clustering...');
  const clustered = await cluster(all);
  console.log(`Clusters: ${clustered.clusters?.length}`);

  console.log('Generating picks...');
  clustered.picks = await generatePicks();
  console.log(`Picks: ${clustered.picks?.length}`);

  console.log('Fetching highlights...');
  clustered.highlights = await fetchHighlights();
  console.log(`Highlights: ${clustered.highlights?.length}`);

  writeFileSync('stories.json', JSON.stringify(clustered, null, 2));
  console.log('Written stories.json');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
