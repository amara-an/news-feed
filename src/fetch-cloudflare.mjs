// Fetch every page using curl (verified working in GitHub Actions).
// Fail on truncated results; do not overwrite GitHub data with partial JSON.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const output = process.argv[2] || '/tmp/cloudflare.json';
const base = process.env.CF_FEED_URL || 'https://news-feed.mara04.workers.dev/api/articles';
const pageSize = 200; // works with the deployed v2 and proposed v3 Worker
const items = [];
let expectedTotal = null;
for (let page = 0; page < 250; page++) {
  const url = new URL(base);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(items.length));
  const body = execFileSync('curl', [
    '--fail-with-body','-L','-sS','--retry','3','--retry-all-errors',
    '--connect-timeout','15','--max-time','90',
    '-A','AcademicFeedGitHub/2.0',url.toString(),
  ], {encoding:'utf8',maxBuffer:16*1024*1024});
  const payload = JSON.parse(body);
  if (!Array.isArray(payload.articles)) throw Error('Cloudflare API: articles array missing');
  if (expectedTotal === null && Number.isSafeInteger(payload.total)) expectedTotal = payload.total;
  if (!payload.articles.length && payload.has_more) throw Error('Cloudflare API returned empty page with has_more=true');
  if (!payload.articles.length && !items.length) throw Error('Cloudflare API empty: refusing to overwrite');
  items.push(...payload.articles);
  console.log('Cloudflare page '+(page+1)+': '+payload.articles.length+' items, cumulative '+items.length);
  if (!payload.has_more) {
    if (expectedTotal !== null && items.length !== expectedTotal)
      throw Error('Cloudflare pagination mismatch: got '+items.length+' expected '+expectedTotal);
    await writeFile(output,JSON.stringify({articles:items}));
    console.log('Cloudflare mirror fetched '+items.length+' articles');
    process.exit(0);
  }
}
throw Error('Cloudflare pagination safety cap reached');
