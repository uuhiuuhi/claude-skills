// push 최종 게이트 — 「무엇을 어느 ref 로 미는가」를 `git push` **직전에 다시** 본다.
// (2026-09-03 👤 확정 「무료 운영 안전장치 ②」 — GitHub Free 는 비공개 저장소 main 을 서버가 막지 못한다.
//  룰셋/브랜치 보호 API 가 403(Team 플랜 필요)이므로, 서버 대신 **코드가** 마지막 문을 잠근다.)
//
// 왜 인자 파싱 시점의 `--branch auto/…` 검사만으로는 부족한가:
//   ① 파싱 이후에 브랜치가 바뀔 수 있다(워커 조작 · 러너 승계 · 설정 오류).
//   ② `git push origin HEAD:main` 형 refspec 은 브랜치명 검사를 통째로 우회한다.
//   ③ 러너·엔진 두 경로가 각자 push 하므로 검사도 두 경로 모두에 있어야 한다.
// 그래서 이 모듈이 **실제 push 를 소유**한다 — 호출부는 ref 만 준다. refspec 은 만들 수 없다.
//
// ⚠️ 이 파일은 `night-batch-ops/engine/push-guard.mjs` 와 **바이트 동일**해야 한다(설치 경로가 다르다 —
//    엔진은 ~/.claude/skills/auto-story-finish/, 러너는 프로젝트 tools/auto/). push-guard.test.mjs 가 문다.
import { spawnSync } from 'node:child_process'

/** 사람 승인 머지로만 바뀌는 이름들 — 무인 경로는 어떤 형태로도 여기에 push 하지 않는다. */
export const PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'development', 'prod', 'production', 'release', 'stable']
const PROTECTED_RE = new RegExp(`^(${PROTECTED_BRANCHES.join('|')})$`, 'i')
// `HEAD:main` · `refs/heads/*` · 와일드카드 · 공백 — 단일 브랜치명이 아닌 것은 전부 거부한다.
const REFSPEC_RE = /[:\s~^?*[\]\\]/

/** 무인 커밋·푸시가 절대 실어서는 안 되는 경로(.env.example 류 견본은 예외 — 화이트리스트 대상). */
export const DENY_PATH_RE = /(^|\/)(\.env(\.(?!example$|sample$|template$).*)?$|.*\.local\.[^/]+$|scratch-[^/]*$|.*\.(pem|key|p12|pfx)$|.*secrets?\.(json|ya?ml)$)/i
export const DENY_LOG_RE = /\.log$/i
/** 값이 실제로 붙은 형태만 — 이름·정규식 정의는 통과(2026-08-17 오탐 STOP 교훈). */
export const SECRET_RES = [
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|OPENAI_API_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_SERVICE_ROLE_KEY|OUTBOX_DISPATCH_SECRET|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9_\-/+.]{16,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{24,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]
/** git 의 빈 트리 — origin/main 이 아직 없는 저장소에서 「처음부터 전부」를 가리킨다. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 })

/**
 * ref 하나가 무인 push 대상으로 적법한가. 빈 문자열 = 통과, 그 외 = 거부 사유(사람이 읽는 한 줄).
 * `current` 를 주면 「지금 서 있는 브랜치와 미는 브랜치가 같은가」까지 본다(파싱 이후의 전환을 잡는다).
 */
export function pushRefVerdict(ref, current = null) {
  const r = typeof ref === 'string' ? ref.trim() : ''
  if (!r) return 'push 대상 브랜치명이 비어 있다'
  if (r.startsWith('-')) return `push 대상이 옵션처럼 시작한다(${r})`
  if (/^refs\//i.test(r)) return `push 대상에 refspec·메타문자 금지 — 완전수식 ref 가 아니라 브랜치명이어야 한다(${r})`
  if (REFSPEC_RE.test(r)) return `push 대상에 refspec·메타문자 금지(${r}) — auto/<이름> 단일 브랜치명만 허용`
  if (PROTECTED_RE.test(r)) return `보호 브랜치 직접 push 금지(${r}) — 정본은 사람 승인 머지로만 바뀐다`
  if (!/^auto\//.test(r)) return `무인 push 는 auto/* 브랜치만 허용(${r})`
  const cur = typeof current === 'string' ? current.trim() : ''
  if (cur && cur !== r) return `현재 브랜치(${cur}) 와 push 대상(${r}) 이 다르다 — 밀지 않는다`
  return ''
}

export function currentBranch(cwd = process.cwd()) {
  return (git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? '').trim()
}

export function isDeniedPath(f) {
  return DENY_PATH_RE.test(f) || (DENY_LOG_RE.test(f) && !f.includes('auto-pipeline-logs/'))
}

/** diff 본문의 **추가 줄**만 본다(삭제 줄은 이미 저장소에 있던 것 — 새로 내보내는 값이 아니다). */
export function secretHits(diffText) {
  const hits = []
  for (const line of String(diffText ?? '').split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    for (const re of SECRET_RES) if (re.test(line)) { hits.push(line.slice(0, 80)); break }
  }
  return hits
}

/** origin/main(또는 master)과의 merge-base — 「이번에 세상에 내보내는 몫」의 시작점. */
export function prePushBase(cwd = process.cwd()) {
  for (const ref of ['origin/main', 'origin/master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue
    const mb = git(cwd, ['merge-base', ref, 'HEAD'])
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim()
  }
  return EMPTY_TREE
}

/** push 직전 내용 검사 — 금지 경로 · 시크릿. 엔진의 스테이징 검사를 지나온 뒤에도 한 번 더 본다
 *  (러너의 cherry-pick·매니페스트 커밋처럼 엔진 밖에서 생긴 커밋이 섞이기 때문). */
export function prePushScan({ cwd = process.cwd() } = {}) {
  const base = prePushBase(cwd)
  const names = (git(cwd, ['diff', '--name-only', base, 'HEAD']).stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  const denied = names.filter(isDeniedPath)
  const secrets = secretHits(git(cwd, ['diff', '--unified=0', base, 'HEAD']).stdout ?? '')
  return { base, files: names, denied, secrets }
}

/**
 * 유일한 무인 push 경로. 거부되면 `{ ok:false, verdict }` 로 돌아오고 **push 는 일어나지 않는다**.
 * `scan:false` 는 호출부가 방금 같은 검사를 마쳤을 때만(엔진의 스테이징 검사 직후) 쓴다.
 */
export function safeGitPush({ cwd = process.cwd(), ref, scan = true } = {}) {
  const current = currentBranch(cwd)
  const verdict = pushRefVerdict(ref, current)
  if (verdict) return { ok: false, pushed: false, verdict, current, status: null, out: '' }
  if (scan) {
    const s = prePushScan({ cwd })
    if (s.denied.length) return { ok: false, pushed: false, verdict: `금지 경로가 push 대상에 있다: ${s.denied.slice(0, 5).join(', ')}`, current, status: null, out: '' }
    if (s.secrets.length) return { ok: false, pushed: false, verdict: `push 대상 diff 에 시크릿 패턴 ${s.secrets.length}건(첫 줄: ${s.secrets[0].replace(/[A-Za-z0-9_-]{12,}/g, '***')})`, current, status: null, out: '' }
  }
  const r = git(cwd, ['push', '-u', 'origin', ref])
  return { ok: r.status === 0, pushed: r.status === 0, verdict: '', current, status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
