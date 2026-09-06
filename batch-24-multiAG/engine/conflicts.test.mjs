// 시나리오 19 — migration / schema / API contract / 테스트 환경 충돌 시 순차화
//
// 무는 것: 「File List 가 겹치지 않아도 충돌하는 부류」를 범주별로 잡아 병렬을 포기하는가,
// 그리고 **겹침이 없으면 병렬을 그대로 유지하는가**(과탐지는 밤 처리량을 죽인다).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONFLICT_RULES, SHARED_BOOKKEEPING_DEFAULT, classifyPath, parallelHazardsCompat, parallelHazardsExtended } from './conflicts.mjs'

const seq = (lists) => parallelHazardsExtended(lists)
const cat = (lists) => seq(lists).reasons.map((r) => r.category)

describe('[19] 범주별 충돌 → 순차화', () => {
  it('마이그레이션 — 둘 다 새 파일을 만들면 번호 경합(다른 파일이라 겹침 판정엔 안 걸린다)', () => {
    const r = seq([
      ['supabase/migrations/20260902_a.sql', 'src/a.ts'],
      ['supabase/migrations/20260902_b.sql', 'src/b.ts'],
    ])
    assert.equal(r.parallelOk, false)
    assert.ok(r.reasons.some((x) => x.category === 'migration'))
    assert.ok(r.why.includes('번호가 경합'))
    // 한쪽만 만들면 경합이 없다 — 과탐지 금지(F35: migrations 오탐 이력)
    assert.equal(seq([['supabase/migrations/20260902_a.sql'], ['src/b.ts']]).parallelOk, true)
  })

  it('스키마 생성물 — database.ts · schema.sql · prisma/schema.prisma', () => {
    assert.deepEqual(cat([['src/types/database.ts'], ['src/types/database.ts']]), ['file-overlap', 'schema'])
    assert.ok(cat([['db/schema.sql', 'src/a.ts'], ['prisma/schema.prisma', 'src/b.ts']]).includes('schema'))
    assert.equal(seq([['src/types/database.ts'], ['src/b.ts']]).parallelOk, true)
  })

  it('API 계약 — 엣지 함수 · src/api · openapi · contract 타입은 다른 파일이어도 갈라진다', () => {
    assert.ok(cat([['supabase/functions/f1/index.ts'], ['supabase/functions/f2/index.ts']]).includes('api-contract'))
    assert.ok(cat([['src/api/tickets.ts'], ['openapi.yaml']]).includes('api-contract'))
    assert.ok(cat([['src/types/ticket-contract.ts'], ['src/api/x.ts']]).includes('api-contract'))
    assert.equal(seq([['src/api/tickets.ts'], ['src/ui/list.tsx']]).parallelOk, true)
  })

  it('테스트 환경 — tests/setup · tests/db 공유 픽스처 · GitHub 워크플로', () => {
    assert.ok(cat([['tests/setup.ts'], ['tests/db/rls.test.ts']]).includes('test-env'))
    assert.ok(cat([['.github/workflows/qa.yml'], ['.github/workflows/deploy.yml']]).includes('test-env'))
    assert.equal(seq([['tests/unit/a.test.ts'], ['tests/unit/b.test.ts']]).parallelOk, true)
  })

  it('공유 설정 — tsconfig · vite/vitest · eslint · .env.example · wrangler', () => {
    assert.ok(cat([['tsconfig.json'], ['tsconfig.app.json']]).includes('shared-config'))
    assert.ok(cat([['vite.config.ts'], ['eslint.config.js']]).includes('shared-config'))
    assert.ok(cat([['.env.example'], ['wrangler.toml']]).includes('shared-config'))
  })

  it('공유 툴체인(package.json/lock) — 한쪽만 만져도 병렬 불가(node_modules junction 공유)', () => {
    const r = seq([['package.json'], ['src/b.ts']])
    assert.equal(r.parallelOk, false)
    assert.equal(r.reasons[0].category, 'toolchain')
    assert.ok(seq([['pnpm-lock.yaml'], ['src/b.ts']]).reasons.some((x) => x.category === 'toolchain'))
  })
})

describe('[19] 겹침이 없으면 병렬 유지 · 판정은 결정적', () => {
  it('서로소 File List 는 병렬 그대로', () => {
    const r = seq([['src/a.ts', 'src/a.test.ts'], ['src/b.ts', 'src/b.test.ts']])
    assert.equal(r.parallelOk, true)
    assert.deepEqual(r.reasons, [])
    assert.equal(r.why, '')
  })

  it('공유 장부(sprint-status·deferred-work·DECISIONS-INBOX)는 겹쳐도 충돌이 아니다', () => {
    assert.equal(seq([[...SHARED_BOOKKEEPING_DEFAULT, 'src/a.ts'], [...SHARED_BOOKKEEPING_DEFAULT, 'src/b.ts']]).parallelOk, true)
  })

  it('같은 파일 직접 겹침은 file-overlap 으로 잡고, 경로 표기(역슬래시·./)는 정규화한다', () => {
    const r = seq([['src\\a.ts'], ['./src/a.ts']])
    assert.equal(r.parallelOk, false)
    assert.equal(r.reasons[0].category, 'file-overlap')
    assert.deepEqual(r.reasons[0].stories, [1, 2])
  })

  it('같은 입력이면 같은 출력(결정적) · 범주는 첫 일치 하나로만 계상', () => {
    const lists = [['supabase/migrations/a.sql', 'src/types/database.ts'], ['supabase/migrations/b.sql', 'src/types/database.ts']]
    assert.deepEqual(seq(lists), seq(lists))
    assert.deepEqual(cat(lists), ['file-overlap', 'migration', 'schema'])
    assert.equal(classifyPath('supabase/migrations/a.sql'), 'migration')
    assert.equal(classifyPath('src/ui/x.tsx'), null)
    assert.equal(CONFLICT_RULES.filter((r) => r.mode === 'any').map((r) => r.id).join(','), 'toolchain')
  })

  it('러너 주입 어댑터는 runner-rules.parallelHazards 와 같은 형태 { ok, why } 를 낸다', () => {
    assert.deepEqual(parallelHazardsCompat([['src/a.ts'], ['src/b.ts']]), { ok: true, why: '' })
    const bad = parallelHazardsCompat([['package.json'], ['src/b.ts']])
    assert.equal(bad.ok, false)
    assert.ok(bad.why.includes('공유 툴체인'))
  })
})
