// 텔레그램 원격 명령 판정 규칙 + 폴러 통합(의존성 주입 · 네트워크·git 실호출 0).
// jng-os `tests/auto/telegram-rules.test.ts`(vitest)를 node:test 로 이식 — `node --test` 로 실행(의존성 0).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRM_TTL_MS, EXTEND_MAX, classifyPush, isAuthorizedSender, judgeMessage, matchConfirmation, mergeRefspec, newPending, parseCommand, parseExtend, partitionUnmerged, resetWindowStops } from './telegram-rules.mjs'

const ME = 12345
const msg = (text, chat = ME) => ({ text, chat: { id: chat } })

describe('[OPS-3] 명령 파서 — 허용 3개만 · 인자 거부(임의 ref 차단 · AC-4)', () => {
  it('정확한 명령·@봇 접미사만 인식하고, 인자·미등록 명령·일반 텍스트는 null', () => {
    assert.equal(parseCommand('/status'), '/status')
    assert.equal(parseCommand('  /merge@baroos_jng_bot '), '/merge')
    assert.equal(parseCommand('/resume'), '/resume')
    assert.equal(parseCommand('/merge feature/x'), null) // 인자 = 임의 브랜치 시도
    assert.equal(parseCommand('/deploy'), null) // 등급표 후속 — 파서에 없음
    assert.equal(parseCommand('/migrate'), null) // 불가 목록 — 파서에 없음
    assert.equal(parseCommand('안녕'), null)
    assert.equal(parseCommand(undefined), null)
  })
})

describe('[OPS-3] 발신자 검증 — chat_id 불일치는 명령 해석 없이 차단(AC-1)', () => {
  it('같은 chat_id(숫자/문자 혼재 허용)만 통과', () => {
    assert.equal(isAuthorizedSender(msg('/status'), ME), true)
    assert.equal(isAuthorizedSender(msg('/status', '12345'), ME), true)
    assert.equal(isAuthorizedSender(msg('/status', 999), ME), false)
    assert.equal(isAuthorizedSender(msg('/status'), null), false)
  })
  it('외부 발신은 /status 라도 blocked — 회신 대상 아님', () => {
    assert.deepEqual(judgeMessage({ message: msg('/status', 999), chatId: ME, pending: null, nowMs: 0 }), { kind: 'blocked' })
    // 외부 발신이 코드를 맞춰도 실행되지 않는다
    const p = newPending('/merge', 1234, 0)
    assert.deepEqual(judgeMessage({ message: msg('1234', 999), chatId: ME, pending: p, nowMs: 1 }), { kind: 'blocked' })
  })
})

describe('[OPS-3] 확인 코드 상태기 — TTL 안 같은 chat 의 코드 답장만 실행(AC-2·3)', () => {
  const p = newPending('/merge', 7, 1_000)
  it('코드는 4자리 0패딩 · 만료 = now+30분(👤 2026-08-28 Decision (a) — 폴링 주기 10분과의 경계 만료 방지)', () => {
    assert.equal(CONFIRM_TTL_MS, 30 * 60 * 1000)
    assert.deepEqual(p, { command: '/merge', code: '0007', expiresAt: 1_000 + CONFIRM_TTL_MS })
  })
  it('match / mismatch / expired / null(코드 아님)', () => {
    assert.equal(matchConfirmation(p, '0007', 2_000), 'match')
    assert.equal(matchConfirmation(p, '0008', 2_000), 'mismatch')
    assert.equal(matchConfirmation(p, '0007', 1_000 + CONFIRM_TTL_MS + 1), 'expired')
    assert.equal(matchConfirmation(null, '0007', 2_000), 'mismatch') // 대기 없는 코드 — 힌트 없음
    assert.equal(matchConfirmation(p, '/merge', 2_000), null)
  })
  it('judgeMessage 흐름: /merge → challenge · 코드 → execute · 만료 → expired · /status 즉시', () => {
    assert.deepEqual(judgeMessage({ message: msg('/merge'), chatId: ME, pending: null, nowMs: 0 }), { kind: 'challenge', command: '/merge' })
    assert.deepEqual(judgeMessage({ message: msg('0007'), chatId: ME, pending: p, nowMs: 2_000 }), { kind: 'execute', command: '/merge' })
    assert.deepEqual(judgeMessage({ message: msg('0007'), chatId: ME, pending: p, nowMs: 1_000 + CONFIRM_TTL_MS + 1 }), { kind: 'expired', command: '/merge' })
    assert.deepEqual(judgeMessage({ message: msg('9999'), chatId: ME, pending: p, nowMs: 2_000 }), { kind: 'mismatch' })
    assert.deepEqual(judgeMessage({ message: msg('/status'), chatId: ME, pending: null, nowMs: 0 }), { kind: 'status' })
    assert.deepEqual(judgeMessage({ message: msg('그냥 문자'), chatId: ME, pending: null, nowMs: 0 }), { kind: 'ignore' })
    // 코드 없이 /merge 만 반복하면 실행이 아니라 매번 되묻기 — 확인 없는 실행 경로 없음
    assert.deepEqual(judgeMessage({ message: msg('/merge'), chatId: ME, pending: p, nowMs: 2_000 }), { kind: 'challenge', command: '/merge' })
  })
})

describe('[OPS-3] ff 판정 — 원격 ff 전용 refspec · non-ff 는 강제 없음(AC-2)', () => {
  it('미머지 분류 — 원격은 머지 대상 · 로컬 미푸시는 구분(리뷰 3번 — 러너와 같은 재료)', () => {
    const names = ['origin/auto/2026-08-27', 'auto/2026-08-27', 'auto/2026-08-28-local', 'origin/main', 'feature/x']
    assert.deepEqual(partitionUnmerged(names), {
      remote: ['auto/2026-08-27'], // 로컬+원격 둘 다 미머지면 원격 쪽으로 머지 가능
      localOnly: ['auto/2026-08-28-local'], // 원격에 없음 — 폰에서 못 푼다(사람 필요)
    })
    assert.deepEqual(partitionUnmerged([]), { remote: [], localOnly: [] })
    assert.deepEqual(partitionUnmerged(undefined), { remote: [], localOnly: [] })
  })
  it('refspec 은 origin/auto/X:main 뿐 · auto/ 외는 예외', () => {
    assert.equal(mergeRefspec('auto/2026-08-27'), 'origin/auto/2026-08-27:main')
    assert.throws(() => mergeRefspec('main'))
    assert.throws(() => mergeRefspec('auto/x:main'))
  })
  it('push 결과: 0=ok · non-fast-forward/rejected=non-ff · 그 외=error', () => {
    assert.equal(classifyPush({ status: 0, stderr: '' }), 'ok')
    assert.equal(classifyPush({ status: 1, stderr: ' ! [rejected] origin/auto/x -> main (non-fast-forward)' }), 'non-ff')
    assert.equal(classifyPush({ status: 1, stderr: 'Updates were rejected... fetch first' }), 'non-ff')
    assert.equal(classifyPush({ status: 128, stderr: 'fatal: could not read from remote' }), 'error')
  })
})

describe('[OPS-3] 재개 — 이 창 stops 만 0 · 다른 창 불변(AC-3)', () => {
  it('resetWindowStops', () => {
    const s = { days: { '2026-08-28': { planned: ['2-1'] } }, windows: { '2026-08-28-day': { stops: 2 }, '2026-08-27-night': { stops: 1 } } }
    const n = resetWindowStops(s, '2026-08-28-day')
    assert.equal(n.windows['2026-08-28-day'].stops, 0)
    assert.equal(n.windows['2026-08-27-night'].stops, 1)
    assert.deepEqual(n.days, s.days)
    assert.equal(s.windows['2026-08-28-day'].stops, 2) // 원본 불변
    assert.equal(resetWindowStops(undefined, 'w').windows.w.stops, 0)
  })
  it('차단기 v2 호환 — stops 만 지우면 sigs 가 남아 재개가 헛돈다: 서명 스트릭·창 누적도 0', () => {
    const s = { windows: { w: { stops: 2, sigs: { '6|B': 2, '1|A': 1 }, total: 3 } } }
    const n = resetWindowStops(s, 'w')
    assert.deepEqual(n.windows.w, { stops: 0, sigs: {}, total: 0 })
    assert.equal(s.windows.w.sigs['6|B'], 2) // 원본 불변
  })
})

describe('[무정지 D5] /extend — 상한 연장(유일한 인자 명령 · 숫자 상한 잠금)', () => {
  it('parseExtend — 「/extend N」(1~30)만 · 범위 밖·비정수·인자 없음은 null', () => {
    assert.equal(EXTEND_MAX, 30)
    assert.equal(parseExtend('/extend 5'), 5)
    assert.equal(parseExtend('  /extend@baroos_jng_bot 30 '), 30)
    assert.equal(parseExtend('/extend 0'), null)
    assert.equal(parseExtend('/extend 45'), null) // 상한 밖 — 임의 대량 연장 차단
    assert.equal(parseExtend('/extend'), null)
    assert.equal(parseExtend('/extend abc'), null)
    assert.equal(parseExtend('/extend 5 5'), null)
    assert.equal(parseExtend(undefined), null)
  })
  it('judgeMessage — /extend N 은 N 을 담아 challenge(코드 확인 후 그 N 실행) · 형식 미달은 ignore', () => {
    assert.deepEqual(judgeMessage({ message: msg('/extend 5'), chatId: ME, pending: null, nowMs: 0 }),
      { kind: 'challenge', command: '/extend 5' })
    assert.deepEqual(judgeMessage({ message: msg('/extend'), chatId: ME, pending: null, nowMs: 0 }), { kind: 'ignore' })
    assert.deepEqual(judgeMessage({ message: msg('/extend 45'), chatId: ME, pending: null, nowMs: 0 }), { kind: 'ignore' })
    // 외부 발신은 여기서도 blocked
    assert.deepEqual(judgeMessage({ message: msg('/extend 5', 999), chatId: ME, pending: null, nowMs: 0 }), { kind: 'blocked' })
  })
})

describe('[OPS-3] 폴러 통합 — 의존성 주입(네트워크·git 0) · 원장·offset·pending 실파일', () => {
  let dir
  // pollOnce 는 import 시점에 STATE_DIR 을 읽는다 — env 를 먼저 세팅하고 동적 import
  // (이식본은 BAROOS_STATE_DIR 대신 AUTO_BATCH_STATE_DIR 을 읽는다 — telegram-commands.mjs 상단)
  let pollOnce
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'baroos-tg-'))
    process.env.AUTO_BATCH_STATE_DIR = dir
    writeFileSync(join(dir, 'telegram-token.txt'), 'TESTTOKEN\n', 'utf8')
    writeFileSync(join(dir, 'telegram-chat.json'), JSON.stringify({ chat_id: ME }), 'utf8')
    writeFileSync(join(dir, 'auto-plan-state.json'), JSON.stringify({ windows: { '2026-08-28-day': { stops: 2 } } }), 'utf8')
    ;({ pollOnce } = await import('./telegram-commands.mjs'))
  })
  after(() => { delete process.env.AUTO_BATCH_STATE_DIR; rmSync(dir, { recursive: true, force: true }) })

  const NOW = new Date(2026, 7, 28, 14, 0).getTime() // 2026-08-28-day 창
  const makeDeps = (updates, extra = {}) => {
    const sent = []
    const pushed = []
    let started = 0
    const deps = {
      now: () => NOW,
      code: () => 4242,
      getUpdates: async () => updates,
      send: async (_t, _c, text) => { sent.push(text) },
      fetchOrigin: () => ({ status: 0 }),
      unmergedRefs: () => ['origin/auto/2026-08-27'],
      countAhead: () => 3,
      push: (b) => { pushed.push(b); return { status: 0, stderr: '' } },
      lockAlive: () => null,
      removeLock: () => {},
      startRunner: () => { started++; return { started: true } },
      ...extra,
    }
    return { deps, sent, pushed, started: () => started }
  }
  const upd = (id, text, chat = ME) => ({ update_id: id, message: msg(text, chat) })

  it('외부 발신 → 무응답 + 원장 「외부 발신 차단」 · offset 전진', async () => {
    const { deps, sent, pushed } = makeDeps([upd(1, '/merge', 999)])
    await pollOnce(deps)
    assert.deepEqual(sent, [])
    assert.deepEqual(pushed, [])
    assert.ok(readFileSync(join(dir, 'telegram-commands.log'), 'utf8').includes('외부 발신 차단'))
    assert.equal(JSON.parse(readFileSync(join(dir, 'telegram-offset.json'), 'utf8')).offset, 2)
  })

  it('/merge → 코드 되묻기(push 0) → 코드 답장 → 원격 ff push 만 · 배포 없음', async () => {
    const a = makeDeps([upd(2, '/merge')])
    await pollOnce(a.deps)
    assert.deepEqual(a.pushed, [])
    assert.ok(a.sent[0].includes('4242'))
    const b = makeDeps([upd(3, '4242')])
    await pollOnce(b.deps)
    assert.deepEqual(b.pushed, ['auto/2026-08-27'])
    assert.ok(b.sent[0].includes('✅ auto/2026-08-27 → main (3커밋)'))
    assert.ok(b.sent[0].includes('배포는 하지 않았다'))
  })

  it('non-ff 거부 → 강제 없이 「사람 머지 필요」 회신', async () => {
    const a = makeDeps([upd(4, '/merge')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(5, '4242')], { push: () => ({ status: 1, stderr: '! [rejected] (non-fast-forward)' }) })
    await pollOnce(b.deps)
    assert.ok(b.sent[0].includes('갈라짐 — 아침에 사람 머지 필요'))
  })

  it('만료된 코드 → 재요청 안내 · 실행 없음', async () => {
    const a = makeDeps([upd(6, '/resume')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(7, '4242')], { now: () => NOW + CONFIRM_TTL_MS + 1 })
    await pollOnce(b.deps)
    assert.equal(b.started(), 0)
    assert.ok(b.sent[0].includes('만료'))
  })

  it('/resume → 이 창 stops=0 · 기동 「요청」 문구(성공 단정 금지 — 리뷰 2번) · 미머지 잔존이면 「/merge 먼저」', async () => {
    const a = makeDeps([upd(8, '/resume')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(9, '4242')], { lockAlive: () => false })
    await pollOnce(b.deps)
    assert.equal(b.started(), 1)
    assert.equal(JSON.parse(readFileSync(join(dir, 'auto-plan-state.json'), 'utf8')).windows['2026-08-28-day'].stops, 0)
    assert.ok(b.sent[0].includes('기동 요청')) // 「기동했다」 단정 금지
    // 무정지 개편(2026-08-30): 미머지 잔존은 「휴면」이 아니다 — 회신은 「휴면 아님 + 체인 의미」를 싣는다(종전 「/merge 먼저」 문구 폐지)
    assert.ok(b.sent[0].includes('미머지 auto/* 잔존') && b.sent[0].includes('휴면 아님'))
  })

  it('/resume 기동 실패(startRunner false) → 실패를 사실대로 회신(리뷰 2번)', async () => {
    const a = makeDeps([upd(10, '/resume')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(11, '4242')], { startRunner: () => ({ started: false, reason: 'run-night.mjs 없음(cwd=X)' }) })
    await pollOnce(b.deps)
    assert.ok(b.sent[0].includes('러너 기동 실패'))
  })

  it('/status → 읽기 전용 1메시지 · STOP 카운트는 state 실물을 읽는다(리뷰 6번 — 순서 의존 제거)', async () => {
    writeFileSync(join(dir, 'auto-plan-state.json'), JSON.stringify({ windows: { '2026-08-28-day': { stops: 2 } } }), 'utf8')
    const { deps, sent, pushed, started } = makeDeps([upd(12, '/status')], { lockAlive: () => true })
    await pollOnce(deps)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes('auto/2026-08-27'))
    assert.ok(sent[0].includes('STOP: 2회')) // ?? 0 기본값과 다른 값 — statusText 가 파일을 안 읽으면 RED
    assert.ok(sent[0].includes('실행 중'))
    assert.deepEqual(pushed, [])
    assert.equal(started(), 0)
  })

  it('/status 에 로컬 미푸시 auto/* 구분 표기(리뷰 3번) · fetch 실패는 스테일 경고(리뷰 4번)', async () => {
    const a = makeDeps([upd(13, '/status')], { unmergedRefs: () => ['origin/auto/2026-08-27', 'auto/2026-08-28-local'] })
    await pollOnce(a.deps)
    assert.ok(a.sent[0].includes('로컬 미푸시 auto/*: auto/2026-08-28-local'))
    const b = makeDeps([upd(14, '/status')], { fetchOrigin: () => ({ status: 128 }) })
    await pollOnce(b.deps)
    assert.ok(b.sent[0].includes('fetch 실패'))
  })

  it('fetch 실패 시 /merge 는 머지하지 않는다(리뷰 4번 — 스테일 성공 보고 차단)', async () => {
    const a = makeDeps([upd(15, '/merge')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(16, '4242')], { fetchOrigin: () => ({ status: 128 }) })
    await pollOnce(b.deps)
    assert.deepEqual(b.pushed, [])
    assert.ok(b.sent[0].includes('머지하지 않는다'))
  })

  it('--dry-run 은 실행형(execute)에서도 offset·pending·state 무변 · 발신·lock 삭제 없음(리뷰 5번)', async () => {
    // 실행형 경로를 직접 만든다 — pending 을 실파일로 심고 코드 답장을 dry-run 으로 처리
    writeFileSync(join(dir, 'telegram-pending.json'), JSON.stringify({ command: '/resume', code: '4242', expiresAt: NOW + 60_000 }), 'utf8')
    const stateBefore = readFileSync(join(dir, 'auto-plan-state.json'), 'utf8')
    const offsetBefore = readFileSync(join(dir, 'telegram-offset.json'), 'utf8')
    let removed = 0
    const { deps, sent } = makeDeps([upd(17, '4242')], { lockAlive: () => false, removeLock: () => { removed++ } })
    await pollOnce(deps, { dryRun: true })
    assert.deepEqual(sent, []) // 발신 0 — dry-send 원장만
    assert.equal(removed, 0) // 죽은 lock 판정이어도 dry-run 은 지우지 않는다
    assert.equal(readFileSync(join(dir, 'telegram-offset.json'), 'utf8'), offsetBefore) // offset 불변 — 진짜 폴러가 이 명령을 본다
    assert.equal(readFileSync(join(dir, 'auto-plan-state.json'), 'utf8'), stateBefore) // stops 무변
    assert.equal(existsSync(join(dir, 'telegram-pending.json')), true) // pending 보존
    rmSync(join(dir, 'telegram-pending.json')) // 다음 케이스 오염 방지
  })

  it('/resume 도 fetch 실패를 회신에 명시한다(재검수 N-1 — 스테일로 「/merge 먼저」 누락 방지)', async () => {
    const a = makeDeps([upd(30, '/resume')])
    await pollOnce(a.deps)
    const b = makeDeps([upd(31, '4242')], { fetchOrigin: () => ({ status: 128 }), unmergedRefs: () => [] })
    await pollOnce(b.deps)
    assert.ok(b.sent[0].includes('fetch 실패')) // fetchOk 를 버리는 뮤테이션 → RED
  })

  it('회신 1건 실패는 그 건만 격리 — offset 전진 유지 + 실패 통지 1회(리뷰 7번)', async () => {
    let calls = 0
    const { deps, sent } = makeDeps([upd(18, '/status'), upd(19, '/status')], {
      send: async (_t, _c, text) => { calls++; if (calls === 1) throw new Error('타임아웃'); sent.push(text) },
    })
    const r = await pollOnce(deps)
    assert.equal(r.handled, 1) // 실패 1건은 handled 에서 제외
    assert.equal(JSON.parse(readFileSync(join(dir, 'telegram-offset.json'), 'utf8')).offset, 20) // 그래도 offset 은 전진 — 재처리 없음
    assert.ok(sent.some((s) => s.includes('처리 실패 1건'))) // 무통보 아님
  })
})
