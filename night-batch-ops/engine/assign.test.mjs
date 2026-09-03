// 워커 배정 — 결정성 · 고위험 Codex dev 배제 · review 교차 · 연속 실패 회피 · 가용성 0
//
// 무는 것은 리터럴이 아니라 **불변식**이다: 「고위험은 외부 벤더 dev 로 가지 않는다」
// 「review 는 dev 와 다른 눈이다」 「연속 실패한 프로바이더를 또 쓰지 않는다」
// 「가용 프로바이더가 하나뿐이면 배정이 배치를 세우지 않는다」.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAIL_STREAK_MAX, HIGH_RISK_MIN, assignBatchModels, assignWorkers, emptyHistory, parseHistory,
  providerFailStreak, recordAssignResult, serializeHistory, specProvider, storyDifficulty, storyRisk,
} from './assign.mjs'

const CODEX_ON = { claude: { enabled: true, available: true, max: 3 }, codex: { enabled: true, available: true, max: 2, roles: ['dev', 'review'] } }
const CODEX_OFF = { claude: { enabled: true, available: true, max: 3 }, codex: { enabled: false, available: false, max: 1, roles: ['review'] } }
const MODELS = { dev: 'opus', review: 'fable' }
const SAFE = { key: '2-1-a', kind: 'recovery', files: ['src/ui/list.tsx'], text: '목록 정렬을 고친다' }
const RISKY = { key: '2-2-b', kind: 'recovery', files: ['supabase/migrations/20260902_rls.sql', 'src/auth/guard.ts'], text: '권한(RLS) 정책을 바꾼다' }

describe('[assign] 점수', () => {
  it('위험도 — 마이그레이션·auth 경로·보안 키워드가 쌓이면 고위험', () => {
    const r = storyRisk(RISKY)
    assert.ok(r.score >= HIGH_RISK_MIN, `고위험이 아니다: ${r.score}`)
    assert.ok(r.flags.includes('migration') && r.flags.includes('auth-path'))
    assert.ok(storyRisk(SAFE).score < HIGH_RISK_MIN)
  })

  it('난이도 — File List 크기·마이그레이션·테스트 파일·본문 길이', () => {
    const small = storyDifficulty({ files: ['src/a.ts'], text: 'x' })
    const big = storyDifficulty({ files: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`).concat(['tests/a.test.ts', 'supabase/migrations/x.sql']), text: 'y'.repeat(30000) })
    assert.ok(big.score > small.score)
    assert.ok(big.score <= 10 && small.score >= 0)
  })
})

describe('[assign] 배정 불변식', () => {
  it('결정적 — 같은 입력이면 같은 출력(두 번 호출·순서 무관 필드 없음)', () => {
    const args = { stories: [SAFE, RISKY], providers: CODEX_ON, history: emptyHistory(), config: { models: MODELS, split: true } }
    assert.deepEqual(assignWorkers(args), assignWorkers(args))
  })

  it('고위험 스토리의 dev 는 Codex 에 주지 않는다(split 이 켜져 있어도)', () => {
    const out = assignWorkers({ stories: [SAFE, RISKY], providers: CODEX_ON, history: null, config: { models: MODELS, split: true } })
    const risky = out.find((o) => o.story === RISKY.key)
    assert.equal(risky.devProvider, 'claude', '고위험이 Codex dev 로 갔다')
    assert.ok(risky.why.includes('고위험') || risky.why.includes('split') === false)
    // 저위험 스토리는 split 대상이 될 수 있다(두 번째 자리부터)
    const low = assignWorkers({
      stories: [SAFE, { ...SAFE, key: '2-9-z', files: ['src/ui/detail.tsx'] }],
      providers: CODEX_ON, history: null, config: { models: MODELS, split: true },
    })
    assert.equal(low[1].devProvider, 'codex')
    assert.equal(low[0].devProvider, 'claude')
  })

  it('review 는 dev 와 다른 눈 — 같은 프로바이더면 claude 로 교차, 같은 모델이면 다른 모델', () => {
    const out = assignWorkers({
      stories: [SAFE], providers: CODEX_ON, history: null,
      config: { models: { dev: 'codex', review: 'codex' } },
    })
    assert.equal(out[0].devProvider, 'codex')
    assert.equal(out[0].reviewProvider, 'claude', 'dev·review 가 같은 벤더다 — 자기 검증')
    const same = assignWorkers({ stories: [SAFE], providers: CODEX_OFF, history: null, config: { models: { dev: 'opus', review: 'opus' } } })
    assert.notEqual(same[0].review, same[0].dev, '같은 모델 자기 검증이 통과했다')
  })

  it('같은 프로바이더 연속 실패 2회면 회피한다', () => {
    let h = emptyHistory()
    h = recordAssignResult(h, { story: SAFE.key, provider: 'codex', role: 'dev', ok: false, rounds: 3 })
    h = recordAssignResult(h, { story: SAFE.key, provider: 'codex', role: 'dev', ok: false, rounds: 3 })
    assert.equal(providerFailStreak(h, 'codex', { story: SAFE.key, role: 'dev' }), FAIL_STREAK_MAX)
    const out = assignWorkers({ stories: [SAFE], providers: CODEX_ON, history: h, config: { models: { dev: 'codex', review: 'opus' } } })
    assert.equal(out[0].devProvider, 'claude')
    assert.ok(out[0].why.includes('폴백') || out[0].why.includes('회피'))
    // 성공 1회면 스트릭이 풀리고 다시 배정된다 — 영구 배제가 아니다
    const h2 = recordAssignResult(h, { story: SAFE.key, provider: 'codex', role: 'dev', ok: true, rounds: 1 })
    assert.equal(providerFailStreak(h2, 'codex', { story: SAFE.key, role: 'dev' }), 0)
    const back = assignWorkers({ stories: [SAFE], providers: CODEX_ON, history: h2, config: { models: { dev: 'codex', review: 'opus' } } })
    assert.equal(back[0].devProvider, 'codex')
  })

  it('가용성 0(미설치·미인증·꺼짐)이면 claude 만 배정한다 — 배정이 배치를 세우지 않는다', () => {
    for (const providers of [CODEX_OFF, { codex: { enabled: true, available: false, roles: ['dev', 'review'] } }, {}]) {
      const out = assignWorkers({ stories: [SAFE], providers, history: null, config: { models: { dev: 'codex', review: 'codex' } } })
      assert.equal(out[0].devProvider, 'claude', JSON.stringify(providers))
      assert.equal(out[0].reviewProvider, 'claude')
      assert.ok(out[0].dev && out[0].review, '모델이 비었다 — 엔진이 기본 모델로 떨어진다')
    }
  })

  it('프로바이더 슬롯 상한 — codex.max 를 넘겨 배정하지 않는다', () => {
    const stories = [SAFE, { ...SAFE, key: '2-3-c', files: ['src/ui/c.tsx'] }, { ...SAFE, key: '2-4-d', files: ['src/ui/d.tsx'] }]
    const out = assignWorkers({
      stories, providers: { codex: { enabled: true, available: true, max: 1, roles: ['dev'] } },
      history: null, config: { models: MODELS, split: true },
    })
    assert.equal(out.filter((o) => o.devProvider === 'codex').length, 1)
  })

  it('모델 스펙 형식 위반은 배정 단계에서 걸러진다(argv 로 나가는 값이다)', () => {
    const out = assignWorkers({ stories: [SAFE], providers: CODEX_OFF, history: null, config: { models: { dev: 'opus; rm -rf /', review: 'opus' } } })
    assert.equal(specProvider(out[0].dev), 'claude')
    assert.ok(!out[0].dev.includes(';'))
  })
})

describe('[assign] 기록 저장소(assign-history.json)', () => {
  it('깨진 JSON·이상한 형태는 빈 기록으로 흡수한다(편성이 서면 안 된다)', () => {
    assert.deepEqual(parseHistory('{not json'), emptyHistory())
    assert.deepEqual(parseHistory(null), emptyHistory())
    assert.deepEqual(parseHistory({ entries: null }), emptyHistory())
    assert.deepEqual(parseHistory({ entries: { 'a|codex|dev': { attempts: 'x', failStreak: -3 } } }).entries['a|codex|dev'], { attempts: 0, fails: 0, failStreak: 0, rounds: 0, avgRounds: 0 })
  })

  it('갱신은 순수 — 원본을 바꾸지 않고 평균 라운드를 계산한다', () => {
    const h0 = emptyHistory()
    const h1 = recordAssignResult(h0, { story: '2-1-a', provider: 'claude', role: 'dev', ok: true, rounds: 2 })
    const h2 = recordAssignResult(h1, { story: '2-1-a', provider: 'claude', role: 'dev', ok: false, rounds: 4 })
    assert.deepEqual(h0, emptyHistory(), '원본이 변경됐다')
    assert.equal(h2.entries['2-1-a|claude|dev'].attempts, 2)
    assert.equal(h2.entries['2-1-a|claude|dev'].fails, 1)
    assert.equal(h2.entries['2-1-a|claude|dev'].avgRounds, 3)
    assert.equal(JSON.parse(serializeHistory(h2)).entries['2-1-a|claude|dev'].failStreak, 1)
  })
})

describe('[assign] 편성기 어댑터(assignBatchModels)', () => {
  it('설정·기록이 없으면 base 를 그대로 돌려준다 — 종전 큐와 같다(하위 호환)', () => {
    assert.deepEqual(assignBatchModels({ base: { dev: 'opus', review: 'sonnet' }, stories: [{ key: '2-1-a', files: [] }] }), { dev: 'opus', review: 'sonnet' })
    // 마감 재검수의 { review } 단독 형태에 dev 키를 만들어 붙이지 않는다
    assert.deepEqual(assignBatchModels({ base: { review: 'opus' }, stories: [{ key: '2-1-a', files: [] }] }), { review: 'opus' })
    assert.equal(assignBatchModels({ base: null }), null)
  })

  it('codex review 의도가 있어도 가용성 0 이면 claude 로 내려앉는다', () => {
    const out = assignBatchModels({ base: { dev: 'opus', review: 'codex' }, stories: [{ key: '2-1-a', files: [] }], providers: CODEX_OFF })
    assert.equal(specProvider(out.review), 'claude')
    assert.notEqual(out.review, out.dev)
  })
})
