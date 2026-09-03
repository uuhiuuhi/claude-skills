// bench.mjs 테스트 — 2026-09-02 「9점대 하네스」 (워커 F2)
// 실제 git 저장소 · 실제 엔진 · 스텁 CLI 로 두 팔을 진짜 돌린다(실 LLM 0).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_STORIES, renderBenchDoc, runBench } from './bench.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

test('renderBenchDoc — 스텁 한계와 NOT VERIFIED 를 문서 머리에 못 박는다', () => {
  const fake = (passed) => ({
    exit: 0,
    metrics: {
      workers: 2, wallMs: 1000, serialMs: 500, occupancyMs: 500, idleMs: 1500, idleRatio: 0.75,
      parallelEfficiency: 0.25, stories: [], p50Ms: 500, p95Ms: 500,
      retries: { repairRounds: 0, providerSwitches: 0 }, modelCalls: [], tokens: 0,
      qualityGate: { passed, why: passed ? 'ok' : 'qa RED' },
    },
  })
  const doc = renderBenchDoc(fake(true), fake(true))
  assert.match(doc, /절대 시간은 의미가 없다/)
  assert.match(doc, /NOT VERIFIED/)
  assert.match(doc, /node night-batch-ops\/engine\/bench\.mjs --stub/)
  assert.match(doc, /비교 유효/)
  // 품질 미달이면 수치가 아니라 「비교 제외」가 판정으로 나온다
  assert.match(renderBenchDoc(fake(true), fake(false)), /품질 미달 · 비교 제외/)
})

test('CLI — --stub 없이 부르면 거부한다(실 LLM 벤치를 이 도구가 하는 척하지 않는다)', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'bench.mjs')], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--stub/)
  assert.match(r.stderr, /실 LLM 벤치는 이 도구가 하지 않는다/)
})

test('runBench — 두 팔이 같은 스토리 세트로 실제로 돌고 비교 가능한 계측을 낸다', { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'nbo-bench-root-'))
  try {
    const out = join(root, 'bench-stub.md')
    const r = runBench({ out, root })
    assert.equal(r.baseline.exit, 0, r.baseline.stdout.slice(-2000) + r.baseline.stderr.slice(-2000))
    assert.equal(r.candidate.exit, 0, r.candidate.stdout.slice(-2000) + r.candidate.stderr.slice(-2000))
    // 러너가 남긴 계측을 그대로 읽어 온다 — 벤치가 자기 숫자를 지어내지 않는다
    assert.ok(r.baseline.metrics, '기준선 계측 없음')
    assert.ok(r.candidate.metrics, '새 하네스 계측 없음')
    assert.equal(r.baseline.metrics.workers, 1, '기준선은 순차(parallel 1)')
    assert.equal(r.candidate.metrics.workers, 2, '새 하네스는 2폭')
    // 같은 스토리 세트 — 비교의 전제
    for (const m of [r.baseline.metrics, r.candidate.metrics]) {
      const keys = m.stories.map((s) => s.story).sort()
      for (const s of BENCH_STORIES) assert.ok(keys.includes(s.key), `${s.key} 누락: ${keys.join(',')}`)
    }
    // 품질 게이트를 둘 다 통과해야 비교가 성립한다(못 넘기면 하네스가 품질을 깎은 것이다)
    assert.equal(r.baseline.metrics.qualityGate.passed, true, r.baseline.metrics.qualityGate.why)
    assert.equal(r.candidate.metrics.qualityGate.passed, true, r.candidate.metrics.qualityGate.why)
    // 새 하네스만 Codex 리뷰를 쓴다 — 배정이 실제로 갈렸다는 증거
    assert.ok(r.candidate.metrics.modelCalls.some((m) => m.provider === 'codex'), JSON.stringify(r.candidate.metrics.modelCalls))
    assert.ok(!r.baseline.metrics.modelCalls.some((m) => m.provider === 'codex'), JSON.stringify(r.baseline.metrics.modelCalls))
    assert.ok(existsSync(out))
    const doc = readFileSync(out, 'utf8')
    assert.match(doc, /## 비교/)
    assert.match(doc, /비교 유효/)
    assert.match(doc, /NOT VERIFIED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
