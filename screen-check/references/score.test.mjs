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

test('보기 전용 — 머리줄(방식·대상·단계·차단·건너뜀)과 비로그인 경고가 총점보다 먼저 뜬다', () => {
  const md = report({ ...base, view: { host: 'app.example.com', tier: 'anonymous', blockedWrites: [{ method: 'POST', path: '/rest/v1/rpc/x', reason: 'RPC x' }], skippedControls: [] }, notAssessable: ['success', 'guard', 'ac', 'deny', 'a11y'] })
  assert.match(md, /방식: 보기 전용\*\* · 대상 `app\.example\.com` · 단계: 비로그인 · 차단된 쓰기 시도 1건 · 건너뛴 조작 0개/)
  assert.match(md, /로그인 안쪽 화면은 확인하지 못함/)
  assert.ok(md.indexOf('방식: 보기 전용') < md.indexOf('총점'))
})

test('보기 전용 — 판정 불가 항목은 체크가 있어도 점수 없이 「—」 · 합계 제외', () => {
  const md = report({ ...base, results: [...base.results, { cat: 'success', name: 'S', ok: true }], view: { host: 'h', tier: 'view-login', blockedWrites: [], skippedControls: [{ where: '/t', name: '저장', reason: 'x' }] }, notAssessable: ['success', 'guard'] })
  assert.match(md, /\| 2 \| 성공 경로 실증 \| — \| 판정 불가\(보기 전용 방식\)/)
  assert.match(md, /\*\*총점 10 \/ 10\*\*/)
  assert.ok(!md.includes('로그인 안쪽 화면은 확인하지 못함'))
  assert.match(md, /건너뛴 조작\*\*: \/t 「저장」/)
})

test('notRun 이 없는 옛 결과 파일도 그대로 렌더된다', () => {
  const md = report(base)
  assert.match(md, /\*\*총점 10 \/ 10\*\*/)
  assert.ok(!md.includes('⚠️'))
})
