const isKO = document.documentElement.lang === 'ko';
const endpoint = '../data/' + (isKO ? 'ko' : 'en') + '.json';
const L = isKO ? {
  title:'학술 피드',count:'번역 기사',empty:'아직 게시된 번역 기사가 없습니다.',
  updated:'마지막 갱신',all:'전체'
} : {
  title:'Academic Feed',count:'English articles',empty:'No articles yet.',
  updated:'Last update',all:'All'
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateKST = s => new Date(s).toLocaleDateString(isKO?'ko-KR':'en-CA',{
  timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'
});
let articles = [], selected = L.all;
const el = id => document.getElementById(id);
function render() {
  const sources = [L.all,...new Set(articles.map(a=>a.source))];
  el('filters').innerHTML = sources.map(s =>
    '<button class="'+(selected === s ? 'active':'')+'" data-source="'+esc(s)+'">'+esc(s)+'</button>').join('');
  el('filters').querySelectorAll('button').forEach(b => b.onclick = () => {selected=b.dataset.source;render();});
  const filtered = articles.filter(a => selected === L.all || a.source === selected);
  let last='',html='';
  for(const a of filtered) {
    const day = dateKST(a.published_at);
    if(day !== last) {html+='<div class="day">'+esc(day)+'</div>';last=day;}
    let url='#';try{const u=new URL(a.url);if(['https:','http:'].includes(u.protocol))url=u.toString();}catch{}
    html+='<article class="card"><div class="meta">'+esc(a.category)+' · '+esc(a.source)+' · '+esc(day)+'</div>'+
      '<div class="title"><a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+
      esc(isKO ? (a.title_ko ?? a.title) : a.title)+'</a></div>'+
      '<div class="summary">'+esc(isKO ? (a.summary_ko ?? a.summary) : a.summary)+'</div></article>';
  }
  el('feed').innerHTML = html || '<p class="empty">'+L.empty+'</p>';
}
async function load() {
  try {
    const response=await fetch(endpoint,{cache:'no-store'});
    if(!response.ok)throw new Error('HTTP '+response.status);
    const data=await response.json();
    articles=(data.articles||[]).slice().sort((a,b)=>b.published_at.localeCompare(a.published_at));
    el('status').textContent=articles.length+' '+L.count+' · '+L.updated+': '+(data.updated_at?new Date(data.updated_at).toLocaleString(isKO?'ko-KR':'en-GB',{timeZone:'Asia/Seoul'}):'-')+' · 30 days';
    render();
  } catch(e) {el('status').textContent='Error: '+e.message;}
}
load();
