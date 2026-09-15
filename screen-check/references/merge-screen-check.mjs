// screen-check 취합기(v0.2 · 파티 판정 4항) — 벌별 results JSON N개를 읽어
//   ① 벌 × (고유 적중 / 중복 / 판정 불일치 / 오탐) 표  ② 합산 채점표(항목 = 벌별 통과율 평균)  ③ finding 목록
// 을 마크다운으로 낸다. 「적중」 = ok:false 항목. 같은 finding 판정 = cat 같고 name 정규화(공백·기호 제거) 뒤 같거나
// 한쪽이 다른 쪽을 포함. 오탐은 triage.json({ "<name>": "false-positive"|"script"|"defect"|"human-gate" })이 있을 때만 센다.
// 사용: node merge-screen-check.mjs <results-*.json ...> [--triage triage.json] [--out merged.md] [--title "배치 1 Epic 1"]
import { readFileSync, writeFileSync } from 'node:fs'
import { RUBRIC } from './score.mjs'

// 역할 접두([engineer /path] → [* /path])와 뷰포트(@390)는 같은 finding 으로 접는다 — 벌 A 가 6역할 × 3폭으로 같은 결함을 반복해서 내기 때문
const norm = (s) => String(s).toLowerCase().replace(/\[(engineer|admin|team_lead|sales|office|executive)\s/g, '[').replace(/@\d{3,4}/g, '').replace(/[\s·・\-–—_:()\[\]「」『』'"`,.]/g, '')
const same = (a, b) => a.cat === b.cat && (norm(a.name) === norm(b.name) || norm(a.name).includes(norm(b.name)) || norm(b.name).includes(norm(a.name)))

export function merge(files, { triage = {} } = {}) {
  const runs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) }))
  const all = runs.flatMap((r) => (r.results ?? []).map((x) => ({ ...x, source: x.source ?? r.source ?? '?' })))
  const findings = all.filter((x) => !x.ok)
  const sources = [...new Set(all.map((x) => x.source))]
  // finding 군집 — 같은 finding 을 여러 벌이 냈으면 하나로 묶는다
  const clusters = []
  for (const f of findings) {
    const c = clusters.find((k) => k.items.some((i) => same(i, f)))
    if (c) c.items.push(f); else clusters.push({ items: [f] })
  }
  // 판정 불일치 — 한 벌은 실패, 다른 벌은 같은 이름을 통과로 냈다
  for (const c of clusters) {
    c.name = c.items[0].name; c.cat = c.items[0].cat
    c.sources = [...new Set(c.items.map((i) => i.source))]
    c.disagree = [...new Set(all.filter((x) => x.ok && c.items.some((i) => same(i, x))).map((x) => x.source))]
    c.triage = triage[c.name] ?? c.items.map((i) => triage[i.name]).find(Boolean) ?? c.items.map((i) => i.triage).find(Boolean) ?? ''   // 벌이 결과 항목에 triage 를 직접 적어도 받는다
  }
  const perSource = sources.map((s) => {
    const mine = clusters.filter((c) => c.sources.includes(s))
    return {
      source: s,
      checks: all.filter((x) => x.source === s).length,
      findings: mine.length,
      unique: mine.filter((c) => c.sources.length === 1 && c.triage !== 'false-positive' && c.triage !== 'script').length,
      shared: mine.filter((c) => c.sources.length > 1).length,
      disagree: mine.filter((c) => c.disagree.length > 0).length,
      falsePos: mine.filter((c) => c.triage === 'false-positive' || c.triage === 'script').length,
      defects: mine.filter((c) => c.triage === 'defect').length,
    }
  })
  // 합산 채점 — 항목 = 벌별 통과율 평균(측정한 벌만) · 수동 점수는 벌별 하향으로 반영
  const rows = RUBRIC.map(([cat, label]) => {
    const per = runs.map((r) => {
      const cs = (r.results ?? []).filter((x) => x.cat === cat)
      const man = r.manual?.[cat]
      if (!cs.length && !man) return null
      let s = cs.length ? Math.round((cs.filter((x) => x.ok).length / cs.length) * 10) : man.score
      if (cs.length && man && man.score < s) s = man.score
      return { source: r.source ?? '?', s, n: cs.length }
    }).filter(Boolean)
    const avg = per.length ? Math.round(per.reduce((a, p) => a + p.s, 0) / per.length) : null
    return { cat, label, avg, per }
  })
  const counted = rows.filter((r) => r.avg !== null)
  const total = counted.reduce((a, r) => a + r.avg, 0)
  return { runs, sources, clusters, perSource, rows, total, max: counted.length * 10, checks: all.length, pass: all.filter((x) => x.ok).length, unmeasured: [...new Set(runs.flatMap((r) => r.unmeasured ?? []))], leftovers: [...new Set(runs.flatMap((r) => r.leftovers ?? []))] }
}

export function renderMerged(m, title = '') {
  const L = []
  L.push(`## screen-check 취합 — ${title} (${(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` })()})`, '')
  L.push(`**합산 총점 ${m.total} / ${m.max}** · 자동 체크 ${m.checks}건 · 통과 ${m.pass}건 · finding 군집 ${m.clusters.length}건 · 벌 = ${m.sources.join(' · ')}`, '')
  L.push('| # | 평가 항목 | 합산 | 벌별 |', '|---|---|---|---|')
  m.rows.forEach((r, i) => L.push(`| ${i + 1} | ${r.label} | ${r.avg === null ? '—' : `**${r.avg}** / 10`} | ${r.per.map((p) => `${p.source}=${p.s}${p.n ? `(${p.n})` : '(수동)'}`).join(' · ') || '미측정'} |`))
  L.push('', '### 벌별 적중 비교(파티 판정 5항 — 고유 적중 0 인 벌은 제거 후보)', '', '| 벌 | 체크 수 | finding | 고유 적중 | 중복 | 판정 불일치 | 오탐·스크립트 | 확정 결함 |', '|---|---|---|---|---|---|---|---|')
  m.perSource.forEach((p) => L.push(`| ${p.source} | ${p.checks} | ${p.findings} | **${p.unique}** | ${p.shared} | ${p.disagree} | ${p.falsePos} | ${p.defects} |`))
  L.push('', '### finding 목록(군집 · 벌 · triage)', '', '| # | 항목 | 이름 | 벌 | 통과로 본 벌 | triage | 근거 |', '|---|---|---|---|---|---|---|')
  m.clusters.forEach((c, i) => L.push(`| ${i + 1} | ${c.cat} | ${c.name.replace(/\|/g, '/')} | ${c.sources.join('+')} | ${c.disagree.join('+') || '—'} | ${c.triage || '미분류'} | ${(c.items[0].detail ?? '').replace(/\|/g, '/').slice(0, 120)} |`))
  if (m.unmeasured.length) L.push('', '- **미측정**: ' + m.unmeasured.join(' · '))
  if (m.leftovers.length) L.push('- **잔여물(개발 DB)**: ' + m.leftovers.join(' · '))
  return L.join('\n')
}

if (process.argv[1] && /merge-screen-check\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i > 0 || i === 0 ? args.splice(i, 2)[1] : undefined }
  const triageFile = opt('--triage'); const out = opt('--out'); const title = opt('--title') ?? ''
  const files = args.filter((a) => !a.startsWith('--'))
  if (!files.length) { console.error('usage: node merge-screen-check.mjs <results-*.json ...> [--triage triage.json] [--out merged.md] [--title ...]'); process.exit(2) }
  const triage = triageFile ? JSON.parse(readFileSync(triageFile, 'utf8')) : {}
  const md = renderMerged(merge(files, { triage }), title)
  if (out) writeFileSync(out, md + '\n', 'utf8')
  console.log(md)
}
