// dev-status — BMad 프로젝트 개발 현황판: HTML 생성기 (다크 슬레이트 중립 팔레트)
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scan, OUT_DIR } from './scan.mjs'

const OUT_FILE = join(OUT_DIR, 'index.html')

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#020617; --ticker:#0A0F1E; --card:#0E1223; --elev:#1E293B; --line:#334155;
  --t1:#F8FAFC; --t2:#94A3B8; --t3:#64748B;
  --blue:#0070F3; --lblue:#7FB8FF; --orange:#E85C0D; --green:#22C55E;
  --mono:ui-monospace,'Cascadia Mono','D2Coding',monospace;
}
body{
  background:var(--bg); color:var(--t1);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;
  font-size:14px; line-height:1.5; padding:24px 24px 64px; position:relative;
}
body::before{content:"";position:absolute;top:-160px;left:50%;transform:translateX(-50%);
  width:920px;height:460px;pointer-events:none;
  background:radial-gradient(closest-side,rgba(127,184,255,.08),transparent)}
.wrap{max-width:1240px;margin:0 auto;position:relative}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.01em}
a{color:var(--lblue);text-decoration:none}
a:hover{text-decoration:underline}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
:focus-visible{outline:2px solid var(--lblue);outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion:no-preference){
  .row,.chip,.epic-head{transition:background 180ms,border-color 180ms}
}

/* 헤더 */
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.brand{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.brand b{font-size:20px;font-weight:800}
.brand span{font-size:12px;color:var(--t2);word-break:break-all}
.stamp{font-size:12px;color:var(--t3);text-align:right}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--green)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block}
.live.off{color:var(--t3)} .live.off i{background:var(--t3)}

/* 상단 경고 배너 — 매치 0건·엔진 경로 불일치 */
.warnbar{background:rgba(232,92,13,.10);border:1px solid rgba(232,92,13,.55);border-radius:8px;
  padding:12px 16px;margin-bottom:16px;font-size:12px;color:var(--orange);line-height:1.7}

/* 티커 */
.ticker{background:var(--ticker);border:1px solid var(--line);border-radius:8px;
  padding:12px 16px;display:flex;gap:8px 24px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.tk{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--t2)}
.tk b{font-size:16px;color:var(--t1);font-weight:600}
.tk.warn b{color:var(--orange)}
.dot{width:3px;height:3px;border-radius:50%;background:var(--t3);display:inline-block}

/* 상황판 */
.board{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;margin-bottom:16px;
  display:grid;grid-template-columns:220px 1fr;gap:32px;align-items:center}
@media (max-width:760px){.board{grid-template-columns:1fr;gap:16px}}
.pct{font-size:52px;line-height:1;color:var(--lblue);font-weight:600}
.pct small{font-size:20px;color:var(--t2);margin-left:4px}
.pct-label{font-size:12px;color:var(--t2);margin-top:8px}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--elev)}
.bar i{display:block}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--t2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend em{width:10px;height:10px;border-radius:3px;font-style:normal}

/* 분류 공통 */
.sec3{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;overflow:hidden}
.s3-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--line)}
.s3-head h2{font-size:16px;font-weight:600}
.s3-head .n{font-family:var(--mono);font-size:12px;border-radius:999px;padding:3px 10px;
  color:var(--lblue);border:1px solid rgba(127,184,255,.45)}
.s3-head .n.warn{color:var(--orange);border-color:rgba(232,92,13,.55)}
.s3-head .sub{font-size:12px;color:var(--t2);margin-left:auto}
.it{display:grid;grid-template-columns:1fr 220px;gap:16px;align-items:start;
  padding:14px 16px;border-bottom:1px solid rgba(51,65,85,.5)}
@media (max-width:860px){.it{grid-template-columns:1fr;gap:10px}}
.it:last-child{border-bottom:0}
.it:hover{background:rgba(248,250,252,.04)}
.it-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag{font-size:12px;border-radius:999px;padding:2px 8px;border:1px solid var(--line);color:var(--t2)}
.tag.rv{color:var(--lblue);border-color:rgba(127,184,255,.45)}
.tag.ip{color:var(--blue);border-color:rgba(0,112,243,.55)}
.tag.rd{color:var(--green);border-color:rgba(34,197,94,.55)}
.tag.bl{color:var(--t3)}
.tag.wa{color:var(--orange);border-color:rgba(232,92,13,.55)}
.it-sid{font-family:var(--mono);font-size:12px;color:var(--t3)}
.it b.t{display:block;font-size:14px;font-weight:600;margin-top:6px}
.it p{font-size:12px;color:var(--t2);margin-top:4px}
.it .src{font-size:12px;color:var(--t3);font-family:var(--mono);margin-top:6px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it-act{display:flex;flex-direction:column;gap:6px;align-items:stretch}
.sk{font-family:var(--mono);font-size:12px;color:var(--lblue);background:#080D1A;
  border:1px solid var(--line);border-radius:6px;padding:6px 10px;text-align:center;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp{font-size:12px;color:var(--t1);border:1px solid var(--line);border-radius:6px;
  padding:8px 10px;background:var(--elev);min-height:36px}
.cp:hover{border-color:var(--lblue)}
.cp[disabled]{opacity:.45;cursor:not-allowed}
.cp[disabled]:hover{border-color:var(--line)}
.blocked{font-size:12px;color:var(--orange);margin-top:4px;line-height:1.5}
/* 자동 판정이 실행 버튼을 지웠을 때 — 근거와 대체 안내를 그 자리에 남긴다 */
.it .gatewhy{font-size:12px;color:var(--orange);margin-top:4px}
.noact{font-size:12px;color:var(--t3);line-height:1.5}
.batchbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;
  background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;margin-bottom:16px}
.batchbar em{width:8px;height:8px;border-radius:50%;font-style:normal;background:var(--t3);flex:0 0 auto}
.batchbar.on{border-color:rgba(232,92,13,.55);color:var(--t1)}
.batchbar.on em{background:var(--orange)}
.batchbar b{color:var(--t1);font-weight:600}
.batchbar span.q{color:var(--t3);font-family:var(--mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;
  border-bottom:1px solid rgba(51,65,85,.5);background:rgba(127,184,255,.04)}
.bulk .lb{font-size:12px;color:var(--t2);margin-right:4px}
.bulk button{font-size:12px;color:var(--t1);border:1px solid var(--line);border-radius:6px;
  padding:7px 12px;background:var(--elev);min-height:34px}
.bulk button:hover{border-color:var(--lblue)}
.bulk button[disabled]{opacity:.45;cursor:not-allowed}
.bulk button[disabled]:hover{border-color:var(--line)}
.bulk .note{font-size:12px;color:var(--t3);flex:1 1 240px;min-width:200px}
.grp{padding:0 16px 12px;border-bottom:1px solid rgba(51,65,85,.5);background:rgba(127,184,255,.04)}
.grp-l{font-size:12px;color:var(--t2);display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;margin-top:6px}
.grp-l b{color:var(--t1);font-weight:600;flex:0 0 auto}
.grp-l .g{border:1px solid rgba(127,184,255,.45);border-radius:999px;padding:2px 8px;
  color:var(--lblue);font-family:var(--mono)}
.grp-l .g.u{color:var(--t3);border-color:var(--line)}
.grp-why{font-size:12px;color:var(--t3);margin-top:8px;line-height:1.7}
.grp-why code{font-family:var(--mono);color:var(--t2)}
.none3{padding:16px;font-size:12px;color:var(--green)}

/* 경보 */
.alert{background:rgba(232,92,13,.10);border:1px solid rgba(232,92,13,.55);border-radius:8px;
  padding:16px;margin-bottom:16px}
.alert-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.alert-title{color:var(--orange);font-size:14px;font-weight:600}
.alert-title small{color:var(--t2);font-weight:400;margin-left:8px;font-size:12px}
.alert ul{list-style:none;margin-top:12px;display:grid;gap:8px}
.alert li{font-size:12px;color:var(--t1);display:flex;gap:8px;align-items:flex-start}
.alert li b{color:var(--orange);flex:0 0 auto;font-weight:600;font-family:var(--mono)}
.alert li.mid b{color:var(--t2)}
.ok{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px;
  font-size:12px;color:var(--green)}

/* 필터 */
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.chip{border:1px solid var(--line);border-radius:999px;padding:8px 14px;font-size:12px;color:var(--t2);
  background:var(--card);min-height:36px;display:inline-flex;align-items:center;gap:6px}
.chip[aria-pressed="true"]{border-color:var(--lblue);color:var(--t1);background:rgba(127,184,255,.10)}
.chip b{font-family:var(--mono);color:var(--t3)}
.chip[aria-pressed="true"] b{color:var(--lblue)}
.search{flex:1 1 220px;min-width:200px;background:var(--elev);border:1px solid var(--line);border-radius:8px;
  padding:9px 12px;color:var(--t1);font-size:14px;min-height:36px}
.search::placeholder{color:var(--t3)}
.hint{font-size:12px;color:var(--t3);margin:-8px 0 16px}

/* 에픽 */
.epic{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:12px;overflow:hidden}
.epic-head{width:100%;display:grid;grid-template-columns:1fr 200px 84px 24px;gap:16px;align-items:center;
  padding:16px;text-align:left}
@media (max-width:760px){.epic-head{grid-template-columns:1fr 24px}.epic-head .bar-wrap,.epic-head .frac{display:none}}
.epic-head:hover{background:rgba(248,250,252,.04)}
.epic-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.epic-title u{text-decoration:none;color:var(--t3);font-family:var(--mono);font-size:12px}
/* 진행 순서 — 번호와 어긋나는 에픽이 눈에 띄게 */
/* 순서와 번호가 같으면 조용한 글자, 다르면 채워진 알약 — 색만으로 구분하지 않는다
   (배경이 네이비라 회색↔라이트블루 텍스트 대비만으로는 눈에 안 띈다) */
.epic-title .ord{font-family:var(--mono);font-size:12px;color:var(--t3);
  padding:0;margin-right:2px;letter-spacing:.02em}
.epic-title .ord.off{color:var(--lblue);font-weight:700;
  background:rgba(127,184,255,.14);border:1px solid rgba(127,184,255,.55);
  border-radius:999px;padding:2px 10px}
.epic-desc{display:block;font-size:12px;color:var(--t2);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frac{font-family:var(--mono);font-size:12px;color:var(--t2);text-align:right}
.caret{color:var(--t3);font-size:12px;justify-self:end}
.stories{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:52px 1fr 128px 110px;gap:12px;align-items:center;
  padding:12px 16px;border-bottom:1px solid rgba(51,65,85,.5);font-size:14px}
@media (max-width:760px){.row{grid-template-columns:52px 1fr;row-gap:8px}.row .pipe,.row .st{grid-column:2}}
.row:last-child{border-bottom:0}
.row:hover{background:rgba(248,250,252,.04)}
.rid{font-family:var(--mono);font-size:12px;color:var(--t3)}
.rtitle{min-width:0}
.rtitle b{display:block;font-weight:500}
.rgoal{display:block;font-size:12px;color:var(--t2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rmeta{font-size:12px;color:var(--t3);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap}
.st{font-size:12px;display:inline-flex;align-items:center;gap:6px;justify-self:start}
.st em{width:8px;height:8px;border-radius:50%;font-style:normal;flex:0 0 auto}
.pipe{display:flex;gap:5px}
.pipe i{width:14px;height:14px;border-radius:4px;border:1px solid var(--line);display:block}
.pipe i.on{background:var(--green);border-color:var(--green)}

.empty{font-size:12px;color:var(--t3);padding:24px 0}
.foot{margin-top:32px;font-size:12px;color:var(--t3);line-height:1.8}
.foot code{font-family:var(--mono);color:var(--t2)}
`

const JS = `
const D = window.__DATA__
const STATUS = {
  done:        {label:'완료',     color:'var(--green)'},
  review:      {label:'리뷰 대기', color:'var(--lblue)'},
  'in-progress':{label:'진행 중',  color:'var(--blue)'},
  'ready-for-dev':{label:'개발 준비',color:'var(--t2)'},
  backlog:     {label:'대기',     color:'var(--t3)'},
  unregistered:{label:'상태 미등록',color:'var(--orange)'},
}
const ORDER = ['done','review','in-progress','ready-for-dev','backlog','unregistered']
const STAGES = [['create','기획서 작성'],['dev','개발'],['qa','검사(qa)'],['review','적대 리뷰']]
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const allStories = D.epics.flatMap((e) => e.stories)

const UI = Object.assign({q:'', f:'all', open:{'1':true}}, JSON.parse(sessionStorage.getItem('dev-status-ui') || '{}'))
const saveUI = () => sessionStorage.setItem('dev-status-ui', JSON.stringify(UI))

function countBy(list){const o={};for(const s of list)o[s.status]=(o[s.status]||0)+1;return o}

function barHTML(list){
  const c = countBy(list), n = list.length || 1
  return ORDER.filter((k)=>c[k]).map((k)=>
    '<i style="width:'+(c[k]/n*100).toFixed(2)+'%;background:'+STATUS[k].color+'" title="'+STATUS[k].label+' '+c[k]+'건"></i>').join('')
}

function matches(s, epic){
  if (UI.f !== 'all' && s.status !== UI.f) return false
  const q = UI.q.trim().toLowerCase()
  if (!q) return true
  return (s.id+' '+s.title+' '+s.goal+' '+epic.title).toLowerCase().includes(q)
}

function pipeHTML(s){
  return '<span class="pipe">' + STAGES.map(([k,label])=>{
    const ts = s.pipeline[k]
    return '<i class="'+(ts?'on':'')+'" title="'+label+(ts?' 통과 · '+ts.slice(0,10):' 미통과')+'"></i>'
  }).join('') + '</span>'
}

function storyHTML(s){
  const st = STATUS[s.status] || STATUS.backlog
  const meta = []
  if (s.acCount) meta.push('수용기준 '+s.acCount+'묶음')
  if (s.storyFile) meta.push('<a href="'+esc(s.storyFile)+'" target="_blank" rel="noopener">스토리 문서</a>')
  return '<div class="row">'
    + '<span class="rid">'+esc(s.id)+'</span>'
    + '<span class="rtitle"><b>'+esc(s.title)+'</b>'
      + (s.goal ? '<span class="rgoal">'+esc(s.goal)+'</span>' : '')
      + (meta.length ? '<span class="rmeta">'+meta.join('<span class="dot"></span>')+'</span>' : '')
    + '</span>'
    + pipeHTML(s)
    + '<span class="st"><em style="background:'+st.color+'"></em>'+st.label+'</span>'
    + '</div>'
}

function render(){
  const host = document.getElementById('epics')
  let shown = 0
  host.innerHTML = D.epics.map((e)=>{
    const list = e.stories.filter((s)=>matches(s,e))
    shown += list.length
    if (!list.length) return ''
    const open = UI.open[e.num] !== false && (UI.q.trim() || UI.f !== 'all' ? true : UI.open[e.num] === true)
    const done = e.stories.filter((s)=>s.status==='done').length
    return '<section class="epic">'
      + '<button class="epic-head" aria-expanded="'+open+'" data-epic="'+e.num+'">'
        + '<span><span class="epic-title">'+ '<span class="ord'+(e.jump?' off':'')+'" title="'+ (e.jump?'번호는 '+e.num+' 이지만 진행 순서는 '+e.order+'번째입니다 — 여기서 번호가 튑니다':'진행 순서 '+e.order+'번째')+ '">순서 '+e.order+(e.jump?' · 번호 튐':'')+'</span>'+ '<u>EPIC '+e.num+'</u>'+esc(e.title)+'</span>'
          + '<span class="epic-desc">'+esc(e.desc)+'</span></span>'
        + '<span class="bar-wrap"><span class="bar">'+barHTML(e.stories)+'</span></span>'
        + '<span class="frac">'+done+'/'+e.stories.length+'</span>'
        + '<span class="caret">'+(open?'▲':'▼')+'</span>'
      + '</button>'
      + (open ? '<div class="stories">'+list.map(storyHTML).join('')+'</div>' : '')
      + '</section>'
  }).join('')
  if (!shown) host.innerHTML = '<p class="empty">조건에 맞는 스토리가 없습니다. 검색어나 필터를 바꿔 보세요.</p>'
  document.getElementById('shown').textContent = shown + '건 표시'
  host.querySelectorAll('.epic-head').forEach((b)=>b.addEventListener('click',()=>{
    const n = b.dataset.epic
    UI.open[n] = !(UI.open[n] === true)
    saveUI(); render()
  }))
}

function renderFilters(){
  const c = countBy(allStories)
  const items = [['all','전체',allStories.length]].concat(ORDER.filter((k)=>c[k]).map((k)=>[k,STATUS[k].label,c[k]]))
  document.getElementById('chips').innerHTML = items.map(([k,label,n])=>
    '<button class="chip" aria-pressed="'+(UI.f===k)+'" data-f="'+k+'">'+label+' <b>'+n+'</b></button>').join('')
  document.querySelectorAll('#chips .chip').forEach((b)=>b.addEventListener('click',()=>{
    UI.f = b.dataset.f; saveUI(); renderFilters(); render()
  }))
}

document.getElementById('q').addEventListener('input', (e)=>{ UI.q = e.target.value; saveUI(); render() })
document.getElementById('q').value = UI.q
renderFilters(); render()

// 갱신 방식 — 서버(serve.mjs)로 열었으면 새로고침(F5)할 때마다 서버가 다시 만들어 준다. 자동 리로드 없음.
const live = document.getElementById('live')
fetch('__served', {cache:'no-store'}).then((r)=>{ if(!r.ok) throw 0
  live.className = 'live'; live.lastChild.textContent = ' 새로고침(F5)하면 최신'
}).catch(()=>{ live.className = 'live off'; live.lastChild.textContent = ' 파일로 열림 — serve.mjs 로 열면 F5 마다 갱신' })

// 지시문 복사 (실행은 하지 않는다)
document.addEventListener('click', (e)=>{
  const b = e.target.closest('[data-copy]')
  if (!b) return
  navigator.clipboard.writeText(b.dataset.copy).then(()=>{
    const old = b.textContent
    b.textContent = '복사됨'
    setTimeout(()=>{ b.textContent = old }, 1200)
  }).catch(()=>{ b.textContent = '복사 실패' })
})
`

const fmt = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

export function build() {
  const data = scan()
  for (const e of data.epics) for (const s of e.stories) delete s.body // 본문 전문은 화면에서 쓰지 않음

  const stories = data.epics.flatMap((e) => e.stories)
  const done = stories.filter((s) => s.status === 'done').length
  const pct = stories.length ? Math.round((done / stories.length) * 100) : 0
  const high = data.drift.filter((d) => d.level === 'high').length
  const counts = {}
  for (const s of stories) counts[s.status] = (counts[s.status] || 0) + 1
  const ORDER = ['done', 'review', 'in-progress', 'ready-for-dev', 'backlog', 'unregistered']
  const LABEL = { done: '완료', review: '리뷰 대기', 'in-progress': '진행 중', 'ready-for-dev': '개발 준비', backlog: '대기', unregistered: '상태 미등록' }
  const COLOR = { done: 'var(--green)', review: 'var(--lblue)', 'in-progress': 'var(--blue)', 'ready-for-dev': 'var(--t2)', backlog: 'var(--t3)', unregistered: 'var(--orange)' }

  const bar = ORDER.filter((k) => counts[k])
    .map((k) => '<i style="width:' + ((counts[k] / stories.length) * 100).toFixed(2) + '%;background:' + COLOR[k] + '"></i>')
    .join('')
  const legend = ORDER.filter((k) => counts[k])
    .map((k) => '<span><em style="background:' + COLOR[k] + '"></em>' + LABEL[k] + ' ' + counts[k] + '건</span>')
    .join('')

  const esc2 = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const B = data.board
  const STLABEL = { review: ['리뷰 대기', 'rv'], 'in-progress': ['진행 중', 'ip'], 'ready-for-dev': ['개발 준비', 'rd'], backlog: ['대기', 'bl'],
    'review-gated': ['리뷰 반복 · 사람 판단', 'wa'] }

  // 상대 링크 실존 확인 — 링크 대상이 없으면 stderr 경고 1줄(경로 조립은 scan.mjs 의 relFromOut 하나로 통일)
  for (const s of stories) {
    if (s.storyFile && !existsSync(resolve(OUT_DIR, s.storyFile))) {
      console.error('[dev-status] 경고: 링크 대상 없음 — ' + s.storyFile)
    }
  }

  // [지시문 복사] — 스킬 호출 + 파일 경로 + 항목 원문 한 덩어리. 콘솔이 실행하지는 않는다
  const instr = (parts) => parts.filter((x) => x != null).join('\n')
  const blocked = (skill) => B.batch.running && B.writesSprint.includes(skill)

  // 스킬이 비면 버튼을 아예 그리지 않는다 — "버튼이 있으면 나는 누른다"를 코드로 막는다.
  // (버튼만 비활성으로 두면 지시문 첫 줄이 스킬 없는 명령으로 새어 나간다)
  const actHTML = (skill, text) => {
    if (!skill) return '<div class="it-act"><span class="noact">실행 버튼 없음 — 사람이 정하거나 실행하는 항목입니다</span></div>'
    const stop = blocked(skill)
    return '<div class="it-act">' +
      '<span class="sk">' + esc2(skill) + '</span>' +
      '<button type="button" class="cp" data-copy="' + esc2(text) + '"' + (stop ? ' disabled' : '') + '>지시문 복사</button>' +
      (stop ? '<span class="blocked">무인 배치가 도는 중입니다 — 이 스킬은 상태 파일을 쓰므로 배치가 끝난 뒤에 실행하세요.</span>' : '') +
      '</div>'
  }

  // ① 다음 진행할 작업 — 상태값이 곧 할 일이다
  const nextHTML = B.next.length
    ? B.next.map((n) => {
      // 배지는 key 로 먼저 찾는다 — review-gated 는 status 가 그대로 review 라
      // status 로 찾으면 '리뷰 대기'로 잘못 표시된다
      const lb = STLABEL[n.key] || STLABEL[n.status] || ['', 'bl']
      const text = instr([
        n.skill + ' ' + (n.slug || n.story),
        '',
        '스토리: ' + n.story + ' ' + n.title,
        n.file ? '스토리 문서: ' + n.file : '스토리 문서: 아직 없음 — 이 스킬이 만듭니다',
        '현재 상태: ' + n.status + ' — ' + n.why,
      ])
      return '<div class="it"><div><div class="it-top">' +
        '<span class="tag ' + lb[1] + '">' + esc2(lb[0]) + '</span>' +
        '<span class="it-sid">' + esc2(n.story) + '</span>' +
        '<span class="it-sid">EPIC ' + n.epic + '</span></div>' +
        '<b class="t">' + esc2(n.title) + '</b>' +
        '<p>' + esc2(n.why) + '</p>' +
        (n.gateWhy ? '<p class="gatewhy">판정 근거 — ' + esc2(n.gateWhy) + '</p>' : '') +
        (n.file ? '<div class="src">' + esc2(n.file) + '</div>' : '') +
        '</div>' + actHTML(n.skill, text) + '</div>'
    }).join('')
    : '<div class="none3">지금 바로 진행할 스토리가 없습니다.</div>'
  // "N건 있는데 누를 것이 하나도 없다"를 섹션 머리에서 설명한다 — 이 한 줄이 없으면
  // 자동 판정이 버튼을 지웠다는 사실이 화면 어디에도 요약되지 않는다(원본 build.mjs 의 gatedN).
  const gatedN = B.next.filter((n) => n.key === 'review-gated').length

  // 묶음 실행 — 같은 상태의 스토리를 한 번에 무인 배치로 넘긴다.
  // 파일이 겹치는 스토리를 병렬로 돌리면 서로의 변경을 덮으므로, 겹치지 않는 것끼리
  // 묶어 "이 묶음은 병렬 안전 / 묶음끼리는 순차"를 지시문과 화면에 함께 적는다.
  // 커밋·푸시류 정책 플래그는 지시문에 넣지 않는다 — 각 프로젝트의 승인 규칙을 따른다.
  const bulkHTML = (B.bulk || []).map((g) => {
    const stop = blocked('auto-story-finish')
    const keys = g.list.map((n) => n.slug || n.story).join(',')
    const groupLines = g.groups.map((gr, i) => '  묶음 ' + (i + 1) + (gr.unknown ? ' (파일 목록 없음 — 단독으로)' : '') +
      ': ' + gr.stories.map((x) => x.story + ' ' + x.title).join(' · '))
    const text = instr([
      'auto-story-finish — 아래 스토리를 무인 배치로 마무리해 주세요.',
      '',
      '스토리(' + g.list.length + '건): ' + g.list.map((n) => n.story + ' ' + n.title).join(' / '),
      '',
      '파일 겹침 분석 — 같은 묶음 안은 서로 파일이 겹치지 않으니 워크트리 분리 병렬로,',
      '묶음끼리는 파일이 겹치니 묶음 순서대로 순차로 돌려 주세요.',
    ].concat(groupLines).concat([
      '',
      g.conflicts.length ? '겹침 근거(상위): ' + g.conflicts.slice(0, 4)
        .map((c) => c.a + '×' + c.b + ' ' + c.n + '건(' + c.sample.join(', ') + ')').join(' / ') : '',
      g.unknownCount ? '※ ' + g.unknownCount + '건은 아직 File List 가 없어 겹침을 판정할 수 없습니다 — 단독 순차로 두었습니다.' : '',
      '※ 판정 근거 = 각 스토리 문서의 File List. 진행 기록 문서(_bmad-output/**)는 스토리마다 붙으므로 제외했습니다.',
      '',
      'node "$HOME/.claude/skills/auto-story-finish/auto-story-pipeline.mjs" \\',
      '  --stories "' + keys + '" \\',
      '  --stages "' + g.stages + '"' + (g.force ? ' --force' : ''),
      '',
      '· 검사(qa)가 빨간불이면 그 스토리에서 멈춥니다.',
    ]))
    return '<div class="bulk"><span class="lb">묶어서 한 번에</span>' +
      '<button type="button" class="cp" data-copy="' + esc2(text) + '"' + (stop ? ' disabled' : '') + '>' +
      esc2(g.label) + ' ' + g.list.length + '건 묶음 지시문</button>' +
      '<span class="note">' + (stop
        ? '무인 배치가 도는 중입니다 — 동시 배치 2개는 로그·기록이 섞이므로 끝난 뒤에.'
        : '겹침 분석이 지시문에 함께 들어갑니다.') + '</span></div>' +
      '<div class="grp">' +
      g.groups.map((gr, i) => '<div class="grp-l"><b>묶음 ' + (i + 1) + '</b>' +
        gr.stories.map((x) => '<span class="g' + (gr.unknown ? ' u' : '') + '">' + esc2(x.story) + '</span>').join('') +
        '<span>' + esc2(gr.stories.map((x) => x.title).join(' · ')) + '</span></div>').join('') +
      '<p class="grp-why">같은 묶음 = 서로 파일이 겹치지 않아 <b>동시에 돌려도 안전</b>합니다. 묶음끼리는 겹치므로 순서대로 돕니다.' +
      (g.conflicts.length ? '<br>겹침 예: ' + g.conflicts.slice(0, 3)
        .map((c) => '<code>' + esc2(c.a + '×' + c.b) + '</code> ' + c.n + '건') .join(' · ') : '') +
      (g.unknownCount ? '<br>' + g.unknownCount + '건은 아직 파일 목록이 없어 판정 불가 — 단독으로 뒀습니다.' : '') +
      '</p></div>'
  }).join('')

  // ② 불일치
  const driftHTML = data.drift.length
    ? data.drift.map((d) => {
      const skill = 'bmad-sprint-planning'
      const text = instr([skill, '', '현황판이 잡은 불일치입니다.', d.where + ' — ' + d.msg, '',
        '원천: ' + data.sources.epics + ' · ' + data.sources.sprint])
      return '<div class="it"><div><div class="it-top">' +
        '<span class="tag ' + (d.level === 'high' ? 'wa' : 'bl') + '">' + (d.level === 'high' ? '높음' : '보통') + '</span>' +
        '<span class="it-sid">' + esc2(d.where) + '</span></div>' +
        '<b class="t">' + esc2(d.msg) + '</b>' +
        '</div>' + actHTML(skill, text) + '</div>'
    }).join('')
    : '<div class="none3">에픽 문서와 상태 파일이 일치합니다 — 확인할 불일치 없음</div>'

  const batchHTML = '<div class="batchbar' + (B.batch.running ? ' on' : '') + '"><em></em>' +
    '<b>' + (B.batch.running ? '무인 배치 가동 중' : '무인 배치 멈춤') + '</b>' +
    (B.batch.lastAt ? '<span>마지막 기록 ' + esc2(fmt(B.batch.lastAt)) + '</span>' : '') +
    '<span>' + (B.batch.running
      ? '상태 파일을 쓰는 스킬(스프린트 계획·범위 변경·스토리 생성·배치)은 배치가 끝난 뒤에 — 같이 쓰면 나중 것이 앞을 덮습니다.'
      : '상태 파일을 쓰는 스킬을 실행해도 됩니다.') + '</span>' +
    (B.batch.line ? '<span class="q">' + esc2(B.batch.line.slice(0, 110)) + '</span>' : '') + '</div>'

  const dqHTML = batchHTML +
    '<section class="sec3"><div class="s3-head"><h2>① 다음 진행할 작업</h2>' +
    '<span class="n">' + B.next.length + '건</span>' +
    '<span class="sub">상태값이 곧 할 일입니다 — 리뷰 대기 → 진행 중 → 개발 준비 → 대기 순' +
    (gatedN ? ' · 리뷰 반복 ' + gatedN + '건은 버튼 없이 표시됩니다' : '') + '</span></div>' + bulkHTML + nextHTML + '</section>' +
    '<section class="sec3"><div class="s3-head"><h2>② 불일치</h2>' +
    '<span class="n' + (data.drift.length ? ' warn' : '') + '">' + data.drift.length + '건</span>' +
    '<span class="sub">에픽 문서와 상태 파일이 서로 어긋난 지점</span></div>' + driftHTML + '</section>'

  // 상단 배너 — 엔진 경로 불일치 + 매치 0건 경고(조용한 실패 방어)
  const bannerHTML =
    (data.engineMismatch ? '<div class="warnbar">무인 배치 엔진과 산출물 경로가 다릅니다 — 단계 배지와 배치 중 쓰기 차단이 동작하지 않습니다.</div>' : '') +
    (data.warnings.length ? '<div class="warnbar">' + data.warnings.map(esc2).join('<br>') + '</div>' : '')

  const json = JSON.stringify(data).replace(/</g, '\\u003c')

  const html = '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>개발 현황판</title><style>' + CSS + '</style></head><body><div class="wrap">' +
    '<header class="head"><div class="brand"><b>개발 현황판</b>' +
    '<span class="mono">' + esc2(data.root) + '</span></div>' +
    '<div class="stamp"><div id="live" class="live off"><i></i><span> 확인 중</span></div>' +
    fmt(data.generatedAt) + ' 기준 · 상태 파일 ' + (data.sprintUpdated || '?') + '</div></header>' +

    bannerHTML +

    '<div class="ticker">' +
    '<span class="tk">에픽 <b class="mono">' + data.epics.length + '</b>개</span><span class="dot"></span>' +
    '<span class="tk">스토리 <b class="mono">' + stories.length + '</b></span><span class="dot"></span>' +
    '<span class="tk' + (high ? ' warn' : '') + '">불일치 <b class="mono">' + data.drift.length + '</b></span><span class="dot"></span>' +
    '<span class="tk">다음 작업 <b class="mono">' + B.next.length + '</b>건</span>' +
    '</div>' +

    dqHTML +

    '<section class="board"><div><div class="pct mono">' + pct + '<small>%</small></div>' +
    '<div class="pct-label">전체 진행률 · 완료 ' + done + ' / ' + stories.length + '건</div></div>' +
    '<div><div class="bar">' + bar + '</div><div class="legend">' + legend + '</div></div></section>' +

    '<div class="filters"><div id="chips" style="display:flex;gap:8px;flex-wrap:wrap"></div>' +
    '<input id="q" class="search" type="search" placeholder="스토리 제목·번호·목표로 검색" aria-label="스토리 검색"></div>' +
    '<p class="hint">단계 배지 <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:var(--green);vertical-align:-2px"></span> = 통과 · 왼쪽부터 기획서 작성 → 개발 → 검사(qa) → 적대 리뷰 &nbsp;·&nbsp; <span id="shown"></span></p>' +
    '<div id="epics"></div>' +

    '<footer class="foot">원천 — <code>' + esc2(data.sources.epics) + '</code>(스토리 목록) · ' +
    '<code>' + esc2(data.sources.sprint) + '</code>(상태) · ' +
    '<code>' + esc2(data.sources.state) + '</code>(단계)<br>' +
    '이 화면은 열거나 새로고침(F5)할 때 위 파일에서 다시 만들어집니다. 직접 고치지 마세요 — 다음 갱신 때 덮어써집니다.</footer>' +

    '</div><script>window.__DATA__=' + json + '</script><script>' + JS + '</script></body></html>\n'

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, html, 'utf8')
  return { file: OUT_FILE, version: data.generatedAt, stories: stories.length, epics: data.epics.length, drift: data.drift.length }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = build()
  console.log('생성 완료 — 에픽 ' + r.epics + ' · 스토리 ' + r.stories + ' · 불일치 ' + r.drift + '\n' + r.file)
}
