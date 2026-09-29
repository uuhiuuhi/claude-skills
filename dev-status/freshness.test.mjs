// dev-status 신선도 검토 — 「이 화면이 지금을 반영하는가」 판정 규칙.
// 순수 함수라 픽스처만으로 전 분기를 실측한다(파일·네트워크·시계 의존 0 — now 는 인자로 준다).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { freshnessChecks, freshnessVerdict } from './freshness.mjs'

const NOW = Date.parse('2026-09-21T07:40:00+09:00')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const MIN = 60000
const HOUR = 3600000
const DAY = 86400000

/** 전 항목이 ok 로 나오는 기준 재료 — 각 테스트는 여기서 한 조각만 바꾼다. */
function fresh(over = {}) {
  const base = {
    generatedAt: iso(1 * MIN),
    batch: { heartbeat: { state: 'ok', label: '슬롯 심박 정상 · 3분 전', why: '', ageMin: 3, lines: ['마지막 줄'] } },
    freshness: {
      git: { available: true, head: 'a'.repeat(40), headShort: 'aaaaaaaa', headAt: iso(2 * HOUR),
        branch: 'main', originMain: 'a'.repeat(40), originShort: 'aaaaaaaa', behind: 0, ahead: 0, dirty: 0 },
      sprint: { file: 's.yaml', mtime: iso(2 * HOUR), gitAt: iso(2 * HOUR), commentDate: '2026-09-18', commentCount: 88 },
      docs: { epics: 13, stories: 122, hashStories: 19, sprintOnly: 0, docOnly: 0, duplicateEpics: [] },
      runner: { stateDir: 'C:/state', lockExists: true, lastLine: '마지막 줄' },
      manifests: { lastAt: iso(3 * HOUR), count: 1433, runnerLastAt: iso(2 * HOUR), runnerCount: 1442,
        runnerDir: 'C:/clone/logs', runnerWhy: 'tools/dev-status/sources.json', runnerConfigured: true },
      migration: { applicable: true, measuredAt: iso(1 * DAY), measuredCount: 193, localCount: 193,
        latestFile: '2026_x.sql', fresh: 'fresh', malformed: false, wrongProject: false, projectUnverified: false },
      inbox: { file: 'i.md', mtime: iso(3 * HOUR), gitAt: iso(3 * HOUR) },
    },
  }
  const f = { ...base.freshness }
  for (const [k, v] of Object.entries(over.freshness ?? {})) f[k] = v === null ? null : { ...f[k], ...v }
  return { ...base, ...over, freshness: f }
}

const run = (data) => freshnessChecks(data, { now: NOW })
const byId = (data) => Object.fromEntries(run(data).map((c) => [c.id, c]))

describe('신선도 — 항목 8개가 전부 나오고 모양이 같다', () => {
  test('① id·label·status·detail·action 을 갖춘 8줄', () => {
    const cs = run(fresh())
    assert.equal(cs.length, 8)
    assert.deepEqual(cs.map((c) => c.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'])
    for (const c of cs) {
      assert.ok(c.label, c.id + ' 에 이름이 없다')
      assert.ok(['ok', 'warn', 'stale', 'unknown', 'na'].includes(c.status), c.id + ' 의 status 가 규격 밖: ' + c.status)
      assert.ok(c.detail, c.id + ' 에 설명이 없다')
      assert.equal(typeof c.action, 'string')
    }
    assert.deepEqual(cs.map((c) => c.status), Array(8).fill('ok'))
  })

  test('② 재료가 통째로 없으면 전부 unknown — 빈 화면이나 예외가 아니다', () => {
    const cs = freshnessChecks({}, { now: NOW })
    assert.equal(cs.length, 8)
    assert.deepEqual([...new Set(cs.map((c) => c.status))], ['unknown'])
  })
})

describe('F1 읽는 폴더 — 뒤처지면 stale · 미커밋이면 warn · git 없으면 unknown', () => {
  test('③ origin/main 보다 뒤처지면 stale 이고 커밋 수를 적는다', () => {
    const c = byId(fresh({ freshness: { git: { behind: 7 } } })).F1
    assert.equal(c.status, 'stale')
    assert.match(c.detail, /7커밋 뒤/)
    assert.match(c.detail, /다른 폴더\/갈래/)
  })

  test('④ 최신이지만 저장 안 한 변경이 있으면 warn', () => {
    const c = byId(fresh({ freshness: { git: { dirty: 3 } } })).F1
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /3건/)
  })

  test('⑤ git 을 못 읽거나 origin/main 기록이 없으면 unknown — ok 로 적지 않는다', () => {
    assert.equal(byId(fresh({ freshness: { git: { available: false } } })).F1.status, 'unknown')
    const noRemote = byId(fresh({ freshness: { git: { behind: null, ahead: null } } })).F1
    assert.equal(noRemote.status, 'unknown')
    assert.match(noRemote.action, /git fetch/)
  })
})

describe('F2 상태 파일 — 근거는 주석이 아니라 파일·커밋 시각', () => {
  test('⑥ 3일 넘게 안 바뀌면 warn · 주석 날짜는 참고로만 적는다', () => {
    const c = byId(fresh({ freshness: { sprint: { mtime: iso(5 * DAY), gitAt: iso(5 * DAY) } } })).F2
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /파일 머리 주석의 가장 최근 날짜 2026-09-18/)
    assert.match(c.detail, /같은 주석 88줄 중/)
  })

  test('⑦ 주석이 옛날이어도 커밋 시각이 최근이면 ok — 주석에 끌려가지 않는다', () => {
    const c = byId(fresh({ freshness: { sprint: { commentDate: '2026-01-01', gitAt: iso(30 * MIN) } } })).F2
    assert.equal(c.status, 'ok')
  })

  test('⑧ 시각 근거가 하나도 없으면 unknown', () => {
    const c = byId(fresh({ freshness: { sprint: { mtime: null, gitAt: null } } })).F2
    assert.equal(c.status, 'unknown')
  })
})

describe('F3 문서 정합 — `####` 스토리와 중복 에픽 절을 함께 밝힌다', () => {
  test('⑨ 한쪽에만 있는 스토리가 있으면 warn 이고 건수를 적는다', () => {
    const c = byId(fresh({ freshness: { docs: { sprintOnly: 11, docOnly: 1 } } })).F3
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /상태 파일에만 있는 스토리 11건/)
    assert.match(c.detail, /에픽 문서에만 있는 스토리 1건/)
    assert.match(c.action, /12건/)
  })

  test('⑩ `#### Story` 건수와 중복 에픽 절은 ok 여도 detail 에 남는다', () => {
    const c = byId(fresh({ freshness: { docs: { duplicateEpics: [{ num: 1, sections: 2 }, { num: 2, sections: 2 }] } } })).F3
    assert.equal(c.status, 'ok')
    assert.match(c.detail, /#### Story` 19건/)
    assert.match(c.detail, /두 곳\(요약 목록 \+ 본문\)으로 나뉜 것 2개/)
  })
})

describe('F4 러너 심박 — 조용하면 warn · 로그가 없으면 unknown', () => {
  test('⑪ lock 은 있는데 75분 넘게 조용하면 warn', () => {
    const c = byId(fresh({ batch: { heartbeat: { state: 'alarm', label: '심박 없음 · 120분째 조용',
      why: 'lock 은 잡혀 있는데 로그가 45분 넘게 멈췄습니다', ageMin: 120, lines: [] } } })).F4
    assert.equal(c.status, 'warn')
    assert.match(c.action, /예약 실행이 도는지/)
  })

  test('⑫ slots.log 가 없으면 unknown', () => {
    const c = byId(fresh({ batch: { heartbeat: { state: 'none', label: '러너 로그 없음', why: '', ageMin: null, lines: [] } } })).F4
    assert.equal(c.status, 'unknown')
  })
})

describe('F5 배치 재료 — 러너 클론이 더 최신이면 stale · 설정이 없으면 이 폴더만', () => {
  test('⑬ 이 폴더가 러너 클론보다 반나절 넘게 뒤면 stale', () => {
    const c = byId(fresh({ freshness: { manifests: { lastAt: iso(3 * DAY), runnerLastAt: iso(2 * HOUR) } } })).F5
    assert.equal(c.status, 'stale')
    assert.match(c.detail, /러너 클론의 마지막 배치/)
    assert.match(c.action, /진짜 0 이 아니었습니다/)
  })

  test('⑭ 러너 클론 경로가 적혀 있는데 폴더를 못 찾으면 unknown 이고 어디에 적는지 알려 준다', () => {
    const c = byId(fresh({ freshness: { manifests: { runnerDir: null, runnerLastAt: null, runnerCount: 0,
      runnerWhy: 'sources.json 의 경로가 실존하지 않음' } } })).F5
    assert.equal(c.status, 'unknown')
    assert.match(c.action, /runnerClone/)
  })

  test('⑮ 두 자리 모두 하루를 넘겼으면 warn — 「진짜 0」이라고 적는다', () => {
    // 두 자리가 서로 비슷하게 낡은 경우 — 「이 폴더만 뒤처짐(stale)」이 아니라 진짜 배치가 없던 것이다
    const c = byId(fresh({ freshness: { manifests: { lastAt: iso(2 * DAY), runnerLastAt: iso(2 * DAY + HOUR) } } })).F5
    assert.equal(c.status, 'warn')
    assert.match(c.action, /진짜 0/)
  })

  test('⑮-2 러너 클론 설정이 아예 없으면 이 폴더 기록만 판정하고 그 사실을 적는다', () => {
    const only = { runnerConfigured: false, runnerDir: null, runnerLastAt: null, runnerCount: 0 }
    const ok = byId(fresh({ freshness: { manifests: only } })).F5
    assert.equal(ok.status, 'ok')
    assert.match(ok.detail, /모두 1433건/)
    assert.match(ok.detail, /이 폴더 기록만 봤습니다/)
    const none = byId(fresh({ freshness: { manifests: { ...only, lastAt: null, count: 0 } } })).F5
    assert.equal(none.status, 'unknown', '배치 기록이 없으면 0 으로 단정하지 않는다')
    const old = byId(fresh({ freshness: { manifests: { ...only, lastAt: iso(2 * DAY) } } })).F5
    assert.equal(old.status, 'warn')
  })
})

describe('F6 마이그레이션 실측 — 잰 뒤 파일이 달라졌으면 stale', () => {
  test('⑯ 실측 당시 개수와 지금 개수가 다르면 stale + 다시 재는 명령', () => {
    const c = byId(fresh({ freshness: { migration: { measuredCount: 69, localCount: 193, fresh: 'changed' } } })).F6
    assert.equal(c.status, 'stale')
    assert.match(c.detail, /69개 vs 지금 이 폴더 193개/)
    assert.match(c.action, /probe-migrations.mjs/)
  })

  test('⑰ 7일이 넘으면 warn · 측정 기록이 없으면 unknown(0 이 아니다)', () => {
    assert.equal(byId(fresh({ freshness: { migration: { fresh: 'stale' } } })).F6.status, 'warn')
    const none = byId(fresh({ freshness: { migration: { measuredAt: '', fresh: 'none' } } })).F6
    assert.equal(none.status, 'unknown')
    assert.match(none.detail, /못 쟀음/)
  })

  test('⑰-2 개발용 프로젝트 식별자 설정이 없으면 unknown · 다른 프로젝트를 쟀으면 stale', () => {
    const u = byId(fresh({ freshness: { migration: { projectUnverified: true } } })).F6
    assert.equal(u.status, 'unknown')
    assert.match(u.action, /devProjectRef/)
    assert.equal(byId(fresh({ freshness: { migration: { wrongProject: true } } })).F6.status, 'stale')
  })

  test('⑰-3 마이그레이션 폴더가 없는 프로젝트는 na(해당 없음) — 종합 판정에 넣지 않는다', () => {
    const cs = run(fresh({ freshness: { migration: null } }))
    const f6 = cs.find((c) => c.id === 'F6')
    assert.equal(f6.status, 'unknown', '재료 자체가 없으면 unknown')
    const na = run(fresh({ freshness: { migration: { applicable: false, dir: 'db/migrations' } } }))
    assert.equal(na.find((c) => c.id === 'F6').status, 'na')
    assert.equal(freshnessVerdict(na).level, 'ok', 'na 는 🟢 을 막지도, 올려 주지도 않는다')
  })
})

describe('F7·F8 — 인박스와 화면 생성 시각', () => {
  test('⑱ 인박스가 일주일 넘게 그대로면 warn · 근거가 없으면 unknown', () => {
    assert.equal(byId(fresh({ freshness: { inbox: { mtime: iso(9 * DAY), gitAt: iso(9 * DAY) } } })).F7.status, 'warn')
    assert.equal(byId(fresh({ freshness: { inbox: { mtime: null, gitAt: null } } })).F7.status, 'unknown')
  })

  test('⑲ 화면을 만든 지 10분이 넘으면 warn(새로고침 안내) · 못 읽으면 unknown', () => {
    assert.equal(byId(fresh({ generatedAt: iso(40 * MIN) })).F8.status, 'warn')
    assert.equal(byId(fresh({ generatedAt: 'not-a-date' })).F8.status, 'unknown')
  })
})

describe('종합 판정 4분기 — 확인 못 한 것을 🟢 로 적지 않는다', () => {
  const mk = (...statuses) => statuses.map((s, i) => ({ id: 'F' + (i + 1), label: 'x', status: s, detail: 'd', action: '' }))

  test('⑳ stale 이 하나라도 있으면 🔴', () => {
    const v = freshnessVerdict(mk('ok', 'warn', 'stale', 'unknown'))
    assert.equal(v.level, 'stale')
    assert.match(v.label, /🔴/)
    assert.deepEqual(v.counts, { ok: 1, warn: 1, stale: 1, unknown: 1, na: 0 })
  })

  test('㉑ warn 만 있으면 🟡', () => {
    const v = freshnessVerdict(mk('ok', 'warn', 'unknown'))
    assert.equal(v.level, 'warn')
    assert.match(v.label, /🟡/)
  })

  test('㉒ 전부 ok 면 🟢', () => {
    const v = freshnessVerdict(mk('ok', 'ok'))
    assert.equal(v.level, 'ok')
    assert.match(v.label, /🟢/)
  })

  test('㉓ ok 와 unknown 만 있으면 ⚪ 판정 불가 — ok 로 올려치지 않는다', () => {
    const v = freshnessVerdict(mk('ok', 'ok', 'unknown'))
    assert.equal(v.level, 'unknown')
    assert.match(v.label, /⚪/)
    assert.match(v.why, /확인 못 한 것을/)
  })

  test('㉔ 항목이 하나도 없으면 ⚪ (빈 배열·잘못된 입력)', () => {
    assert.equal(freshnessVerdict([]).level, 'unknown')
    assert.equal(freshnessVerdict(null).level, 'unknown')
    assert.equal(freshnessVerdict(mk('na', 'na')).level, 'unknown', '전부 해당 없음이면 판정할 것이 없다')
  })

  test('㉕ 실제 재료 한 벌을 그대로 넣어도 4분기 안에서만 움직인다', () => {
    assert.equal(freshnessVerdict(run(fresh())).level, 'ok')
    assert.equal(freshnessVerdict(run(fresh({ freshness: { git: { behind: 2 } } }))).level, 'stale')
    assert.equal(freshnessVerdict(run(fresh({ freshness: { git: { dirty: 1 } } }))).level, 'warn')
    assert.equal(freshnessVerdict(freshnessChecks({}, { now: NOW })).level, 'unknown')
  })
})
