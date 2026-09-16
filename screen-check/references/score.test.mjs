// 실행: node --test references/score.test.mjs
// 고정하는 것 = 「중단·미실행이 보고서 머리에 뜬다」(2026-09-17 T3 §6-3 ① — 반쪽 실행이 정상 결과로 읽힌 사고).
import test from 'node:test'
import assert from 'node:assert/strict'
import { report } from './score.mjs'

const base = { story: 'epic-5', when: '2026-09-17 06:00', results: [{ cat: 'ac', name: 'A', ok: true, detail: '' }], manual: {}, unmeasured: [], leftovers: [] }

test('중단(fatal) 이면 총점보다 먼저 ⚠️ 중단 + 미실행 건수가 뜬다', () => {
  const md = report({ ...base, fatal: { role: 'executive', step: 'executive @390 /home', message: 'Target closed' }, notRun: { scenarios: 19, scenariosPlanned: 19, roles: ['executive'] } })
  const head = md.split('\n').slice(0, 4).join('\n')
  assert.match(head, /⚠️ \*\*중단 — 미실행 시나리오 19건\*\*/)
  assert.match(head, /executive @390 \/home/)
  assert.ok(md.indexOf('중단') < md.indexOf('총점'), '중단 배너가 총점보다 앞에 와야 한다')
})

test('정상 종료라도 미실행이 남으면 경고가 뜬다', () => {
  const md = report({ ...base, notRun: { scenarios: 2, scenariosPlanned: 19, roles: [] } })
  assert.match(md, /⚠️ \*\*미실행 시나리오 2건\*\*\(계획 19건\)/)
})

test('전건 실행이면 배너 없이 실행 계수만 적는다', () => {
  const md = report({ ...base, notRun: { scenarios: 0, scenariosPlanned: 19, roles: [] } })
  assert.ok(!md.includes('⚠️'), '미실행 0건에 경고를 띄우지 않는다')
  assert.match(md, /시나리오 19\/19 실행\(미실행 0건\)/)
})

test('notRun 이 없는 옛 결과 파일도 그대로 렌더된다', () => {
  const md = report(base)
  assert.match(md, /\*\*총점 10 \/ 10\*\*/)
  assert.ok(!md.includes('⚠️'))
})
