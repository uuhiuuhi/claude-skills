// report.test.mjs — 비개발자 보고서 (설계 §9-1 report)
//
// 무는 것 넷:
//   ① SPEC §10 의 열 항목이 **언제나 같은 번호·같은 순서**로 있다.
//   ② 시크릿 형태 문자열이 본문·JSON 어디에도 남지 않는다(렌더 직전 재마스킹).
//   ③ 게이트 조건이 다른 두 실행은 수치를 나란히 놓지 않고 「비교 불가」라고 적는다.
//   ④ 확인 못 한 것을 「완료」 자리에 적지 않는다.
// 그리고 마지막에 **실제 jng-os 저장소를 읽기만 해서** 보고서를 한 장 만들어 본다(쓰기 0 을 실측).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, describe, it } from 'node:test'

import { buildBacklog } from './backlog.mjs'
import { diagnose, readProject } from './diagnose.mjs'
import { projectReadiness, taskReadiness } from './readiness.mjs'
import {
  REPORT_SECTIONS, buildReport, compareGateConditions, computeIndicators,
  gateSignature, plain, renderReportJson, renderReportMd,
} from './report.mjs'

// ── 재료 ─────────────────────────────────────────────────────────────────────
const SECRET_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ZmFrZS1zZXJ2aWNlLXJvbGU'
const SECRET_KEY = 'sk-fakefakefakefake0123456789abcd'
/** codex-review-r2 가 잡았고 r3 H1 이 **재발**을 확인한 세 형식 — 진단의 자체 마스커가 전부 놓쳤다. */
const R2_REGRESSION = Object.freeze({
  json: '{"api_key":"JSONSECRET123456"}',
  header: 'Authorization: Bearer TOKENVALUE123456',
  quoted: 'PRIVATE_KEY="alpha beta gamma secret"',
})
const R2_VALUES = Object.freeze(['JSONSECRET123456', 'TOKENVALUE123456', 'alpha beta gamma secret'])

const diagnosis = (over = {}) => ({
  schema: 'night-batch-ops/diagnosis/1', at: '2026-09-03T02:00:00.000Z', root: 'C:/tmp/fake', round: 1,
  gates: { qa: { exit: 0, ms: 42000, available: true }, build: { exit: 0, ms: 9000, available: true } },
  stories: [
    { key: '1-1-정상-스토리', verdict: 'verified-done', declared: 'done' },
    { key: '1-2-파일목록-부재', verdict: 'not-verified', declared: 'done' },
    { key: '2-1-패치-열림', verdict: 'partial', declared: 'in-progress' },
  ],
  findings: [
    { id: 'F1', kind: 'open-patch', severity: 'high', tier: 4, story: '2-1-패치-열림', path: 'src/feature/c.ts', why: '열린 지적 2건', userImpact: '이 스토리는 아직 사용자가 쓸 수 있는 상태가 아니다' },
  ],
  counts: { storiesTotal: 3, declaredDone: 2, verifiedDone: 1, partial: 1, notVerified: 1, findingsTotal: 1, findings: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0, 7: 0 } },
  notVerified: [{ what: '보안 게이트', why: 'n/a(package.json scripts 에 security 없음) — 없는 것은 GREEN 이 아니다' }],
  ...over,
})

const backlog = () => ({
  schema: 'night-batch-ops/backlog/1', at: '2026-09-03T02:00:00.000Z', round: 1,
  items: [{ id: 'W-1', title: '2-1-패치-열림 — 리뷰에서 지적된 것 회수', purpose: '검토자가 찾은 문제를 실제로 고친다', userImpact: '이 스토리는 아직 사용자가 쓸 수 있는 상태가 아니다', tier: 4, state: 'open', autoFixAllowed: true, files: ['src/feature/c.ts'] }],
  closed: [{ id: 'W-0', title: '1-1-정상-스토리 — 꺼진 검사 되살리기' }],
  blocked: [], byTier: {}, counts: { total: 1, open: 1, blocked: 0, parallelOk: 1 },
})

const manifest = (over = {}) => ({
  schema: 'auto-story-finish/verification/1', story: '1-1-정상-스토리',
  workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'codex', model: 'gpt-5' } },
  checks: { qa: 'pass', typecheck: 'pass', lint: 'pass', unit: 'pass', build: 'pass', security: 'not-required', performance: 'not-required', integration: 'pass' },
  integrity: [], repair: { attempts: 0, signatures: [] },
  review: { provider: 'codex', model: 'gpt-5', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 }, readEvidence: 2 },
  ...over,
})

const metricsSummary = (over = {}) => ({
  schema: 'night-batch-ops/metrics/1', workers: 2, wallMs: 3_600_000, serialMs: 6_000_000,
  occupancyMs: 5_000_000, idleMs: 2_200_000, idleRatio: 0.3055, parallelEfficiency: 0.83,
  stories: [{ story: '1-1-정상-스토리', ms: 1_800_000, stages: 3, exit: 0 }, { story: '2-1-패치-열림', ms: 2_400_000, stages: 4, exit: 1 }],
  p50Ms: 1_800_000, p95Ms: 2_400_000, retries: { repairRounds: 1, providerSwitches: 0 },
  modelCalls: [{ provider: 'claude', model: 'opus', calls: 5, tokens: 0 }], tokens: 0,
  qualityGate: { passed: true, why: 'qa GREEN · 리뷰 high 0 · 통합 pass' },
  ...over,
})

const build = (over = {}) => buildReport({
  run: { id: 'run-1', root: 'C:/Projects/가짜프로젝트', startedAt: '2026-09-03T01:00:00.000Z', endedAt: '2026-09-03T02:00:00.000Z', rounds: 2 },
  diagnoses: [diagnosis(), diagnosis()],
  backlog: backlog(),
  readiness: projectReadiness({ diagnosis: diagnosis(), manifests: [manifest()], backlog: backlog() }),
  metrics: metricsSummary(),
  manifests: [manifest()],
  questions: [],
  ...over,
})

const sectionText = (md, n) => {
  const parts = md.split(/^## (\d+)\. /m)
  for (let i = 1; i < parts.length; i += 2) if (Number(parts[i]) === n) return parts[i + 1]
  return ''
}

// ── ① 항목 순서 ──────────────────────────────────────────────────────────────
describe('report — 항목 열 개와 순서', () => {
  it('SPEC §10 의 열 항목이 정해진 번호·순서로 전부 있다', () => {
    assert.deepEqual(REPORT_SECTIONS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(REPORT_SECTIONS.map((s) => s.id), ['capabilities', 'completed', 'gates', 'flows', 'autofix', 'time', 'risks', 'notVerified', 'deployable', 'decisions'])

    const md = renderReportMd(build())
    const heads = [...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]])
    assert.equal(heads.length, 10)
    assert.deepEqual(heads.map((h) => h[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const [n, title] of heads) assert.equal(title, REPORT_SECTIONS.find((s) => s.n === n).title)
    // 어느 항목도 빈 채로 남지 않는다
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.ok(sectionText(md, n).trim().length > 0, `${n} 항목이 비었다`)
  })

  it('첫 화면(제목 바로 아래)에 배포 가능 여부와 모자란 것이 온다', () => {
    const md = renderReportMd(build())
    const head = md.split(/^## 1\. /m)[0]
    assert.match(head, /배포/)
    assert.ok(head.indexOf('##') < md.indexOf('## 1.'), '결론이 첫 항목보다 뒤에 있다')
    assert.match(head, /확인|모자란|배포/)
  })
})

// ── ② 마스킹 ─────────────────────────────────────────────────────────────────
describe('report — 시크릿 재마스킹', () => {
  it('진단·백로그를 타고 들어온 시크릿 형태 문자열이 본문과 JSON 어디에도 남지 않는다', () => {
    const d = diagnosis({
      notVerified: [{ what: `열쇠 ${SECRET_KEY}`, why: `토큰 ${SECRET_JWT}.rest 가 로그에 있었다` }],
      findings: [{ id: 'F9', kind: 'secret-value', severity: 'high', tier: 1, path: 'src/x.ts', why: `열쇠 ${SECRET_KEY}`, userImpact: '열쇠가 새면 남이 우리 데이터를 읽는다' }],
    })
    const model = build({ diagnoses: [d], readiness: projectReadiness({ diagnosis: d, manifests: [manifest()], backlog: backlog() }) })
    const md = renderReportMd(model)
    const json = JSON.stringify(renderReportJson(model))

    assert.ok(!md.includes(SECRET_KEY), '본문에 열쇠 원문이 남았다')
    assert.ok(!md.includes(SECRET_JWT), '본문에 토큰 원문이 남았다')
    assert.ok(!json.includes(SECRET_KEY), 'JSON 에 열쇠 원문이 남았다')
    assert.ok(!json.includes(SECRET_JWT), 'JSON 에 토큰 원문이 남았다')
    assert.match(md, /\*\*\*REDACTED\*\*\*/)
  })

  it('R2 회귀 3형식(JSON 키·Authorization 헤더·인용값)도 본문·JSON 어디에도 원문이 없다', () => {
    const d = diagnosis({
      notVerified: [{ what: `설정 ${R2_REGRESSION.json}`, why: `요청에 ${R2_REGRESSION.header} 가 실렸다` }],
      findings: [{ id: 'F8', kind: 'secret-value', severity: 'high', tier: 1, path: 'src/y.ts', why: `소스에 ${R2_REGRESSION.quoted}`, userImpact: '열쇠가 새면 남이 우리 데이터를 읽는다' }],
    })
    const model = build({ diagnoses: [d], readiness: projectReadiness({ diagnosis: d, manifests: [manifest()], backlog: backlog() }) })
    const md = renderReportMd(model)
    const json = JSON.stringify(renderReportJson(model))
    for (const v of R2_VALUES) {
      assert.ok(!md.includes(v), `본문에 R2 회귀 원문이 남았다: ${v}`)
      assert.ok(!json.includes(v), `JSON 에 R2 회귀 원문이 남았다: ${v}`)
    }
  })
})

// ── ③ 비교 불가 ──────────────────────────────────────────────────────────────
describe('report — 게이트 조건이 다른 실행', () => {
  it('돌린 게이트가 다르면 「비교 불가」라고 적고 수치를 나란히 놓지 않는다', () => {
    const gatesNow = { qa: { available: true, exit: 0 }, build: { available: true, exit: 0 } }
    const gatesBase = { qa: { available: true, exit: 0 } }
    assert.equal(compareGateConditions(gatesBase, gatesNow).same, false)
    assert.equal(gateSignature(gatesNow), 'build,qa')

    const md = renderReportMd(build({ metrics: { summary: metricsSummary(), baseline: metricsSummary({ wallMs: 7_200_000 }), gates: gatesNow, baselineGates: gatesBase } }))
    assert.match(sectionText(md, 6), /비교 불가/)
  })

  it('게이트 조건이 같고 두 실행 다 품질을 통과했으면 비교값이 나온다', () => {
    const g = { qa: { available: true, exit: 0 } }
    const model = build({ metrics: { summary: metricsSummary(), baseline: metricsSummary({ wallMs: 7_200_000 }), gates: g, baselineGates: g } })
    assert.equal(model.comparison.comparable, true)
    assert.ok(model.comparison.rows.length > 0)
    assert.ok(!/비교 불가/.test(sectionText(renderReportMd(model), 6)))
  })

  it('한쪽이라도 품질 게이트를 통과하지 못했으면 게이트 조건이 같아도 비교하지 않는다', () => {
    const g = { qa: { available: true, exit: 0 } }
    const bad = metricsSummary({ qualityGate: { passed: false, why: 'qa RED(exit 1)' } })
    const model = build({ metrics: { summary: metricsSummary(), baseline: bad, gates: g, baselineGates: g } })
    assert.equal(model.comparison.comparable, false)
    assert.match(renderReportMd(model), /비교 불가/)
  })
})

// ── ④ 확인 못 한 것 ──────────────────────────────────────────────────────────
describe('report — 확인 못 한 것을 완료로 적지 않는다', () => {
  it('문서에 done 이라 적힌 not-verified 스토리는 ②「끝낸 것」이 아니라 ⑧「확인하지 못한 것」에 있다', () => {
    const md = renderReportMd(build())
    const done = sectionText(md, 2)
    const nv = sectionText(md, 8)
    assert.ok(!done.includes('1-2-파일목록-부재'), '확인 못 한 스토리를 완료 자리에 적었다')
    assert.ok(nv.includes('1-2-파일목록-부재'), '확인 못 한 스토리가 미확인 자리에 없다')
    assert.match(nv, /통과가 아니라/)
    assert.ok(done.includes('1-1-정상-스토리'))
  })

  it('①「할 수 있는 것」에도 검사로 확인된 것만 들어간다', () => {
    const md = renderReportMd(build())
    const cap = sectionText(md, 1)
    assert.match(cap, /실제로 되는 것 1개/)
    assert.match(cap, /확인 못 한 것 1개/)
  })

  it('화면을 직접 열어 본 흐름이 없으면 ④에 그렇게 적고 ⑧에도 남긴다', () => {
    const md = renderReportMd(build())
    assert.match(sectionText(md, 4), /화면을 직접 열어/)
    assert.match(sectionText(md, 8), /사용자 흐름/)
  })

  it('③은 「명령이 없다」와 「이번에 안 돌렸다」를 구분해 적고, 둘 다 통과로 적지 않는다', () => {
    const noRun = sectionText(renderReportMd(build({ diagnoses: [diagnosis({ gates: {} })] })), 3)
    assert.match(noRun, /이번에 돌리지 않았습니다/)
    assert.ok(!/기본 검사[^\n]*\): 통과/.test(noRun), '안 돌린 검사를 통과로 적었다')

    const noScript = sectionText(renderReportMd(build({ diagnoses: [diagnosis({ gates: { qa: { available: false, exit: null }, build: { available: false, exit: null } } })] })), 3)
    assert.match(noScript, /해당 검사 명령이 없습니다/)

    const red = sectionText(renderReportMd(build({ diagnoses: [diagnosis({ gates: { qa: { available: true, exit: 1, ms: 5000 }, build: { available: true, exit: 0, ms: 1000 } } })] })), 3)
    assert.match(red, /기본 검사[^\n]*\): 실패/)
  })

  it('계측이 없으면 시간을 「0초」라고 적지 않고 「기록 없음」이라 적는다', () => {
    const md = renderReportMd(build({ metrics: null, manifests: [] }))
    assert.match(md, /걸린 시간 기록 없음/)
    assert.ok(!/걸린 시간 0초/.test(md), '없는 수치를 0으로 적었다')
  })

  it('판정이 ready 가 아니면 ⑨에 「배포하면 안 된다/확인 못 했다」가 오고 막는 것이 열거된다', () => {
    const model = build()
    const md = renderReportMd(model)
    assert.notEqual(model.verdict, 'ready')
    assert.match(sectionText(md, 9), /배포/)
    assert.match(sectionText(md, 9), /승인/)
  })
})

// ── 비개발자 언어 밀도 ───────────────────────────────────────────────────────
describe('report — 비개발자 언어', () => {
  it('본문에 모듈 파일명·경로·함수 호출 표기가 나오지 않는다', () => {
    const md = renderReportMd(build())
    assert.equal((md.match(/\.mjs\b/g) ?? []).length, 0, '모듈 파일명이 본문에 있다')
    assert.equal((md.match(/\b\w+\(\)/g) ?? []).length, 0, '함수 호출 표기가 본문에 있다')
    const paths = md.match(/(?:[A-Za-z0-9_.\-]+\/){2,}[A-Za-z0-9_.\-]+|\b[A-Za-z0-9_.\-]+\.(?:ts|tsx|js|jsx|json|ya?ml|sql)\b/g) ?? []
    assert.ok(paths.length <= 2, `본문에 경로가 ${paths.length}건 남았다: ${paths.slice(0, 5).join(', ')}`)
  })

  it('plain: 경로·확장자·함수 표기를 지우고 기술 약어를 쉬운 말로 바꾼다', () => {
    assert.equal(plain('`src/features/a/b.ts` 를 고쳤다'), '해당 파일 를 고쳤다')
    assert.equal(plain('n/a(package.json scripts 에 security 없음)'), '이 프로젝트에 security 검사 명령이 없음')
    assert.equal(plain('readProject() 가 돈다'), '해당 기능 가 돈다')
    assert.equal(plain('열린 지적 2건'), '열린 지적 2건')
  })
})

// ── 지표 7종 ─────────────────────────────────────────────────────────────────
describe('report — 지표 7종', () => {
  it('계측이 첫 시도 통과율·반복 실패·절약을 주지 않으면 직접 세고 「근사」라고 적는다', () => {
    const ind = computeIndicators({ metrics: metricsSummary(), manifests: [manifest(), manifest({ repair: { attempts: 2, signatures: ['s1', 's1', 's1'] }, checks: { ...manifest().checks, qa: 'fail' } })] })
    assert.equal(ind.firstPass.total, 2)
    assert.equal(ind.firstPass.ok, 1)
    assert.equal(ind.firstPass.approx, true)
    assert.equal(ind.autoFix.repeatedFailures, 1) // 같은 원인 3회
    assert.equal(ind.saving.ms, 2_400_000) // 직렬 합 − 벽시계
    assert.equal(ind.saving.approx, true)
    assert.equal(ind.integration.pass, 2)
    assert.equal(ind.integration.failRate, 0)
  })

  it('표에 일곱 지표가 전부 있고, 값이 없으면 「확인 못 함」이라 적는다', () => {
    const md = renderReportMd(build())
    const t = sectionText(md, 6)
    for (const label of ['전체 걸린 시간', '동시 진행 정도', '한 번에 통과한 비율', '검토에서 나온 지적', '자동으로 고친 횟수', '합치기 실패율', '아낀 시간']) {
      assert.ok(t.includes(label), `${label} 행이 없다`)
    }
    const empty = renderReportMd(build({ metrics: null, manifests: [] }))
    assert.match(sectionText(empty, 6), /확인 못 함/)
  })
})

// ── 실제 저장소 읽기 전용 실측 ───────────────────────────────────────────────
describe('report — 실제 jng-os 저장소(읽기 전용)', { skip: existsSync('C:/Projects/jng-os') ? false : 'jng-os 저장소 없음' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'report-live-'))
  after(() => rmSync(out, { recursive: true, force: true }))
  const porcelain = () => spawnSync('git', ['-C', 'C:/Projects/jng-os', 'status', '--porcelain'], { encoding: 'utf8', shell: false }).stdout ?? ''

  it('실제 프로젝트를 읽어 진단→백로그→판정→보고서까지 돌리고, 그 저장소에는 한 글자도 쓰지 않는다', () => {
    const before = porcelain()

    const snap = readProject('C:/Projects/jng-os')
    const d = diagnose(snap, { gates: {} }) // --no-gates: 실행 0
    const bl = buildBacklog({ diagnosis: d, snapshot: snap })
    const pr = projectReadiness({ diagnosis: d, manifests: [], backlog: bl })
    const model = buildReport({ run: { id: 'live', root: snap.root, rounds: 1 }, diagnoses: [d], backlog: bl, readiness: pr, metrics: null, manifests: [] })
    const md = renderReportMd(model)

    writeFileSync(join(out, 'report.md'), md, 'utf8')
    writeFileSync(join(out, 'readiness.json'), JSON.stringify(pr, null, 2), 'utf8')

    assert.equal(porcelain(), before, '대상 저장소가 바뀌었다 — 읽기 전용 위반')

    // 판정은 not-ready 이고, 열 항목이 전부 있고, 시크릿은 없다
    assert.equal(pr.verdict, 'not-ready')
    assert.equal([...md.matchAll(/^## \d+\. /gm)].length, 10)
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(md), '보고서에 열쇠 원문이 있다')
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(md), '보고서에 토큰 원문이 있다')
    assert.ok(md.length > 800, '보고서가 너무 짧다')
    assert.ok(readFileSync(join(out, 'report.md'), 'utf8').length === md.length)

    // 사람이 읽을 요약을 남긴다(실측 보고용)
    console.log(`[실측] 스토리 ${d.counts.storiesTotal} · 문서상 완료 ${d.counts.declaredDone} · 검사로 확인된 완료 ${d.counts.verifiedDone} · 지적 ${d.counts.findingsTotal}`)
    console.log(`[실측] 판정 ${pr.verdict} — 미달 ${pr.blockers.map((b) => b.id).join(',')} · 확인 못 함 ${pr.notVerified.map((n) => n.criterion).join(',')}`)
    console.log(`[실측] 백로그 ${bl.counts.total}건(봉쇄 ${bl.counts.blocked}) · 보고서 ${md.length}자`)
  })
})
