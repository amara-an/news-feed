/**
 * Import the existing public Cloudflare academic feed into GitHub Pages.
 * Cloudflare remains the RSS collector (20 new items/source/day); this script
 * only mirrors its already-collected records, dedupes and retains 30 days.
 * No translation or paid AI API is invoked here.
 */
import fs from "node:fs/promises";

const EN_PATH = "docs/data/en.json";
const KO_PATH = "docs/data/ko.json";
const DAY = 86400000;
const now = Date.now();
const retentionDays = 30;
const cutoff = now - retentionDays * DAY;
const sources = new Map([
  ["nature", { name:"Nature", category:"자연과학" }],
  ["nature human behaviour", { name:"Nature Human Behaviour", category:"사회과학" }],
  ["arxiv ai", { name:"arXiv AI", category:"AI·컴퓨터" }],
  ["arxiv", { name:"arXiv AI", category:"AI·컴퓨터" }],
  ["arxiv cs.ai", { name:"arXiv AI", category:"AI·컴퓨터" }]
]);
const normalizeText = value => String(value ?? "").replace(/\s+/g," ").trim();
const titleKey = s => normalizeText(s).normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu,"").slice(0,350);
function normalizeURL(value) {
  try {
    const u = new URL(value);
    if(!["https:","http:"].includes(u.protocol))return null;
    u.hash="";
    for (const k of [...u.searchParams.keys()])
      if(/^utm_|^(gclid|fbclid|ref|source)$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  }catch{return null;}
}
function dateOr(value, fallback) {
  const x=Date.parse(value ?? "");
  return Number.isFinite(x) ? new Date(x).toISOString():fallback;
}
function normalizeSource(value) {
  const raw=normalizeText(value);
  const mapped=sources.get(raw.toLowerCase());
  if(mapped)return mapped;
  // New feed names stay distinct; never silently merge Nature Physics into Nature.
  return { name:raw||"Other",category:"학술" };
}
function toArticle(item) {
  if(!item || typeof item!=="object")return null;
  const url=normalizeURL(item.url || item.link || item.article_url);
  const title=normalizeText(item.title || item.title_en || item.headline);
  if(!url || !title)return null;
  const source=normalizeSource(item.source || item.feed || item.journal);
  const collectedAt=dateOr(item.collected_at || item.added_at || item.fetched_at || item.created_at,new Date(now).toISOString());
  const publishedAt=dateOr(item.published_at || item.pubDate || item.published || item.date,collectedAt);
  if(Date.parse(collectedAt)<cutoff)return null;
  let doi=normalizeText(item.doi).toLowerCase() || null;
  if(!doi){
    const m=(url+" "+normalizeText(item.key)).match(/10\.\d{4,9}\/[a-zA-Z0-9._;()/:+-]+/i);
    if(m)doi=m[0].replace(/[.,;)]*$/,"").toLowerCase();
  }
  let key = normalizeText(item.key || item.id);
  if (!key || /^https?:/i.test(key))key=doi?"doi:"+doi:"url:"+url;
  const title_key=titleKey(title);
  if(!title_key)return null;
  return {
    key,url,doi,title,title_key,
    summary:normalizeText(item.summary || item.summary_en || item.description || item.contentSnippet || item.abstract).slice(0,5000),
    source:source.name,
    category:normalizeText(item.category) || source.category,
    published_at:publishedAt,
    collected_at:collectedAt
  };
}
async function readData(path) {
  try {
    const p=JSON.parse(await fs.readFile(path,"utf8"));
    if(!Array.isArray(p.articles))throw new Error("Invalid articles array at "+path);
    return p;
  }catch(e){
    if(e.code==="ENOENT")return {version:2,updated_at:null,articles:[]};
    throw e;
  }
}
const raw=await fs.readFile(process.argv[2] || "/tmp/cloudflare.json","utf8");
const payload=JSON.parse(raw);
const input=Array.isArray(payload)?payload:
  payload?.articles ?? payload?.items ?? payload?.data?.articles ?? payload?.data?.items;
if(!Array.isArray(input))throw new Error("Unexpected Cloudflare JSON layout. Top-level keys: "+Object.keys(payload).join(","));
console.log("Cloudflare records returned: "+input.length);
if(input.length===0) {
  throw new Error("Cloudflare API returned 0 articles. Refusing to overwrite existing data.");
}
if(input.length>=100) {
  console.warn("WARNING: 100+ records. Verify Cloudflare API response limit/pagination for full 30-day coverage.");
}
console.log("First item keys: "+Object.keys(input[0]).join(", "));
const existing=await readData(EN_PATH);
const ko=await readData(KO_PATH);
const articles=existing.articles.filter(a=>Date.parse(a.collected_at||a.added_at||a.published_at)>=cutoff);
const keys=new Set(),urls=new Set(),dois=new Set(),titles=new Set();
function remember(a) {
  if(a.key)keys.add(a.key);
  if(a.url)urls.add(a.url);
  if(a.doi)dois.add(a.doi);
  if(a.title)titles.add(a.title_key||titleKey(a.title));
}
articles.forEach(remember);
let added=0,ignored=0,invalid=0;
const counts={};
for(const rawArticle of input) {
  const a=toArticle(rawArticle);
  if(!a){invalid++;continue;}
  if(keys.has(a.key)||urls.has(a.url)||(a.doi&&dois.has(a.doi))||titles.has(a.title_key)){ignored++;continue;}
  articles.push(a);remember(a);added++;
  counts[a.source]=(counts[a.source]||0)+1;
}
if(added===0 && articles.length===0)throw new Error("No valid records after parsing. Refusing empty publication.");
articles.sort((a,b)=>b.published_at.localeCompare(a.published_at));
const keptKO=ko.articles.filter(a=>Date.parse(a.collected_at||a.added_at||a.published_at)>=cutoff);
await fs.mkdir("docs/data",{recursive:true});
const enChanged=JSON.stringify(existing.articles)!==JSON.stringify(articles);
const koChanged=JSON.stringify(ko.articles)!==JSON.stringify(keptKO);
if(enChanged)await fs.writeFile(EN_PATH,JSON.stringify({version:2,updated_at:new Date(now).toISOString(),articles},null,2)+"\n");
if(koChanged)await fs.writeFile(KO_PATH,JSON.stringify({version:2,updated_at:new Date(now).toISOString(),articles:keptKO},null,2)+"\n");
console.log(JSON.stringify({result:"success",cloudflare_input:input.length,added,already_present:ignored,invalid,retained_en:articles.length,retained_ko:keptKO.length,new_by_source:counts},null,2));
