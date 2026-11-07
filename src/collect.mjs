// Original lightweight GitHub Actions RSS collector.
// Based on the general Actions + Pages architecture of existing RSS readers.
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EN_FILE = 'docs/data/en.json';
const KO_FILE = 'docs/data/ko.json';
const config = JSON.parse(await readFile('config/feeds.json', 'utf8'));
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'AcademicFeedGithub/1.0' } });
const now = Date.now();
const cutoff = now - config.retention_days * DAY;
const dayKST = date => new Date(new Date(date).getTime() + 9 * HOUR).toISOString().slice(0,10);

async function readData(path) {
  try {
    const d = JSON.parse(await readFile(path,'utf8'));
    if (!Array.isArray(d.articles)) throw new Error('articles must be an array');
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 2, updated_at: null, articles: [] };
    throw e;
  }
}
function normalizedTitle(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').slice(0,350);
}
function normalizedURL(raw) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|ref|source)$/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch { return null; }
}
function extractDOI(s) {
  const match = String(s||'').match(/10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/i);
  return match ? match[0].replace(/[.,;)]*$/,'').toLowerCase() : null;
}
function cleanup(a) {
  return String(a ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g,' ').trim();
}
function normalize(item, source) {
  const url = normalizedURL(item.link);
  const title = cleanup(item.title).slice(0,450);
  const pubMs = Date.parse(item.isoDate || item.pubDate || item.published || '');
  if (!url || !title || !Number.isFinite(pubMs) || pubMs < cutoff || pubMs > now + DAY) return null;
  const doi = extractDOI([item.doi, item.guid, url].join(' '));
  const title_key = normalizedTitle(title);
  if (!title_key) return null;
  return {
    key: doi ? 'doi:' + doi : 'url:' + url,
    url, doi, title, title_key,
    summary: cleanup(item.contentSnippet || item.summary || item.content || item.description).slice(0,2000),
    source: source.name, category: source.category,
    published_at: new Date(pubMs).toISOString(),
    collected_at: new Date(now).toISOString()
  };
}
const en = await readData(EN_FILE);
const ko = await readData(KO_FILE);
let articles = en.articles.filter(a =>
  Date.parse(a.published_at) >= cutoff && Date.parse(a.collected_at) >= cutoff);
const seenKeys = new Set(articles.map(a => a.key));
const seenUrls = new Set(articles.map(a => a.url));
const seenDOI = new Set(articles.map(a => a.doi).filter(Boolean));
const seenTitles = new Set(articles.map(a => a.title_key || normalizedTitle(a.title)));
let added = 0, succeeded = 0;

for (const source of config.feeds) {
  let count = articles.filter(a => a.source === source.name && dayKST(a.collected_at) === dayKST(now)).length;
  let fresh = 0, duplicates = 0, candidates = 0;
  try {
    const feed = await parser.parseURL(source.url);
    const items = (feed.items || []).map(x => normalize(x,source)).filter(Boolean)
      .sort((a,b) => b.published_at.localeCompare(a.published_at));
    candidates = items.length;
    for (const a of items) {
      if (seenKeys.has(a.key) || seenUrls.has(a.url) ||
          (a.doi && seenDOI.has(a.doi)) || seenTitles.has(a.title_key)) {
        duplicates++; continue;
      }
      if (count >= config.limit_per_feed_per_day) break;
      articles.push(a); fresh++; count++; added++;
      seenKeys.add(a.key); seenUrls.add(a.url);
      if (a.doi) seenDOI.add(a.doi);
      seenTitles.add(a.title_key);
    }
    succeeded++;
    console.log(source.name + ': eligible=' + candidates + ', new=' + fresh +
      ', duplicates=' + duplicates + ', quota=' + count);
  } catch (error) {
    console.error('RSS failure ['+source.name+']: '+ String(error));
  }
}
articles.sort((a,b) => b.published_at.localeCompare(a.published_at));
const retainedKO = ko.articles.filter(a => Date.parse(a.published_at) >= cutoff);
const enChanged = JSON.stringify(articles) !== JSON.stringify(en.articles);
const koChanged = JSON.stringify(retainedKO) !== JSON.stringify(ko.articles);
await mkdir('docs/data',{recursive:true});
if (enChanged) {
  await writeFile(EN_FILE,JSON.stringify({version:2,updated_at:new Date(now).toISOString(),articles},null,2)+'\n');
}
if (koChanged) {
  await writeFile(KO_FILE,JSON.stringify({version:2,updated_at:new Date(now).toISOString(),articles:retainedKO},null,2)+'\n');
}
console.log('Total=' + articles.length + ', newly collected=' + added + ', deleted expired=' +
  (en.articles.length + ko.articles.length - articles.length - retainedKO.length));
if (!succeeded) process.exitCode = 1;
