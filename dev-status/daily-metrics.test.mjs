// dev-status 계측 접기 — 18:00 경계 · 3일 배정 · 추세 · 배치 0일 · 게이트 제외 (설계 §7)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dailyMetrics, formatDuration, formatValue, nightKeys, trendOf } from './daily-metrics.mjs'

/** 로컬 시각으로 만든 ISO — 18:00 접기는 로컬 기준이라 UTC 리터럴을 쓰면 테스트가 시간대에 흔들린다. */
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString()
const NOW = new Date(2026, 8, 3, 7, 0) // 2026-09-03 07:00 → 지난 1일 = 2026-09-02 밤

const row = (over = {}) => ({
  at: at(2026, 9, 2, 23, 0), batchId: 'A', workers: 2, wallMs: 60 * 60000, serialMs: 100 * 60000,
  idleRatio: 0.2, parallelEfficiency: 0.83, p50Ms: 30 * 60000, p95Ms: 50 * 60000,
  retries: { repairRounds: 0, providerSwitches: 0 }, modelCalls: [{ provider: 'claude', model: 'opus', calls: 4, tokens: 0 }],
  qualityGate: { passed: true, why: 'ok' }, planSource: 'deterministic', ...over,
})

describe('밤 키 · 18:00 경계', () => {
  test('지난 1/2/3일 키가 하루씩 뒤로 간다', () => {
    assert.deepEqual(nightKeys(NOW, 3), ['2026-09-02', '2026-09-01', '2026-08-31'])
  })
  test('17:59 의 실행은 「지난 2일」로, 18:00 은 「지난 1일」로 간다', () => {
    const t = dailyMetrics({
      history: [row({ at: at(2026, 9, 2, 17, 59), batchId: 'EARLY' }), row({ at: at(2026, 9, 2, 18, 0), batchId: 'LATE' })],
      now: NOW,
    })
    assert.equal(t.days[0].batches, 1) // 09-02 밤 = LATE
    assert.equal(t.days[1].batches, 1) // 09-01 밤 = EARLY(17:59 는 전날 밤)
    assert.equal(t.days[2].batches, 0)
  })
  test('새벽 3시 실행은 어젯밤으로 붙는다', () => {
    const t = dailyMetrics({ history: [row({ at: at(2026, 9, 3, 3, 0) })], now: NOW })
    assert.equal(t.days[0].batches, 1)
  })
  test('3일 밖의 실행은 아무 칸에도 안 들어간다', () => {
    const t = dailyMetrics({ history: [row({ at: at(2026, 8, 20, 22, 0) })], now: NOW })
    assert.deepEqual(t.days.map((d) => d.batches), [0, 0, 0])
  })
})

describe('지표', () => {
  test('절약 = Σserial − Σwall · 병렬 효율 = Σserial / Σ(workers×wall) · 유휴 = Σidle / Σcapacity', () => {
    const t = dailyMetrics({ history: [row()], now: NOW })
    const d = t.days[0]
    assert.equal(d.savingMs, 40 * 60000)
    assert.equal(Math.round(d.parallelEfficiency * 1000) / 1000, 0.833) // 100 / (2×60)
    assert.equal(Math.round(d.idleRatio * 100) / 100, 0.2)
    assert.equal(d.firstPass, 1)
  })
  test('첫 시도 통과율 — 수리 라운드가 있으면 뺀다', () => {
    const t = dailyMetrics({
      history: [row(), row({ batchId: 'B', retries: { repairRounds: 2, providerSwitches: 0 } })],
      now: NOW,
    })
    assert.equal(t.days[0].firstPass, 0.5)
    assert.equal(t.days[0].firstPassOk, 1)
    assert.equal(t.days[0].firstPassTotal, 2)
  })
  test('통합 실패율 — 그날 배치 매니페스트가 분모', () => {
    const t = dailyMetrics({
      history: [row()],
      manifests: [
        { at: at(2026, 9, 2, 23, 0), integration: { result: 'pass' } },
        { at: at(2026, 9, 3, 4, 0), integration: { result: 'rollback' } },
      ],
      now: NOW,
    })
    assert.equal(t.days[0].integrationRuns, 2)
    assert.equal(t.days[0].integrationFail, 1)
    assert.equal(t.days[0].integrationFailRate, 0.5)
  })
  test('리뷰 결함은 검증 매니페스트에서 센다(run-night 은 늘 0 을 넘긴다)', () => {
    const t = dailyMetrics({
      history: [row()],
      verifications: [
        { generatedAt: at(2026, 9, 2, 23, 30), review: { high: 1, medium: 4 } },
        { generatedAt: at(2026, 9, 3, 2, 0), review: { high: 1, medium: 2 } },
      ],
      now: NOW,
    })
    assert.equal(t.days[0].reviewHigh, 2)
    assert.equal(t.days[0].reviewMedium, 6)
  })
  test('모델 호출량은 프로바이더/모델별로 합친다', () => {
    const t = dailyMetrics({
      history: [
        row(),
        row({ batchId: 'B', modelCalls: [{ provider: 'claude', model: 'opus', calls: 2, tokens: 0 }, { provider: 'codex', model: 'gpt-5', calls: 1, tokens: 38400 }] }),
      ],
      now: NOW,
    })
    const calls = t.days[0].modelCalls
    assert.equal(calls.find((c) => c.key === 'claude/opus').calls, 6)
    assert.equal(calls.find((c) => c.key === 'codex/gpt-5').tokens, 38400)
  })
})

describe('품질 게이트 제외', () => {
  test('미통과 실행은 속도 지표에서 빼고 「제외 N」으로 남긴다', () => {
    const t = dailyMetrics({
      history: [row(), row({ batchId: 'BAD', serialMs: 999 * 60000, qualityGate: { passed: false, why: 'qa RED' } })],
      now: NOW,
    })
    const d = t.days[0]
    assert.equal(d.batches, 2)
    assert.equal(d.counted, 1)
    assert.equal(d.excluded, 1)
    assert.equal(d.savingMs, 40 * 60000) // 999분짜리가 섞이지 않았다
  })
  test('그날 전부 미통과면 속도 지표는 —(0 이 아니다)', () => {
    const t = dailyMetrics({ history: [row({ qualityGate: { passed: false, why: 'x' } })], now: NOW })
    assert.equal(t.days[0].savingMs, null)
    assert.equal(t.days[0].parallelEfficiency, null)
    assert.equal(t.days[0].excluded, 1)
  })
})

describe('배치 0 인 날', () => {
  test('empty=true 이고 표의 값이 전부 null', () => {
    const t = dailyMetrics({ history: [], now: NOW })
    assert.deepEqual(t.days.map((d) => d.empty), [true, true, true])
    for (const r of t.rows) assert.deepEqual(r.values, [null, null, null])
  })
  test('빈 날은 추세도 —', () => {
    const t = dailyMetrics({ history: [], now: NOW })
    for (const r of t.rows) assert.equal(r.trend.label, '—')
  })
})

describe('추세', () => {
  test('값이 2개 미만이면 —', () => {
    assert.equal(trendOf([0.5, null, null], 'higher').label, '—')
    assert.equal(trendOf([], 'higher').dir, 'unknown')
  })
  test('높을수록 좋은 지표 — 최신이 크면 개선', () => {
    assert.equal(trendOf([0.8, 0.7, 0.6], 'higher').dir, 'improve')
    assert.equal(trendOf([0.6, 0.7, 0.8], 'higher').dir, 'worse')
  })
  test('낮을수록 좋은 지표 — 최신이 작으면 개선', () => {
    assert.equal(trendOf([0.1, 0.2, 0.3], 'lower').dir, 'improve')
    assert.equal(trendOf([0.3, 0.2, 0.1], 'lower').dir, 'worse')
  })
  test('같으면 평평', () => {
    assert.equal(trendOf([2, 5, 2], 'lower').dir, 'flat')
  })
  test('표 전체에서 실제로 방향이 나온다', () => {
    const t = dailyMetrics({
      history: [
        row({ at: at(2026, 9, 2, 22, 0), idleRatio: 0.1 }),
        row({ at: at(2026, 9, 1, 22, 0), idleRatio: 0.2 }),
        row({ at: at(2026, 8, 31, 22, 0), idleRatio: 0.3 }),
      ],
      now: NOW,
    })
    const idle = t.rows.find((r) => r.key === 'idleRatio')
    assert.deepEqual(idle.values.map((v) => Math.round(v * 100) / 100), [0.1, 0.2, 0.3])
    assert.equal(idle.trend.dir, 'improve')
  })
})

describe('서식', () => {
  test('값이 없으면 —', () => {
    assert.equal(formatValue(null, 'pct'), '—')
    assert.equal(formatValue(undefined, 'duration'), '—')
  })
  test('비율 · 시간 · 개수', () => {
    assert.equal(formatValue(0.714, 'pct'), '71.4%')
    assert.equal(formatValue(72 * 60000, 'duration'), '1시간 12분')
    assert.equal(formatValue(41 * 60000, 'duration'), '41분')
    assert.equal(formatValue(2, 'count'), '2')
    assert.equal(formatDuration(-90 * 60000), '-1시간 30분')
  })
})
