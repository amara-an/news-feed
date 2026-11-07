// Academic Feed v3 — daily collector and short GitHub handoff cache.
// Required binding: DB (existing D1 database).
// Optional secret: INGEST_TOKEN, for authenticated manual POST /admin/ingest.
// Cron is configured in Cloudflare, not in this file:
//   0 16 * * *   = 01:00 Asia/Seoul (previous day 16:00 UTC).
// Up to 20 NEW articles per feed per KST calendar day. No AI / translation calls.
// Text cached for 3 days for GitHub handoff/retry; identifiers for 30-day dedup.
// GitHub holds the full accumulated 30-day archive.
// Legacy tables (af_stage, af_publications, af_state) are not modified.

const VERSION = 'academic-feed-2026-11-07-v3-handoff';
const DAY_MS = 86_400_000;
const BUFFER_DAYS = 3;
const SEEN_DAYS = 30;
const RSS_LOOKBACK_DAYS = 30;
const FEED_LIMIT = 20;
const MAX_RESPONSE_BYTES = 2_000_000;
const FEEDS = [
  { url: 'https://www.nature.com/nature.rss', source: 'Nature', category: 'Natural Sciences' },
  { url: 'https://www.nature.com/nathumbehav.rss', source: 'Nature Human Behaviour', category: 'Social Sciences' },
  { url: 'https://rss.arxiv.org/rss/cs.AI', source: 'arXiv AI', category: 'AI & Computing' },
];

function reply(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*', // Read-only API. POST endpoint has no CORS allowance.
    },
  });
}

function clean(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_whole, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1]?.toLowerCase() === 'x';
        const n = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n) : '';
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()] || '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTitle(value) {
  return clean(value).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 350);
}

function normalizedURL(raw) {
  try {
    const url = new URL(clean(raw));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function extractDOI(raw) {
  const found = String(raw || '').match(/10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/i);
  return found ? found[0].replace(/[.,;)]*$/, '').toLowerCase() : null;
}

function xmlField(block, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('<' + safe + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + safe + '\\s*>', 'i'));
  return match ? match[1].trim() : '';
}

function parseFeed(xml, feed, now) {
  if (!/<(?:rss|rdf:RDF|feed)\b/i.test(xml)) throw Error('Invalid RSS/Atom document');
  const entries = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi)];
  const articles = [];
  const cutoff = now - RSS_LOOKBACK_DAYS * DAY_MS;

  for (const [, item] of entries) {
    const href = item.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1];
    const url = normalizedURL(xmlField(item, 'link') || href);
    const title = clean(xmlField(item, 'title'));
    const summary = clean(xmlField(item, 'description') || xmlField(item, 'summary') || xmlField(item, 'content:encoded')).slice(0, 1600);
    const dateText = clean(xmlField(item, 'pubDate') || xmlField(item, 'published') || xmlField(item, 'updated') || xmlField(item, 'dc:date'));
    const published = Date.parse(dateText);
    if (!url || !title || !Number.isFinite(published) || published < cutoff || published > now + DAY_MS) continue;

    const doi = extractDOI(xmlField(item, 'dc:identifier') + ' ' + xmlField(item, 'prism:doi') + ' ' + url);
    const titleKey = normalizedTitle(title);
    if (!titleKey) continue;
    articles.push({
      key: doi ? 'doi:' + doi : 'url:' + url,
      url, doi, title: title.slice(0, 450), title_key: titleKey,
      summary, source: feed.source, category: feed.category,
      published_at: new Date(published).toISOString(),
    });
  }

  articles.sort((a, b) => b.published_at.localeCompare(a.published_at));
  return { raw: entries.length, eligible: articles.length, articles };
}

async function fetchRSS(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      'User-Agent': 'AcademicFeed/2.0',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Error('RSS HTTP ' + response.status);
  const xml = await response.text();
  if (xml.length > MAX_RESPONSE_BYTES) throw Error('RSS too large');
  return xml;
}

async function init(env) {
  if (!env.DB) throw Error('D1 binding DB missing');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS af_en_articles (
      key TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      doi TEXT UNIQUE,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      published_at TEXT NOT NULL,
      collected_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS af_en_published_idx ON af_en_articles(published_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS af_en_collected_idx ON af_en_articles(collected_at DESC)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS af_v2_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS af_v3_seen (
      key TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      doi TEXT UNIQUE,
      title_key TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS af_v3_seen_age_idx ON af_v3_seen(first_seen_at)'),
  ]);
}

async function lastRun(env) {
  const row = await env.DB.prepare("SELECT value FROM af_v2_state WHERE key='last_run'").first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function ingest(env, reason = 'cron') {
  await init(env);
  const started = Date.now();
  const nowISO = new Date(started).toISOString();
  const bufferCutoff = new Date(started - BUFFER_DAYS * DAY_MS).toISOString();
  const seenCutoff = new Date(started - SEEN_DAYS * DAY_MS).toISOString();
  // Midnight in Korea, expressed as UTC. Prevents a manual rerun from exceeding
  // the daily feed quota after the scheduled collection.
  const kstMidnight = new Date(
    Math.floor((started + 9 * 60 * 60_000) / DAY_MS) * DAY_MS - 9 * 60 * 60_000
  ).toISOString();
  const lockId = crypto.randomUUID();
  const lockResult = await env.DB.prepare(`
    INSERT INTO af_v2_state(key, value) VALUES('lock', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE CAST(json_extract(af_v2_state.value, '$.expires') AS INTEGER) < ?
  `).bind(JSON.stringify({ id: lockId, expires: started + 15 * 60_000 }), started).run();
  if (!lockResult.meta.changes) return { skipped: 'already_running' };

  const report = {
    version: VERSION, reason, started_at: nowISO, finished_at: null,
    limit_per_feed: FEED_LIMIT, buffer_days: BUFFER_DAYS, seen_days: SEEN_DAYS,
    collected: 0, duplicates: 0, expired_removed: 0, feeds: [], errors: [],
  };
  try {
    // Idempotent migration: retain dedup identifiers BEFORE removing old full text.
    await env.DB.prepare(`
      INSERT OR IGNORE INTO af_v3_seen (key,url,doi,title_key,first_seen_at)
      SELECT key,url,doi,title_key,collected_at FROM af_en_articles
    `).run();
    const deleted = await env.DB.prepare(
      'DELETE FROM af_en_articles WHERE collected_at < ?'
    ).bind(bufferCutoff).run();
    report.expired_removed = deleted.meta.changes || 0;
    // Small identifier-only cache prevents RSS replay from consuming quota.
    await env.DB.prepare('DELETE FROM af_v3_seen WHERE first_seen_at < ?')
      .bind(seenCutoff).run();

    const rows = await env.DB.prepare('SELECT key, url, doi, title_key FROM af_v3_seen').all();
    const countRows = await env.DB.prepare(
      'SELECT source, COUNT(*) AS n FROM af_en_articles WHERE collected_at >= ? GROUP BY source'
    ).bind(kstMidnight).all();
    const usedToday = Object.fromEntries(countRows.results.map(r => [r.source, r.n]));
    const seenKeys = new Set(rows.results.map(r => r.key));
    const seenURLs = new Set(rows.results.map(r => r.url));
    const seenDOIs = new Set(rows.results.map(r => r.doi).filter(Boolean));
    const seenTitles = new Set(rows.results.map(r => r.title_key));

    for (const feed of FEEDS) {
      const feedReport = {
        source: feed.source, raw: 0, eligible: 0, new: 0,
        quota_used_before: usedToday[feed.source] || 0,
        duplicates: 0, above_limit: 0,
      };
      report.feeds.push(feedReport);
      try {
        const parsed = parseFeed(await fetchRSS(feed.url), feed, started);
        feedReport.raw = parsed.raw;
        feedReport.eligible = parsed.eligible;
        const batch = [];
        const remainingQuota = Math.max(0, FEED_LIMIT - (usedToday[feed.source] || 0));
        const localKeys = new Set();
        const localURLs = new Set();
        const localDOIs = new Set();
        const localTitles = new Set();
        for (const article of parsed.articles) {
          const duplicate = seenKeys.has(article.key) || seenURLs.has(article.url) ||
            (article.doi && seenDOIs.has(article.doi)) || seenTitles.has(article.title_key) ||
            localKeys.has(article.key) || localURLs.has(article.url) ||
            (article.doi && localDOIs.has(article.doi)) || localTitles.has(article.title_key);
          if (duplicate) {
            feedReport.duplicates++;
            continue;
          }
          localKeys.add(article.key);
          localURLs.add(article.url);
          if (article.doi) localDOIs.add(article.doi);
          localTitles.add(article.title_key);
          if (batch.length >= remainingQuota) {
            feedReport.above_limit++;
            continue;
          }
          batch.push(article);
        }
        if (batch.length) {
          // D1.batch commits both the dedup identifier and short-lived article.
          const writes = await env.DB.batch(batch.flatMap(a => [
            env.DB.prepare(`
              INSERT OR IGNORE INTO af_v3_seen
                (key,url,doi,title_key,first_seen_at) VALUES (?,?,?,?,?)
            `).bind(a.key,a.url,a.doi,a.title_key,nowISO),
            env.DB.prepare(`
              INSERT OR IGNORE INTO af_en_articles
                (key, url, doi, title, title_key, summary, source, category, published_at, collected_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM af_v3_seen WHERE key=? AND first_seen_at=?)
            `).bind(a.key,a.url,a.doi,a.title,a.title_key,a.summary,a.source,a.category,
                    a.published_at,nowISO,a.key,nowISO),
          ]));
          for (let i = 0; i < batch.length; i++) {
            if ((writes[2*i]?.meta?.changes || 0) > 0 &&
                (writes[2*i+1]?.meta?.changes || 0) > 0) {
              const a = batch[i];
              feedReport.new++;
              seenKeys.add(a.key);
              seenURLs.add(a.url);
              if (a.doi) seenDOIs.add(a.doi);
              seenTitles.add(a.title_key);
            } else {
              feedReport.duplicates++;
            }
          }
        }
        report.collected += feedReport.new;
        usedToday[feed.source] = (usedToday[feed.source] || 0) + feedReport.new;
        report.duplicates += feedReport.duplicates;
      } catch (error) {
        report.errors.push({ feed: feed.source, message: String(error) });
      }
    }
  } catch (error) {
    report.errors.push({ stage: 'ingest', message: String(error) });
  } finally {
    report.finished_at = new Date().toISOString();
    try {
      await env.DB.prepare(`
        INSERT INTO af_v2_state(key, value) VALUES('last_run', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).bind(JSON.stringify(report)).run();
    } finally {
      await env.DB.prepare("DELETE FROM af_v2_state WHERE key='lock' AND json_extract(value, '$.id') = ?")
        .bind(lockId).run();
    }
  }
  return report;
}

async function readArticles(env, url) {
  const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const offset = Math.min(50000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
  const source = url.searchParams.get('source');
  if (source && !FEEDS.some(f => f.source === source)) return reply({ error: 'Unknown source' }, 400);
  const sinceText = url.searchParams.get('since');
  if (sinceText && !Number.isFinite(Date.parse(sinceText))) return reply({ error: 'Invalid since date' }, 400);
  const since = sinceText ? new Date(sinceText).toISOString() : null;
  const cutoff = new Date(Date.now() - BUFFER_DAYS * DAY_MS).toISOString();
  let where = 'WHERE collected_at >= ?';
  const params = [cutoff];
  if (source) { where += ' AND source = ?'; params.push(source); }
  if (since) { where += ' AND collected_at > ?'; params.push(since); }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM af_en_articles ' + where).bind(...params).first();
  const result = await env.DB.prepare(`
    SELECT key, url, doi, title, summary, source, category, published_at, collected_at
    FROM af_en_articles ${where}
    ORDER BY published_at DESC, key ASC LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();
  return reply({
    version: VERSION, language: 'en', source: source || 'all',
    buffer_days: BUFFER_DAYS, archive: 'https://amara-an.github.io/news-feed/en/',
    total: count.n, limit, offset, has_more: offset + result.results.length < count.n,
    articles: result.results, last_run: await lastRun(env),
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Academic Feed — English</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f5;color:#242424}
*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #e4e4e4;padding:24px 18px}
.wrap{max-width:820px;margin:auto}h1{font-size:26px;margin:0 0 8px}#status{font-size:13px;color:#666;line-height:1.6}
nav{display:flex;gap:7px;flex-wrap:wrap;margin-top:18px}button{border:1px solid #ddd;border-radius:18px;padding:8px 12px;background:#fff;cursor:pointer}
button.active{background:#222;color:#fff}main{padding:18px}.card{display:block;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:20px;margin-bottom:12px}
.meta{font-size:12px;color:#777}.title{font-size:19px;font-weight:650;line-height:1.5;margin:10px 0}
.summary{font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;color:#444}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}.day{font-weight:650;margin:22px 0 12px}.empty{color:#777}
#more{display:none;margin:16px auto 36px;padding:10px 28px}@media(max-width:600px){.card{padding:16px}.title{font-size:17px}}
</style></head><body>
<header><div class="wrap"><h1>Academic Feed <small style="font-weight:400;font-size:14px">English</small></h1>
<div id="status">Loading…</div><nav id="filters"></nav></div></header>
<main class="wrap"><div id="feed"></div><button id="more">Load more</button></main>
<script>
let sources=['All','Nature','Nature Human Behaviour','arXiv AI'];
let selected='All',items=[],offset=0,more=false,busy=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=s=>new Date(s).toLocaleDateString('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
function draw(){document.getElementById('filters').innerHTML=sources.map(c=>'<button data-source="'+esc(c)+'" class="'+(selected===c?'active':'')+'">'+esc(c)+'</button>').join('');
document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>{if(busy)return;selected=b.dataset.source;items=[];offset=0;more=false;load()});
let html='',last='';for(const a of items){const d=day(a.published_at);if(d!==last){html+='<div class="day">'+esc(d)+'</div>';last=d;}
html+='<article class="card"><div class="meta">'+esc(a.category)+' · '+esc(a.source)+' · '+esc(d)+'</div>'+
'<div class="title"><a target="_blank" rel="noopener noreferrer" href="'+esc(a.url)+'">'+esc(a.title)+'</a></div>'+
'<div class="summary">'+esc(a.summary)+'</div></article>';}
document.getElementById('feed').innerHTML=html||'<p class="empty">No articles to display yet.</p>';
document.getElementById('more').style.display=more?'block':'none';}
async function load(){if(busy)return;busy=true;try{const q=new URLSearchParams({limit:'100',offset:String(offset)});if(selected!=='All')q.set('source',selected);
const r=await fetch('/api/articles?'+q);if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();items.push(...data.articles);offset+=data.articles.length;more=data.has_more;
const run=data.last_run;document.getElementById('status').textContent=data.total+' English articles · 3-day handoff buffer · 30-day archive on GitHub · updated daily at 01:00 KST'+
(run?.finished_at?' · last collection '+new Date(run.finished_at).toLocaleString('en-GB',{timeZone:'Asia/Seoul'}):' · awaiting first collection');draw();
}catch(error){document.getElementById('status').textContent='Unable to load feed: '+error.message;}finally{busy=false;}}
document.getElementById('more').onclick=load;draw();load();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/en')) {
        return new Response(PAGE, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        } });
      }
      if (request.method === 'GET' && url.pathname === '/api/articles') {
        await init(env);
        return await readArticles(env, url);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        await init(env);
        const cutoff = new Date(Date.now() - BUFFER_DAYS * DAY_MS).toISOString();
        const totals = await env.DB.prepare(`
          SELECT source, COUNT(*) AS count FROM af_en_articles
          WHERE collected_at >= ? GROUP BY source
        `).bind(cutoff).all();
        const bySource = Object.fromEntries(FEEDS.map(f => [f.source, 0]));
        for (const row of totals.results) bySource[row.source] = row.count;
        return reply({ version: VERSION, feeds: FEEDS.map(f => f.source),
          limit_per_feed: FEED_LIMIT, buffer_days: BUFFER_DAYS, archive_days: 30,
          total: Object.values(bySource).reduce((a, b) => a + b, 0),
          by_source: bySource, last_run: await lastRun(env) });
      }
      if (request.method === 'POST' && url.pathname === '/admin/ingest') {
        if (!env.INGEST_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.INGEST_TOKEN) {
          return reply({ error: 'Unauthorized' }, 401);
        }
        return reply(await ingest(env, 'manual'));
      }
      return reply({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      return reply({ error: String(error) }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await ingest(env, 'cron');
      if (result.errors?.length) console.error('Academic feed collection errors', JSON.stringify(result.errors));
    })());
  },
};