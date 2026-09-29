// 개발선(러너 클론) 덮어 읽기 · 마이그레이션 성격 분류 · 러너 클론 찾기 · 러너 실황 — 규칙 검증.
// 병합·분류는 순수 함수라 파일 시스템 없이 보고, 경로 해석·로그 해석은 임시 폴더에서 실제로 읽는다.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeDevLineSprint, mergeDevLineMockups, STATUS_RANK, classifyRemoteOnly, resolveRunnerClone, parseRunner, parseSprintText,
} from './scan.mjs'

const rec = (status, slug = 'x') => ({ status, slug, slugTitle: slug })

let dir
before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-devline-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })
const put = (name, text) => {
  const p = join(dir, name)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text, 'utf8')
  return p
}

describe('개발선 스프린트 병합', () => {
  test('클론이 앞선 상태(backlog→review)면 덮고 overridden 에 적는다', () => {
    const r = mergeDevLineSprint(
      { storyStatus: { '7.6': rec('backlog', '7-6-sample') }, epicStatus: { 7: 'backlog' } },
      { storyStatus: { '7.6': rec('review', '7-6-sample') }, epicStatus: { 7: 'in-progress' } },
    )
    assert.equal(r.storyStatus['7.6'].status, 'review')
    assert.deepEqual(r.overridden, ['7.6'])
    assert.equal(r.epicStatus[7], 'in-progress')
  })
  test('클론이 뒤처진 상태(done→review)면 덮지 않는다 — 이 폴더의 정정을 되돌리지 않는다', () => {
    const r = mergeDevLineSprint(
      { storyStatus: { '1.8': rec('done') }, epicStatus: {} },
      { storyStatus: { '1.8': rec('review') }, epicStatus: {} },
    )
    assert.equal(r.storyStatus['1.8'].status, 'done')
    assert.deepEqual(r.overridden, [])
  })
  test('이 폴더에 없는 키는 더하지 않는다(목록 기준 = 이 폴더 · 오탐 방지) · 같은 상태면 덮지 않는다', () => {
    const r = mergeDevLineSprint(
      { storyStatus: { '1.1': rec('done') }, epicStatus: { 1: 'done' } },
      { storyStatus: { '1.1': rec('done'), '7.19': rec('in-progress') }, epicStatus: { 1: 'done', 7: 'in-progress' } },
    )
    assert.deepEqual(r.overridden, [])
    assert.equal(r.storyStatus['7.19'], undefined)
    assert.equal(r.epicStatus[7], undefined)
  })
  test('모르는 상태값은 순위 -1 — 알려진 상태를 덮지 못한다', () => {
    assert.equal(STATUS_RANK.done, 4)
    const r = mergeDevLineSprint(
      { storyStatus: { '2.1': rec('review') }, epicStatus: {} },
      { storyStatus: { '2.1': rec('weird') }, epicStatus: {} },
    )
    assert.equal(r.storyStatus['2.1'].status, 'review')
  })
  test('클론 상태 파일도 같은 해석기로 읽는다(꼬리 주석 포함)', () => {
    const t = parseSprintText('development_status:\n  epic-7: in-progress  # 메모\n  7-6-sample: review\n')
    assert.equal(t.epicStatus[7], 'in-progress')
    assert.equal(t.storyStatus['7.6'].slug, '7-6-sample')
  })
})

describe('개발선 목업 병합(플러그인용 순수 함수)', () => {
  const m = (rel, verdict, explicit = true, extra = {}) => ({ rel, file: rel.split('/').pop(), abs: '/clone/' + rel, href: 'devline/' + rel, verdict, explicit, note: 'n', story: '7.10', ...extra })
  test('클론에만 있는 목업은 더하고 devline/ 복사 대상이 된다', () => {
    const r = mergeDevLineMockups([m('mockups/a.html', 'approved', true, { abs: '/here/mockups/a.html', href: '../x/mockups/a.html' })],
      [m('mockups/a.html', 'approved'), m('mockups/story-7-10-sample-screen.html', 'pending')])
    assert.deepEqual(r.added, ['mockups/story-7-10-sample-screen.html'])
    assert.deepEqual(r.copies, [{ from: '/clone/mockups/story-7-10-sample-screen.html', to: 'devline/mockups/story-7-10-sample-screen.html' }])
    assert.equal(r.mockups.length, 2)
    assert.equal(r.mockups.find((x) => x.rel === 'mockups/a.html').href, '../x/mockups/a.html', '이 폴더에 있는 파일의 링크는 그대로')
  })
  test('양쪽에 있는 파일은 클론 판정이 명시돼 있을 때만 갱신한다', () => {
    const here = [m('mockups/a.html', 'pending', false, { note: '기록 없음' })]
    const r1 = mergeDevLineMockups(here, [m('mockups/a.html', 'approved', true, { note: '승인' })])
    assert.equal(r1.mockups[0].verdict, 'approved'); assert.deepEqual(r1.updated, ['mockups/a.html'])
    const r2 = mergeDevLineMockups([m('mockups/a.html', 'approved')], [m('mockups/a.html', 'pending', false)])
    assert.equal(r2.mockups[0].verdict, 'approved', '클론에 판정 기록이 없으면(pending 기본값) 이 폴더 판정을 지킨다'); assert.deepEqual(r2.updated, [])
  })
})

describe('마이그레이션 「파일 없이 적용」 성격 분류', () => {
  test('로컬·러너 폴더에 파일이 있으면 개발선 · 기준일 이전은 번호표 차이 · 나머지만 위반', () => {
    put('loc/20260901000000_a.sql', '')
    put('run/20260915000000_b.sql', '')
    const r = classifyRemoteOnly({
      versions: ['20260901000000', '20260915000000', '20260801000000', '20260920000000'],
      localDir: join(dir, 'loc'), runnerDir: join(dir, 'run'), baselineSince: '2026-09-08',
    })
    assert.equal(r.known, true)
    assert.deepEqual(r.devLine, ['20260901000000', '20260915000000'])
    assert.deepEqual(r.oldNumbering, ['20260801000000'])
    assert.deepEqual(r.violations, ['20260920000000'])
  })
  test('버전 목록이 없으면 known=false(가르지 못함) · 기준일을 모르면 접지 않는다', () => {
    assert.equal(classifyRemoteOnly({ versions: null }).known, false)
    const r = classifyRemoteOnly({ versions: ['20200101000000'], localDir: join(dir, 'none') })
    assert.deepEqual(r.violations, ['20200101000000'])
    assert.deepEqual(r.oldNumbering, [])
  })
})

describe('러너 클론 찾기 — 적혀 있을 때만 · 추측하지 않는다', () => {
  test('아무 데도 적혀 있지 않으면 dir=null · configured=false', () => {
    const root = join(dir, 'p0'); mkdirSync(root, { recursive: true })
    const r = resolveRunnerClone(join(dir, 'st0'), root)
    assert.equal(r.dir, null)
    assert.equal(r.configured, false)
  })
  test('sources.json 의 runnerClone(상대 경로 허용)을 읽는다 · 폴더가 없으면 configured=true 인 채 dir=null', () => {
    const root = join(dir, 'p1')
    mkdirSync(join(dir, 'clone1'), { recursive: true })
    put('p1/tools/dev-status/sources.json', JSON.stringify({ runnerClone: '../clone1' }))
    const r = resolveRunnerClone(join(dir, 'st1'), root)
    assert.equal(r.dir, join(dir, 'clone1'))
    assert.equal(r.why, 'tools/dev-status/sources.json')
    put('p2/tools/dev-status/sources.json', JSON.stringify({ runnerClone: '../no-such-clone' }))
    const r2 = resolveRunnerClone(join(dir, 'st2'), join(dir, 'p2'))
    assert.equal(r2.dir, null)
    assert.equal(r2.configured, true)
    assert.match(r2.why, /실존하지 않음/)
  })
  test('상태 폴더의 chain-info.json 이 먼저다', () => {
    mkdirSync(join(dir, 'clone3'), { recursive: true })
    put('st3/chain-info.json', JSON.stringify({ runnerClone: join(dir, 'clone3') }))
    put('p3/tools/dev-status/sources.json', JSON.stringify({ runnerClone: '../clone1' }))
    const r = resolveRunnerClone(join(dir, 'st3'), join(dir, 'p3'))
    assert.equal(r.dir, join(dir, 'clone3'))
    assert.match(r.why, /chain-info/)
  })
})

describe('러너 실황 — slots.log 해석', () => {
  test('로그가 없으면 available=false(추측하지 않는다)', () => {
    assert.deepEqual(parseRunner(join(dir, 'no-state')), { available: false })
  })
  test('열린 배치 헤더 + 잠금 + 최근 로그 = 작업 중 · 스토리·단계·모델을 읽는다', () => {
    put('st5/runner.lock', '')
    put('st5/slots.log', [
      '실행 대상 배치: 3건 · 오늘 누계 4',
      '==== AUTO-1: 3-2 (병렬 2폭 시도) ====',
      '→ [3-2-sample] dev (model=opus, 1/3)',
      '→ [3-4-other] review (model=sonnet)',
    ].join('\n'))
    const r = parseRunner(join(dir, 'st5'))
    assert.equal(r.available, true)
    assert.equal(r.running, true)
    assert.equal(r.batch.parallel, 2)
    assert.equal(r.queueSize, 3)
    assert.equal(r.today, 4)
    assert.deepEqual(r.stories.map((s) => s.key + ':' + s.stage + ':' + s.model), ['3-2-sample:dev:opus', '3-4-other:review:sonnet'])
  })
  test('완료 표식이 있으면 닫힌 배치 — 작업 중이 아니다', () => {
    put('st6/slots.log', '==== AUTO-2: 3-5 ====\n→ [3-5-x] dev (model=opus)\n배치 완료\n- 완주: 3-5-x\n')
    const r = parseRunner(join(dir, 'st6'))
    assert.equal(r.running, false)
    assert.equal(r.lastDone, '3-5-x')
  })
})
