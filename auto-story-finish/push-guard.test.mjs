// push 최종 게이트 — **실제 임시 git 저장소 + 실제 bare origin** 으로 문다(스텁 없음).
//
// 무엇을 증명하나(2026-09-03 👤 「무료 운영 안전장치」): GitHub Free 는 비공개 저장소 `main` 을 서버가 막지
// 못한다(룰셋 API 403 · Team 플랜 필요). 그래서 「무인 경로는 `main` 에 push 하지 않는다」가 **코드로** 성립하는지를
// 원격 ref 의 실제 변화로 확인한다 — 거부됐다고 말하는 것과 원격이 안 움직인 것은 다른 사실이다.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prePushScan, pushRefVerdict, safeGitPush } from './push-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const ok = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`) }
const tmps = []
after(() => { for (const T of tmps) { try { rmSync(T, { recursive: true, force: true }) } catch { /* OS 가 정리 */ } } })

/** 실제 bare origin + 클론 하나. main 에 초기 커밋이 올라가 있다. */
function makeRepo() {
  const T = mkdtempSync(join(tmpdir(), 'push-guard-'))
  tmps.push(T)
  const origin = join(T, 'origin.git'), proj = join(T, 'proj')
  ok(git(T, ['init', '-q', '--bare', origin]), 'bare')
  ok(git(T, ['clone', '-q', origin, proj]), 'clone')
  for (const [k, v] of [['user.email', 'g@test'], ['user.name', 'g'], ['core.autocrlf', 'false']]) ok(git(proj, ['config', k, v]), 'cfg')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'src', 'keep.ts'), 'export const keep = 1\n')
  ok(git(proj, ['add', '-A']), 'add')
  ok(git(proj, ['commit', '-q', '-m', 'init']), 'commit')
  ok(git(proj, ['push', '-q', 'origin', 'HEAD:main']), 'push')
  ok(git(proj, ['branch', '-q', '-M', 'main']), 'branch')
  ok(git(proj, ['fetch', '-q', 'origin']), 'fetch')
  return { T, origin, proj }
}
const heads = (proj) => git(proj, ['ls-remote', '--heads', 'origin']).stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[1]).sort()
function commitOn(proj, branch, files) {
  ok(git(proj, ['switch', '-q', '-C', branch]), `switch ${branch}`)
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(proj, dirname(p)), { recursive: true }); writeFileSync(join(proj, p), body) }
  ok(git(proj, ['add', '-A']), 'add')
  ok(git(proj, ['commit', '-q', '-m', `work on ${branch}`]), 'commit')
}

describe('[push-guard] ref 판정 — 보호 이름·refspec·불일치는 전부 거부', () => {
  it('main·master 등 보호 이름은 거부한다', () => {
    for (const b of ['main', 'master', 'Main', 'MAIN', 'develop', 'production', 'release']) {
      assert.match(pushRefVerdict(b, b), /보호 브랜치 직접 push 금지/, b)
    }
  })
  it('`HEAD:main` 형 refspec·와일드카드·공백은 브랜치명이 아니다', () => {
    for (const b of ['HEAD:main', 'auto/x:main', 'refs/heads/main', 'auto/*', 'auto/a b', 'auto/x^']) {
      assert.match(pushRefVerdict(b, b), /refspec·메타문자 금지/, b)
    }
  })
  it('auto/ 가 아닌 평범한 브랜치도 무인 push 대상이 아니다 · 빈 값·옵션형도 거부', () => {
    assert.match(pushRefVerdict('feature/x', 'feature/x'), /auto\/\* 브랜치만/)
    assert.match(pushRefVerdict('', 'main'), /비어 있다/)
    assert.match(pushRefVerdict('--force', 'main'), /옵션처럼/)
  })
  it('현재 브랜치와 push 대상이 다르면 거부한다(파싱 이후의 전환을 잡는다)', () => {
    assert.match(pushRefVerdict('auto/2026-09-03', 'main'), /현재 브랜치\(main\)/)
  })
  it('auto/* 이고 현재 브랜치와 같으면 통과(과잉 차단도 결함이다)', () => {
    assert.equal(pushRefVerdict('auto/2026-09-03', 'auto/2026-09-03'), '')
    assert.equal(pushRefVerdict('auto/2026-09-03', null), '')
  })
})

describe('[push-guard] 실제 bare origin — 거부되면 원격 ref 가 움직이지 않는다', () => {
  it('main 에 서서 ref=main 으로 밀면 거부 · 원격 main sha 불변', () => {
    const fx = makeRepo()
    const before = git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim()
    writeFileSync(join(fx.proj, 'src', 'keep.ts'), 'export const keep = 2\n')
    ok(git(fx.proj, ['commit', '-q', '-am', 'sneak to main']), 'commit')
    const r = safeGitPush({ cwd: fx.proj, ref: 'main' })
    assert.equal(r.pushed, false)
    assert.match(r.verdict, /보호 브랜치 직접 push 금지/)
    assert.equal(git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim(), before, '원격 main 이 움직였다')
  })
  it('refspec(`HEAD:main`)은 애초에 만들 수 없다 — 거부 · 원격 ref 목록 불변', () => {
    const fx = makeRepo()
    const before = heads(fx.proj)
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const a = 1\n' })
    const r = safeGitPush({ cwd: fx.proj, ref: 'HEAD:main' })
    assert.equal(r.pushed, false)
    assert.match(r.verdict, /refspec·메타문자 금지/)
    assert.deepEqual(heads(fx.proj), before)
  })
  it('auto/* 로 서 있는데 ref 만 main 이면(설정 오류형) 거부', () => {
    const fx = makeRepo()
    const before = heads(fx.proj)
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const a = 1\n' })
    assert.equal(safeGitPush({ cwd: fx.proj, ref: 'main' }).pushed, false)
    assert.deepEqual(heads(fx.proj), before)
  })
  it('정상 경로 — auto/2026-09-03 은 실제로 1개 ref 만 늘어난다(main 은 그대로)', () => {
    const fx = makeRepo()
    const mainBefore = git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim()
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const a = 1\n' })
    const r = safeGitPush({ cwd: fx.proj, ref: 'auto/2026-09-03' })
    assert.equal(r.pushed, true, r.out)
    assert.deepEqual(heads(fx.proj), ['refs/heads/auto/2026-09-03', 'refs/heads/main'])
    assert.equal(git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim(), mainBefore, '정본 main 이 함께 움직였다')
    const local = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    assert.ok(git(fx.proj, ['ls-remote', 'origin', 'auto/2026-09-03']).stdout.includes(local))
  })
})

describe('[push-guard] push 전 내용 검사 — 금지 경로·시크릿은 원격에 나가지 않는다', () => {
  it('secrets/app.pem 이 섞이면 거부 · 원격 불변', () => {
    const fx = makeRepo()
    const before = heads(fx.proj)
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const a = 1\n', 'secrets/app.pem': 'body\n' })
    const r = safeGitPush({ cwd: fx.proj, ref: 'auto/2026-09-03' })
    assert.equal(r.pushed, false)
    assert.match(r.verdict, /금지 경로/)
    assert.deepEqual(heads(fx.proj), before)
  })
  it('추가 줄에 실제 값이 붙은 토큰이 있으면 거부 · 사유에 원문이 남지 않는다', () => {
    const fx = makeRepo()
    const before = heads(fx.proj)
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const k = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"\n' })
    const r = safeGitPush({ cwd: fx.proj, ref: 'auto/2026-09-03' })
    assert.equal(r.pushed, false)
    assert.match(r.verdict, /시크릿 패턴/)
    assert.ok(!r.verdict.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), `사유에 원문이 남았다: ${r.verdict}`)
    assert.deepEqual(heads(fx.proj), before)
  })
  it('`.env.example` 견본은 금지 경로가 아니다(화이트리스트 대상 — 과잉 차단도 결함)', () => {
    const fx = makeRepo()
    commitOn(fx.proj, 'auto/2026-09-03', { '.env.example': 'SUPABASE_URL=\n' })
    assert.deepEqual(prePushScan({ cwd: fx.proj }).denied, [])
    assert.equal(safeGitPush({ cwd: fx.proj, ref: 'auto/2026-09-03' }).pushed, true)
  })
  it('검사 범위 = origin/main 과의 merge-base..HEAD — main 에서 내려온 몫은 이번 push 의 책임이 아니다', () => {
    const fx = makeRepo()
    commitOn(fx.proj, 'auto/2026-09-03', { 'src/a.ts': 'export const a = 1\n' })
    const s = prePushScan({ cwd: fx.proj })
    assert.deepEqual(s.files, ['src/a.ts'], JSON.stringify(s.files))
  })
})

describe('[push-guard] 두 설치 경로의 사본은 어긋나지 않는다 · 무인 경로에 날 push 가 없다', () => {
  it('auto-story-finish/push-guard.mjs 와 night-batch-ops/engine/push-guard.mjs 는 내용이 같다', () => {
    const a = readFileSync(join(here, 'push-guard.mjs'), 'utf8').replace(/\r\n/g, '\n')
    const b = readFileSync(join(here, '..', 'night-batch-ops', 'engine', 'push-guard.mjs'), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(a, b, '두 사본이 어긋났다 — 한쪽만 고치면 다른 경로가 뚫린다')
  })
  it('엔진·러너 소스에 `git push` 직접 호출이 없다(유일한 경로 = safeGitPush)', () => {
    const engine = readFileSync(join(here, 'auto-story-pipeline.mjs'), 'utf8')
    const runner = readFileSync(join(here, '..', 'night-batch-ops', 'engine', 'run-night.mjs'), 'utf8')
    assert.ok(!/git\(\["push"/.test(engine), '엔진에 날 push 가 남았다')
    assert.ok(!/spawnSync\('git', \['push'/.test(runner), '러너에 날 push 가 남았다')
    assert.ok(engine.includes('safeGitPush({ ref: branchName })'), '엔진이 safeGitPush 를 쓰지 않는다')
    assert.ok(runner.includes('safeGitPush({ ref: BRANCH })'), '러너가 safeGitPush 를 쓰지 않는다')
    assert.ok(engine.includes('process.exit(6);') && engine.includes('PUSH GUARD STOP'), '엔진 거부는 exit 6 이어야 한다')
  })
})
