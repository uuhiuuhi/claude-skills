// screen-check 채점기 — check() 결과(JSON)를 평가 항목 10개(각 10점)로 접어 마크다운 보고서를 낸다.
// 사용: node score.mjs <results.json> [--out report.md]
// results.json = { story, when, results: [{ name, ok, detail, cat }], manual: { <cat>: { score, why } }, unmeasured: ["..."] , leftovers: ["..."] }
import { readFileSync, writeFileSync } from 'node:fs'

/** 평가 항목 — cat 키 · 이름 · 무엇을 보는가. 자동 채점 = 그 cat 의 통과율 × 10(반올림). 자동 체크가 0건이면 manual 점수를, 그것도 없으면 「—(미측정)」. */
export const RUBRIC = [
  ['ac',       'AC 충족',            '스토리 수용 기준을 화면에서 하나씩 실측한 통과율'],
  ['success',  '성공 경로 실증',      '핵심 쓰기 경로(접수·승인·저장)가 실제 DB 왕복으로 성공하는가'],
  ['deny',     '권한·거부 경로',      '비권한 진입 3요소 안내 · 서버 거절 문구가 화면에 바르게 서는가'],
  ['copy',     '문구 규율',           '한글 · 무엇/왜/어떻게 · 원시 에러·영문 식별자·표 이름 노출 0'],
  ['responsive','반응형',             '1440 · 1024 · 390 렌더 · 모바일 열람 전용 등 뷰포트 계약'],
  ['guard',    '상호작용 안전장치',   '잠금(disabled) · 확인 · 되돌리기 경로가 실제로 동작하는가'],
  ['mockup',   '목업 대조',           '승인 목업과 구조·문안 일치(나란히 비교 · 확정 결정 반영)'],
  ['a11y',     '접근성 기본',         'role/label · 키보드(Tab·Esc) · 44px 터치 타깃'],
  ['errors',   '콘솔·네트워크 오류',  'pageerror 0 · 예상 밖 4xx/5xx 0'],
  ['honesty',  '정직성·잔여물',       '미측정 항목·프로브 잔여물·타이밍 vs 결함 구분이 보고에 적혔는가'],
]

export function score(data) {
  const rows = []
  let total = 0, counted = 0
  for (const [cat, label, what] of RUBRIC) {
    const checks = (data.results ?? []).filter((r) => r.cat === cat)
    const manual = data.manual?.[cat]
    let s = null, why = ''
    if (checks.length) {
      const pass = checks.filter((r) => r.ok).length
      s = Math.round((pass / checks.length) * 10)
      why = `자동 ${pass}/${checks.length}` + (checks.filter((r) => !r.ok).length ? ` · 실패: ${checks.filter((r) => !r.ok).map((r) => r.name).join(' · ')}` : '')
      if (manual && manual.score < s) { s = manual.score; why += ` · 수동 하향: ${manual.why}` }
    } else if (manual) { s = manual.score; why = `수동: ${manual.why}` }
    if (s !== null) { total += s; counted += 1 }
    rows.push({ cat, label, what, score: s, why })
  }
  return { rows, total, counted, max: counted * 10 }
}

export function report(data) {
  const { rows, total, counted, max } = score(data)
  const lines = [
    `## 화면 확인 평가 — ${data.story ?? ''} (${data.when ?? ''})`,
    '',
    `**총점 ${total} / ${max}** (평가 항목 ${counted}개 × 10점 · 미측정 항목은 합계에서 제외)`,
    '',
    '| # | 평가 항목 | 점수 | 근거 |',
    '|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${r.label} | ${r.score === null ? '—' : `**${r.score}** / 10`} | ${r.score === null ? '미측정 — ' + r.what : r.why} |`),
    '',
    `- 자동 체크 ${(data.results ?? []).length}건 · 통과 ${(data.results ?? []).filter((r) => r.ok).length}건`,
    ...(data.unmeasured?.length ? ['- **미측정**: ' + data.unmeasured.join(' · ')] : []),
    ...(data.leftovers?.length ? ['- **잔여물(개발 DB)**: ' + data.leftovers.join(' · ')] : []),
    ...(data.screenshots ? [`- 스크린샷: ${data.screenshots}`] : []),
  ]
  return lines.join('\n')
}

if (process.argv[1] && /score\.mjs$/.test(process.argv[1])) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node score.mjs <results.json> [--out report.md]'); process.exit(2) }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const md = report(data)
  const outIdx = process.argv.indexOf('--out')
  if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], md + '\n', 'utf8')
  console.log(md)
}
