// dev-status 파서 — 산출물 8종 × 정상 / 부재 / 손상 (설계 §7.1)
// 스텁이 아니라 **실제 파일**을 임시 폴더에 만들고 실제 fs 로 읽는다.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assignByStory, collectBatchSources, findAutofinishDir, lastNightManifests, nightKey,
  parseAssignHistory, parseBatchManifest, parseEvidenceSummary, parseInbox, parseMetrics,
  parseMetricsHistory, parseQueue, parseReadiness, parseVerification, resolveStateDir, slotHeartbeat,
} from './batch-sources.mjs'

let dir
before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-src-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })

const put = (name, text) => {
  const p = join(dir, name)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text, 'utf8')
  return p
}

const MANIFEST = {
  schema: 'night-batch-ops/batch-manifest/1',
  batchId: 'AUTO-1', label: 'AUTO-1: 2-16 · 2-18 (회수)', branch: 'auto/2026-09-02',
  at: '2026-09-03T01:12:00.000Z', mode: 'parallel', stories: ['2-16', '2-18'],
  stages: ['dev', 'review'], workers: 2,
  landing: [{ order: 1, story: '2-16', head: 'aaa' }, { order: 2, story: '2-18', head: 'bbb' }],
  failed: [], integration: { result: 'pass', qaExit: 0, landingBase: 'base1', at: '…', ran: true },
  pushed: true, worst: 0,
}

const VERIFICATION = {
  schema: 'auto-story-finish/verification/1',
  story: '2-18', generatedAt: '2026-09-03T02:00:00.000Z', branch: 'auto/2026-09-02', commit: 'ccc',
  workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'codex', model: 'gpt-5.6-sol' } },
  checks: { qa: 'pass', typecheck: 'pass', security: 'required-missing(스크립트 없음)', integration: 'unknown(…)' },
  review: { provider: 'codex', model: 'gpt-5.6-sol', result: 'findings', counts: { high: 1, medium: 3, patch: 2, decision: 0 }, readEvidence: 3 },
  integrity: [], repair: { attempts: 1, signatures: [], exhausted: false },
}

describe('① 배치 매니페스트', () => {
  test('정상 — 정규화해서 읽는다', () => {
    const p = put('batch-AUTO-1-manifest.json', JSON.stringify(MANIFEST))
    const r = parseBatchManifest(p)
    assert.equal(r.error, null)
    assert.equal(r.value.batchId, 'AUTO-1')
    assert.deepEqual(r.value.stories, ['2-16', '2-18'])
    assert.equal(r.value.integration.result, 'pass')
    assert.equal(r.value.workers, 2)
    assert.equal(r.value.landing.length, 2)
  })
  test('부재 — kind=missing', () => {
    const r = parseBatchManifest(join(dir, 'nope.json'))
    assert.equal(r.value, null)
    assert.equal(r.error.kind, 'missing')
    assert.match(r.error.why, /파일이 없습니다/)
  })
  test('손상 — kind=broken + 원문 경로', () => {
    const p = put('broken-manifest.json', '{"schema": "night-batch-ops/batch-manifest/1", ')
    const r = parseBatchManifest(p)
    assert.equal(r.error.kind, 'broken')
    assert.equal(r.error.file, p)
  })
  test('예상 밖 schema — 추측 렌더 대신 kind=schema', () => {
    const p = put('other-manifest.json', JSON.stringify({ schema: 'other/9', batchId: 'X' }))
    const r = parseBatchManifest(p)
    assert.equal(r.error.kind, 'schema')
    assert.match(r.error.why, /알 수 없는 형식/)
  })
})

describe('② 스토리 검증 매니페스트', () => {
  test('정상 — workers 가 per-story LLM 정본', () => {
    const p = put('2-18-verification.json', JSON.stringify(VERIFICATION))
    const r = parseVerification(p)
    assert.equal(r.error, null)
    assert.deepEqual(r.value.workers.dev, { provider: 'claude', model: 'opus' })
    assert.equal(r.value.review.high, 1)
    assert.equal(r.value.review.medium, 3)
  })
  test('checks 의 fail·required-missing 을 골라낸다', () => {
    const p = put('2-18b-verification.json', JSON.stringify({
      ...VERIFICATION, checks: { qa: 'fail', lint: 'pass', security: 'required-missing(없음)' },
    }))
    const r = parseVerification(p)
    assert.deepEqual(r.value.checkFails.map((c) => c.check).sort(), ['qa', 'security'])
  })
  test('completion 블록이 없으면 null — 지어내지 않는다', () => {
    const p = put('2-18c-verification.json', JSON.stringify(VERIFICATION))
    assert.equal(parseVerification(p).value.completion, null)
  })
  test('부재 · 손상', () => {
    assert.equal(parseVerification(join(dir, 'x-verification.json')).error.kind, 'missing')
    const p = put('bad-verification.json', 'not json at all')
    assert.equal(parseVerification(p).error.kind, 'broken')
  })
})

describe('③ 계측 · ④ 계측 이력', () => {
  test('metrics 정상/스키마 위반', () => {
    const p = put('metrics-AUTO-1.json', JSON.stringify({ schema: 'night-batch-ops/metrics/1', batchId: 'AUTO-1', wallMs: 100 }))
    assert.equal(parseMetrics(p).value.wallMs, 100)
    const q = put('metrics-AUTO-2.json', JSON.stringify({ batchId: 'AUTO-2' }))
    assert.equal(parseMetrics(q).error.kind, 'schema')
  })
  test('history — 깨진 줄만 버리고 나머지는 살린다', () => {
    const txt = [
      JSON.stringify({ at: '2026-09-02T20:00:00.000Z', batchId: 'A' }),
      '{"at": 잘림',
      '',
      JSON.stringify({ at: '2026-09-03T01:00:00.000Z', batchId: 'B' }),
      JSON.stringify({ batchId: 'C' }), // at 없음 = 버린다
    ].join('\n')
    const r = parseMetricsHistory(txt)
    assert.equal(r.rows.length, 2)
    assert.equal(r.bad, 2)
    assert.deepEqual(r.rows.map((x) => x.batchId), ['A', 'B'])
  })
  test('history 빈 텍스트 — 예외 없이 0행', () => {
    assert.deepEqual(parseMetricsHistory('').rows, [])
    assert.deepEqual(parseMetricsHistory(null).rows, [])
  })
})

describe('⑤ 배정 기록', () => {
  test('정상 → 스토리별로 접기 · failStreak≥2 회피', () => {
    const p = put('assign-history.json', JSON.stringify({
      version: 1,
      entries: {
        '2-27|codex|dev': { attempts: 3, fails: 2, failStreak: 2, rounds: 3, avgRounds: 1.5 },
        '2-27|claude|review': { attempts: 1, fails: 0, failStreak: 0, rounds: 2, avgRounds: 2 },
      },
    }))
    const r = parseAssignHistory(p)
    assert.equal(r.error, null)
    const by = assignByStory(r.value)
    assert.equal(by.get('2-27').rounds, 2)
    assert.equal(by.get('2-27').avoid.length, 1)
    assert.equal(by.get('2-27').avoid[0].provider, 'codex')
  })
  test('entries 없음 → kind=schema · 부재 → missing', () => {
    const p = put('assign-bad.json', JSON.stringify({ version: 1 }))
    assert.equal(parseAssignHistory(p).error.kind, 'schema')
    assert.equal(parseAssignHistory(join(dir, 'assign-none.json')).error.kind, 'missing')
  })
})

describe('⑥ 예정 큐', () => {
  const QUEUE = {
    planned: 'auto', updated: '2026-09-03 자동 편성(plan-queue · 상한 6)',
    defaults: { parallel: 2, commit: true, push: true },
    batches: [{ label: 'AUTO-1: 4-2 (회수)', enabled: true, stories: ['4-2'], stages: ['dev', 'review'], models: { dev: 'opus', review: 'codex:gpt-5.6-sol' } }],
    validation: { ok: false, errors: [{ code: 'unresolved-dep', key: '4-7', msg: '선행 4-2 이 done 이 아닌데 편성됐다' }], warnings: [] },
    '_편성': { date: '2026-09-03', picked: [{ key: '4-2', why: '회수(review)' }], excluded: [{ key: '4-7', why: '선행 미해소' }], notes: [], cap: 6, capBonus: 0, chainAgeDays: 1, alreadyPlannedToday: 0 },
  }
  test('정상 — validation·_편성·models 를 읽는다', () => {
    const p = put('auto-queue-2026-09-03.json', JSON.stringify(QUEUE))
    const r = parseQueue(p)
    assert.equal(r.error, null)
    assert.equal(r.value.validation.ok, false)
    assert.equal(r.value.validation.errors[0].key, '4-7')
    assert.equal(r.value.plan.chainAgeDays, 1)
    assert.equal(r.value.batches[0].models.review, 'codex:gpt-5.6-sol')
  })
  test('batches 없음 → schema · 부재 → missing · 손상 → broken', () => {
    const p = put('q-bad.json', JSON.stringify({ planned: 'auto' }))
    assert.equal(parseQueue(p).error.kind, 'schema')
    assert.equal(parseQueue(join(dir, 'q-none.json')).error.kind, 'missing')
    const q = put('q-broken.json', '{{{')
    assert.equal(parseQueue(q).error.kind, 'broken')
  })
})

describe('⑦ 증거', () => {
  test('정상 · 스키마 위반', () => {
    const p = put('ev/summary.json', JSON.stringify({
      schema: 'night-batch-ops/evidence/1', story: '4-3', at: '2026-09-03T04:00:00.000Z',
      base: 'b', head: 'h', diffBytes: 1200, redacted: true, untracked: [{ path: 'a.txt', bytes: 4 }], notes: [],
    }))
    const r = parseEvidenceSummary(p)
    assert.equal(r.value.story, '4-3')
    assert.equal(r.value.untracked, 1)
    assert.equal(r.value.redacted, true)
    const q = put('ev2/summary.json', JSON.stringify({ story: 'x' }))
    assert.equal(parseEvidenceSummary(q).error.kind, 'schema')
  })
})

describe('⑧ 결정 인박스', () => {
  const NOW = new Date('2026-09-03T09:00:00')
  test('실물 형식 — 대기/사후확인/확정을 가른다', () => {
    const md = [
      '# 결정 인박스 (상시)',
      '',
      '## ✅ 확정 — 리뷰를 12~21차까지 돈 스토리 6건 (등재·확정 모두 2026-09-02)',
      '본문 한 줄.',
      '',
      '## 🟠 결정 대기 — 2.24 담당자 연락처 축적: **이 검사를 언제까지 강화할까요** (등재 2026-08-30 · …)',
      '무엇을 정할지 설명하는 줄.',
      '',
      '## 🔴 결정 대기 — 2.10 AI 구조화 Decision 3건 (등재 2026-09-02 · 무인 규칙 ③)',
      '',
      '### 🟢 함께 봐 주실 것 (정직 표기)',
      '',
      '## 🟢 사후 확인 — 11.3 착수 가드를 무인 기본값으로 통과 (등재 2026-09-02)',
      '',
      '## 🟠 사람 게이트 — 4.2 점검표 G-7 (등재 2026-09-01)',
      '',
    ].join('\n')
    const r = parseInbox('/x/DECISIONS-INBOX.md', md, { now: NOW })
    assert.equal(r.error, null)
    assert.equal(r.value.pending.length, 2)
    assert.equal(r.value.gates.length, 1)
    assert.equal(r.value.closed, 1)
    // 대기 절 안의 「함께 봐 주실 것」 + 사후 확인 절 = 2
    assert.equal(r.value.ack.length, 2)
    // 3일 이상 대기가 맨 위 · old 표시
    assert.equal(r.value.pending[0].listed, '2026-08-30')
    assert.equal(r.value.pending[0].ageDays, 4)
    assert.equal(r.value.pending[0].old, true)
    assert.equal(r.value.pending[1].old, false)
    assert.equal(r.value.pending[1].severity, 'high')
  })
  test('사후 확인 절 안의 「함께 봐 주실 것」은 두 번 세지 않는다', () => {
    const md = '## 🟢 사후 확인 — A (등재 2026-09-02)\n\n### 🟢 함께 봐 주실 것\n'
    const r = parseInbox('/x/i.md', md, { now: NOW })
    assert.equal(r.value.ack.length, 1)
  })
  test('부재 → missing · 빈 파일 → 0건(예외 없음)', () => {
    assert.equal(parseInbox('/x/none.md', null).error.kind, 'missing')
    const r = parseInbox('/x/empty.md', '', { now: NOW })
    assert.equal(r.error, null)
    assert.equal(r.value.pending.length, 0)
  })
  test('jng-os 실물 파일을 읽는다(읽기 전용 · 없으면 건너뜀)', () => {
    const real = 'C:/Projects/jng-os/_bmad-output/implementation-artifacts/DECISIONS-INBOX.md'
    if (!existsSync(real)) { console.log('  (실물 인박스 없음 — 건너뜀)'); return }
    const txt = readFileSync(real, 'utf8')
    const r = parseInbox(real, txt, { now: NOW })
    assert.equal(r.error, null)
    console.log('  실물 인박스 파싱 — 대기 ' + r.value.pending.length +
      ' · 사람 게이트 ' + r.value.gates.length +
      ' · 사후 확인 ' + r.value.ack.length +
      ' · 확정(제외) ' + r.value.closed + ' · 절 총 ' + r.value.items.length)
    assert.ok(r.value.items.length > 5, '절이 여러 개 잡혀야 한다')
  })
})

describe('⑨ 자율 진단 · 폴더 탐색', () => {
  test('readiness 정상 · 스키마 위반', () => {
    const p = put('af/readiness.json', JSON.stringify({
      schema: 'night-batch-ops/readiness/1', verdict: 'not-ready',
      counts: { pass: 3, fail: 2, notVerified: 3, total: 8 }, criteria: [], blockers: [], notVerified: [],
    }))
    assert.equal(parseReadiness(p).value.verdict, 'not-ready')
    const q = put('af/bad.json', JSON.stringify({ verdict: 'ready' }))
    assert.equal(parseReadiness(q).error.kind, 'schema')
  })
  test('findAutofinishDir — stateDir 우선 · 없으면 logDir 폴백 · 둘 다 없으면 null', () => {
    const st = join(dir, 'st1'); const lg = join(dir, 'lg1')
    mkdirSync(join(st, 'autofinish', 'run-2'), { recursive: true })
    mkdirSync(lg, { recursive: true })
    assert.equal(findAutofinishDir(st, lg).runId, 'run-2')
    const st2 = join(dir, 'st2'); const lg2 = join(dir, 'lg2')
    mkdirSync(st2, { recursive: true }); mkdirSync(lg2, { recursive: true })
    writeFileSync(join(lg2, 'readiness.json'), '{}')
    assert.equal(findAutofinishDir(st2, lg2).from, 'logDir')
    const st3 = join(dir, 'st3'); mkdirSync(st3, { recursive: true })
    assert.equal(findAutofinishDir(st3, st3).dir, null)
  })
})

describe('슬롯 심박', () => {
  test('4갈래', () => {
    assert.equal(slotHeartbeat({ logMtimeMs: null }).state, 'none')
    assert.equal(slotHeartbeat({ logMtimeMs: 1000, lockExists: true, now: 1000 + 5 * 60000 }).state, 'ok')
    assert.equal(slotHeartbeat({ logMtimeMs: 1000, lockExists: true, now: 1000 + 60 * 60000 }).state, 'alarm')
    assert.equal(slotHeartbeat({ logMtimeMs: 1000, lockExists: false, lastNightBatches: 0, now: 2000 }).state, 'alarm')
    assert.equal(slotHeartbeat({ logMtimeMs: 1000, lockExists: false, lastNightBatches: 2, now: 2000 }).state, 'idle')
  })
})

describe('18:00 접기', () => {
  test('경계 — 17:59 는 전날 밤 · 18:00 은 그날 밤', () => {
    assert.equal(nightKey(new Date(2026, 8, 2, 17, 59)), '2026-09-01')
    assert.equal(nightKey(new Date(2026, 8, 2, 18, 0)), '2026-09-02')
    assert.equal(nightKey(new Date(2026, 8, 3, 3, 30)), '2026-09-02')
    assert.equal(nightKey('아무것도아님'), null)
  })
  test('lastNightManifests — 지금이 속한 밤만', () => {
    const ms = [
      { at: new Date(2026, 8, 2, 23, 0).toISOString(), batchId: 'A' },
      { at: new Date(2026, 8, 3, 2, 0).toISOString(), batchId: 'B' },
      { at: new Date(2026, 8, 1, 22, 0).toISOString(), batchId: 'C' },
    ]
    const got = lastNightManifests(ms, new Date(2026, 8, 3, 7, 0))
    assert.deepEqual(got.map((m) => m.batchId), ['A', 'B'])
  })
})

describe('상태 폴더 해석', () => {
  test('환경변수가 최우선', () => {
    const r = resolveStateDir(dir, { env: { AUTO_BATCH_STATE_DIR: join(dir, 'envstate') }, home: dir })
    assert.match(r.why, /환경변수/)
  })
  test('auto.config.json 의 stateDir', () => {
    const root = join(dir, 'proj1')
    mkdirSync(join(root, 'tools', 'auto'), { recursive: true })
    writeFileSync(join(root, 'tools', 'auto', 'auto.config.json'), JSON.stringify({ project: 'p1', stateDir: 'D:/state' }))
    const r = resolveStateDir(root, { env: {}, home: dir })
    assert.match(r.why, /auto\.config\.json/)
  })
  test('설정도 없고 폴더도 없으면 기본값 + 시도 경로 공시', () => {
    const root = join(dir, 'proj2')
    mkdirSync(root, { recursive: true })
    const r = resolveStateDir(root, { env: {}, home: join(dir, 'home2') })
    assert.match(r.why, /기본값/)
    assert.ok(r.tried.length >= 2)
  })
})

describe('수집기 — 전부 없어도 예외 0', () => {
  test('빈 프로젝트', () => {
    const root = join(dir, 'empty'); mkdirSync(root, { recursive: true })
    const b = collectBatchSources({ root, logDir: join(root, 'logs'), stateDir: join(root, 'st'), inboxPath: join(root, 'i.md') })
    assert.deepEqual(b.manifests, [])
    assert.equal(b.history.missing, true)
    assert.equal(b.queue.error.kind, 'missing')
    assert.equal(b.inbox.error.kind, 'missing')
    assert.equal(b.diagnosis.error.kind, 'missing')
    assert.equal(b.heartbeat.state, 'none')
    assert.deepEqual(b.errors, [])
  })
  test('풍족 — 매니페스트·검증·계측·큐·인박스를 모두 줍는다', () => {
    const root = join(dir, 'rich')
    const logs = join(root, '_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs')
    const st = join(root, 'state')
    mkdirSync(logs, { recursive: true }); mkdirSync(st, { recursive: true })
    writeFileSync(join(logs, 'batch-AUTO-1-manifest.json'), JSON.stringify(MANIFEST))
    writeFileSync(join(logs, '2-18-verification.json'), JSON.stringify(VERIFICATION))
    writeFileSync(join(logs, 'metrics-AUTO-1.json'), JSON.stringify({ schema: 'night-batch-ops/metrics/1', batchId: 'AUTO-1', wallMs: 60000, qualityGate: { passed: true, why: 'ok' } }))
    writeFileSync(join(st, 'metrics-history.jsonl'), JSON.stringify({ at: '2026-09-03T01:00:00.000Z', batchId: 'AUTO-1' }) + '\n깨진줄\n')
    writeFileSync(join(st, 'auto-queue-2026-09-03.json'), JSON.stringify({ batches: [] }))
    writeFileSync(join(root, 'INBOX.md'), '## 🟠 결정 대기 — A (등재 2026-09-01)\n')
    const b = collectBatchSources({ root, logDir: logs, stateDir: st, inboxPath: join(root, 'INBOX.md') })
    assert.equal(b.manifests.length, 1)
    assert.equal(b.verifications.length, 1)
    assert.equal(b.metrics.length, 1)
    assert.equal(b.history.rows.length, 1)
    assert.equal(b.history.bad, 1)
    assert.equal(b.queue.error, null)
    assert.equal(b.inbox.value.pending.length, 1)
    assert.deepEqual(b.errors, [])
  })
  test('손상 파일이 섞여도 나머지는 살고 errors 에 남는다', () => {
    const root = join(dir, 'mixed')
    const logs = join(root, 'logs'); const st = join(root, 'st')
    mkdirSync(logs, { recursive: true }); mkdirSync(st, { recursive: true })
    writeFileSync(join(logs, 'batch-AUTO-1-manifest.json'), JSON.stringify(MANIFEST))
    writeFileSync(join(logs, 'batch-AUTO-2-manifest.json'), '{ 잘림')
    const b = collectBatchSources({ root, logDir: logs, stateDir: st })
    assert.equal(b.manifests.length, 1)
    assert.equal(b.errors.length, 1)
    assert.equal(b.errors[0].kind, 'broken')
  })
})
