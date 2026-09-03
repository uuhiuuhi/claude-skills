// backlog.mjs — 진단 → 작업항목화 · 7단계 우선순위 · 보수 범주 · 실패 6분류 (SPEC §2·§5 · 설계 §1-2·§4).
//
// **전부 순수 함수다.** 파일도 프로세스도 건드리지 않는다 — 「무엇을 먼저 할까」는 재현 가능해야
// 사람이 다툴 수 있다(같은 진단을 넣으면 같은 백로그가 나온다).
//
// 세 가지를 분리해 둔다:
//   ① **무엇이 문제인가** = diagnose 의 findings (증거)
//   ② **무엇을 먼저 할까** = tier(7단계 · 배타) + score (이 파일)
//   ③ **같이 돌려도 되나** = 보수 범주(mode any) + conflicts 의 범주표 (이 파일 + conflicts.mjs)
//
// 왜 보수 범주를 따로 두나(SPEC §5): 인증·결제·DB·배포설정·공용핵심·시크릿은 **한 스토리만 만져도**
// 병렬을 포기한다. 서로 다른 파일을 고쳐도 결과가 갈라지는 부류라, 겹침 판정으로는 안 잡힌다.
// 자동으로 뭉개지 않고 **순차화**한다 — 속도가 품질 게이트를 완화하는 근거가 될 수 없다(운영 7원칙 ④).

import { createHash } from 'node:crypto'
import { CONFLICT_RULES, SHARED_BOOKKEEPING_DEFAULT, parallelHazardsExtended } from './conflicts.mjs'
import { storyRisk, storyDifficulty, HIGH_RISK_MIN } from './assign.mjs'
import { resolveAsf } from './asf-resolve.mjs'
const { classifyQaFailure } = await import(resolveAsf('quality-rules.mjs'))
import { tierOfFinding, SECRET_PATH_RE, SECRET_PATH_EXAMPLE_RE } from './diagnose.mjs'

export const BACKLOG_SCHEMA = 'night-batch-ops/backlog/1'

// ── 7단계 우선순위 (SPEC §2) ────────────────────────────────────────────────
export const TIERS = Object.freeze([
  { tier: 1, id: 'secret-data-auth', label: '비밀정보 노출·데이터 손실·인증/보안', why: '새면 되돌릴 수 없다' },
  { tier: 2, id: 'build-run', label: '빌드 실패·실행 불가·핵심 장애', why: '이게 빨간불이면 나머지 판정이 전부 무의미하다' },
  { tier: 3, id: 'deploy-block', label: '배포 차단', why: '고쳐도 사용자에게 못 나간다' },
  { tier: 4, id: 'core-flow', label: '핵심 흐름 미완', why: '사용자가 하려던 일이 끝나지 않는다' },
  { tier: 5, id: 'regression-test', label: '회귀·테스트 누락', why: '지금은 되지만 다음에 조용히 깨진다' },
  { tier: 6, id: 'perf-a11y', label: '성능·안정성·접근성', why: '되긴 되는데 쓰기 나쁘다' },
  { tier: 7, id: 'internal-docs', label: '내부 구조·문서', why: '사용자에게는 안 보이지만 다음 사람이 헤맨다' },
])
export const tierLabel = (t) => TIERS.find((x) => x.tier === t)?.label ?? '분류 밖'

const SEVERITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 })

// ── 보수 범주 (SPEC §5 · 설계 §4-2) ─────────────────────────────────────────
const base = (p) => String(p ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
const hasText = (t, needles) => needles.some((n) => String(t ?? '').includes(n))

/**
 * `conflicts.CONFLICT_RULES` 와 **같은 모양**(`{id,mode,label,why,test}`)이라 그대로 얹을 수 있다.
 * 전부 `mode:'any'` — 한 스토리만 만져도 병렬 불가다.
 */
export const CONSERVATIVE_RULES = Object.freeze([
  {
    id: 'secret-external', mode: 'any', label: '비밀정보·외부 연동',
    why: '열쇠·외부 발송 경로는 한쪽만 흔들려도 되돌릴 수 없는 사고가 난다',
    test: (p) => (SECRET_PATH_RE.test(p) && !SECRET_PATH_EXAMPLE_RE.test(p)) || /(^|\/)(outbox|teams|ntfy|telegram|webhook)s?\//i.test(p),
  },
  {
    id: 'auth-permission', mode: 'any', label: '인증·권한',
    why: '권한 규칙은 두 갈래가 동시에 바뀌면 어느 쪽이 이겼는지 사후에 알 수 없다',
    test: (p) => /(^|\/)src\/(auth|features\/auth)\//.test(p) || /_permissions?\.sql$/i.test(p) ||
      /(^|\/)src\/lib\/(auth|permissions?|rls)[^/]*\.[a-z]+$/i.test(p) || /(rls|policy|policies)[^/]*\.sql$/i.test(p),
  },
  {
    id: 'billing-payment', mode: 'any', label: '결제·청구',
    why: '돈이 오가는 경로는 병렬 실패의 비용이 코드가 아니라 청구서로 나온다',
    test: (p) => /(^|\/)src\/features\/(contracts|billing|payments?)\//.test(p) || /(^|\/)supabase\/functions\/[^/]*(billing|invoice|payment)/i.test(p),
  },
  {
    id: 'db-change', mode: 'any', label: 'DB 변경',
    why: '둘 다 마이그레이션을 만들면 번호가 경합하고 landing 후 순서가 뒤집힌다',
    test: (p) => /(^|\/)supabase\/migrations\//.test(p) || /(^|\/)migrations\/[^/]+\.sql$/.test(p),
  },
  {
    id: 'deploy-config', mode: 'any', label: '배포 설정',
    why: '배포 설정은 한쪽 변경이 다른 쪽 배포본을 바꾼다',
    test: (p) => /(^|\/)wrangler\.[a-z]+$/.test(p) || /(^|\/)tools\/deploy\//.test(p) || /(^|\/)\.github\/workflows\//.test(p),
  },
  {
    id: 'shared-core', mode: 'any', label: '공용 핵심',
    why: '앱 셸·라우트·공용 타입은 모든 화면이 함께 쓴다 — 한쪽 변경이 전부의 qa 를 바꾼다',
    test: (p) => /(^|\/)src\/lib\//.test(p) || /(^|\/)src\/App\.tsx$/.test(p) || /(^|\/)src\/types\//.test(p) || /(^|\/)src\/routes\.[a-z]+$/.test(p),
  },
])

/** `db-change` 가 `conflicts.migration` 을 **더 세게** 흡수한다 — 같은 사유를 두 번 세지 않는다. */
const SUPERSEDED_CONFLICT_IDS = new Set(['migration'])

/**
 * 병렬 판정 옵션 — `conflicts.parallelHazardsExtended(lists, opts)` 에 그대로 넘긴다.
 * `items` 는 참고용(향후 프로젝트별 예외를 붙일 자리) — 규칙 자체는 결정적이다.
 */
export function hazardOptsFor(items = []) {
  return {
    rules: [...CONSERVATIVE_RULES, ...CONFLICT_RULES.filter((r) => !SUPERSEDED_CONFLICT_IDS.has(r.id))],
    shared: SHARED_BOOKKEEPING_DEFAULT,
    items: items.length,
  }
}

// ── 우선순위 ────────────────────────────────────────────────────────────────
/**
 * finding 1건의 우선순위. **tier 는 배타** — kind 표에서 정확히 하나로 간다.
 * 예외 하나: 시크릿은 kind 가 무엇이든 **항상 tier 1** 로 끌어올린다(이월 금지 5범주 중 첫째).
 */
export function priorityOf(finding, ctx = {}) {
  const path = String(finding?.path ?? '')
  const secret = /secret/i.test(String(finding?.kind ?? '')) || (SECRET_PATH_RE.test(path) && !SECRET_PATH_EXAMPLE_RE.test(path))
  const tier = secret ? 1 : tierOfFinding(finding)
  const sev = SEVERITY_WEIGHT[finding?.severity] ?? 2
  const risk = Math.min(9, Number(ctx.risk ?? 0))
  const blockedPenalty = ctx.blocked ? 300 : 0
  const score = (8 - tier) * 1000 + sev * 100 + risk * 10 - blockedPenalty
  const why = secret && tierOfFinding(finding) !== 1
    ? `시크릿 경로라 tier 1 로 올린다(${tierLabel(1)})`
    : `${tierLabel(tier)} · 심각도 ${finding?.severity ?? 'medium'}${ctx.blocked ? ' · 사람 판단 대기로 감점' : ''}`
  return { tier, score, why }
}

// ── 작업항목화 ──────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')
const idOf = (fp) => `W-${fp.slice(0, 10)}`
const uniq = (a) => [...new Set(a)]

/** kind → 사람이 읽는 작업 제목·목적(비개발자 언어 · SPEC §10). */
const KIND_TITLE = Object.freeze({
  'secret-value': ['열쇠가 코드에 박혀 있는 것 치우기', '남이 우리 데이터를 열 수 있는 상태를 없앤다'],
  'secret-path-tracked': ['비밀 파일이 저장소에 올라간 것 되돌리기', '저장소를 받은 사람이 열쇠를 갖지 않게 한다'],
  'temp-code-in-secret-path': ['보안 경로의 미완성 코드 마무리', '인증·비밀 경로에 「나중에」가 남지 않게 한다'],
  'gate-red': ['검사 빨간불 고치기', '지금 상태로는 배포할 수 없다'],
  'story-defect': ['검사에서 드러난 결함 고치기', '실제로 안 되는 기능을 되게 만든다'],
  'build-missing': ['빌드 명령 마련', '배포본이 실제로 만들어지는지 확인할 수 있게 한다'],
  'db-drift-pending': ['운영 DB 적용 대기 해소', '코드만 먼저 나가서 화면이 깨지는 것을 막는다'],
  'deploy-preflight-missing': ['배포 사전점검 파일 복구', '배포 명령이 즉시 실패하지 않게 한다'],
  'deploy-env-missing': ['배포 환경 설정 확인', '어느 환경으로 나가는지 확정한다'],
  'open-patch': ['리뷰에서 지적된 것 회수', '검토자가 찾은 문제를 실제로 고친다'],
  'open-decision': ['사람 판단이 필요한 결정 받기', '결정이 없으면 이 스토리는 더 못 나간다'],
  'unfinished-task': ['남은 작업 마치기', '스토리가 선언한 일을 끝까지 한다'],
  'story-missing': ['아직 손대지 않은 스토리 착수', '계획에만 있고 아무도 만들지 않은 기능을 만든다'],
  'story-partial': ['부분 완료 스토리 마무리', '반쯤 된 것을 쓸 수 있는 상태로 만든다'],
  'file-list-missing': ['무엇을 만졌는지 기록 채우기', '문제가 생겼을 때 되돌릴 지점을 남긴다'],
  'file-list-file-missing': ['기록과 실제 파일 맞추기', '완료 기록이 실제 코드와 같게 한다'],
  'untested-files': ['테스트 없는 파일에 테스트 추가', '다음에 조용히 깨지는 것을 막는다'],
  'test-only': ['`.only` 제거', '나머지 검사가 조용히 꺼진 상태를 없앤다'],
  'test-skip': ['꺼진 검사 되살리거나 사유 남기기', '왜 안 도는지 아무도 모르는 검사를 없앤다'],
  'test-integrity': ['검사 우회 흔적 정리', '통과가 진짜 통과가 되게 한다'],
  'gate-not-run': ['검사 한 번 돌리기', '“된다”는 말에 근거를 붙인다'],
  'temp-code': ['임시 표시 정리', '다음 사람이 미완성인지 아닌지 헤매지 않게 한다'],
  'orphan-doc': ['스토리 아닌 문서 표시', '배치가 문서를 스토리로 착각하지 않게 한다'],
  'plan-only-story': ['계획에만 있는 스토리 원장 등재', '아무도 안 만들고 있는 기능을 드러낸다'],
  'sprint-only-story': ['원장에만 있는 스토리 계획 등재', '계획 문서만 읽는 사람도 알 수 있게 한다'],
  'status-drift': ['상태 표기 맞추기', '현황판이 실제 진행률을 보여 주게 한다'],
  'stale-installed-parser': ['설치본 해석기 갱신', '같은 원장을 두 도구가 다르게 읽지 않게 한다'],
  'test-only-needs-review': ['`.only` 인용 확인', '가드가 자기 규칙을 인용한 것인지 사람이 한 번 본다'],
  'test-skip-justified': ['사유 있는 skip 재확인', '사유가 아직 유효한지 본다'],
})
const titleFor = (kind) => KIND_TITLE[kind] ?? [kind, '']

/** 자동 수리를 절대 시키지 않는 범주(이월 금지 5범주 · P0-④ · 리뷰 중단 지침 ②). */
export const NO_AUTO_FIX_KINDS = Object.freeze(['secret-value', 'secret-path-tracked', 'temp-code-in-secret-path', 'open-decision', 'db-drift-pending'])

function assigneeFor({ tier, risk, difficulty, config }) {
  const codex = config?.providers?.codex?.enabled === true
  const codexModel = config?.providers?.codex?.model ?? 'codex'
  const hard = tier <= 2 || risk >= HIGH_RISK_MIN
  // 실행 dev = opus 기본(P0-①). 쉽고 위험 낮은 것만 codex 에 넘긴다.
  const dev = !hard && codex && difficulty <= 3 ? { provider: 'codex', model: codexModel } : { provider: 'claude', model: 'opus' }
  // 구현자 ≠ 리뷰어 제공자(SPEC §4). fable = 지휘 + 판정.
  const review = dev.provider === 'codex' ? { provider: 'claude', model: 'fable' } : codex ? { provider: 'codex', model: codexModel } : { provider: 'claude', model: 'fable' }
  return { dev, review }
}

/**
 * 진단 → 작업 항목. **묶는 단위는 스토리**다(같은 스토리의 지적을 한 라운드로 회수하는 실제 운용과 같다).
 * 스토리에 매이지 않는 지적은 kind 별로 하나로 모은다(예: 꺼진 검사 61건 → 항목 1개).
 */
export function toWorkItems(diagnosis, snapshot, { config = null } = {}) {
  const cfg = config ?? snapshot?.config ?? null
  const storyByKey = new Map((snapshot?.stories ?? []).map((s) => [s.key, s]))
  const verdictByKey = new Map((diagnosis?.stories ?? []).map((s) => [s.key, s]))
  const items = []

  const byStory = new Map()
  const byKind = new Map()
  for (const f of diagnosis?.findings ?? []) {
    if (f.story && verdictByKey.has(f.story)) {
      if (!byStory.has(f.story)) byStory.set(f.story, [])
      byStory.get(f.story).push(f)
    } else {
      if (!byKind.has(f.kind)) byKind.set(f.kind, [])
      byKind.get(f.kind).push(f)
    }
  }

  // ① 스토리 단위 항목
  for (const [key, fs] of [...byStory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const st = storyByKey.get(key)
    const v = verdictByKey.get(key)
    const files = st?.fileList?.declared ?? []
    const text = `${v?.verdict ?? ''} ${fs.map((f) => f.why).join(' ')}`
    const risk = storyRisk({ files, text })
    const diff = storyDifficulty({ files, text })
    const blocked = v?.verdict === 'blocked'
    const scored = fs.map((f) => ({ f, p: priorityOf(f, { risk: risk.score, blocked }) }))
    const best = scored.reduce((a, b) => (b.p.tier < a.p.tier || (b.p.tier === a.p.tier && b.p.score > a.p.score) ? b : a))
    const fingerprint = sha(['story', key, ...fs.map((f) => f.fingerprint).sort()].join('|')).slice(0, 16)
    const [title, purpose] = titleFor(best.f.kind)
    items.push({
      id: idOf(fingerprint), fingerprint,
      title: `${key} — ${title}`,
      purpose,
      userImpact: best.f.userImpact || '이 스토리는 아직 사용자가 쓸 수 있는 상태가 아니다',
      epic: st?.epic ?? (Number(String(key).split('-')[0]) || null),
      story: key,
      storyLink: 'existing',
      acceptance: acceptanceFor(fs, v),
      tier: best.p.tier, score: best.p.score, why: best.p.why,
      risk: risk.score, riskFlags: risk.flags, difficulty: diff.score,
      deps: [], parallelOk: true, conflictReasons: [],
      files: files.slice(0, 200),
      gates: gatesFor(snapshot), tests: testsFor(fs, st),
      assignee: assigneeFor({ tier: best.p.tier, risk: risk.score, difficulty: diff.score, config: cfg }),
      autoFixAllowed: !fs.some((f) => NO_AUTO_FIX_KINDS.includes(f.kind)),
      source: { finding: best.f.id, findings: fs.map((f) => f.id), evidenceRank: Math.min(...fs.flatMap((f) => (f.evidence ?? []).map((e) => e.rank ?? 5)).concat([5])) },
      state: blocked ? 'blocked' : 'open',
    })
  }

  // ② 스토리 밖 항목 — kind 별 1건
  for (const [kind, fs] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const files = uniq(fs.map((f) => f.path).filter(Boolean))
    const text = fs.map((f) => f.why).join(' ')
    const risk = storyRisk({ files, text })
    const diff = storyDifficulty({ files, text })
    const p = priorityOf(fs[0], { risk: risk.score })
    const fingerprint = sha(['kind', kind, ...fs.map((f) => f.fingerprint).sort()].join('|')).slice(0, 16)
    const [title, purpose] = titleFor(kind)
    items.push({
      id: idOf(fingerprint), fingerprint,
      title: fs.length > 1 ? `${title} (${fs.length}건)` : title,
      purpose,
      userImpact: fs[0].userImpact ?? '',
      epic: null, story: null,
      storyLink: p.tier <= 3 ? 'defect' : 'new',
      acceptance: [`${kind} 지적 ${fs.length}건이 0 이 된다`, '전체 회귀(qa)가 GREEN 이다'],
      tier: p.tier, score: p.score, why: p.why,
      risk: risk.score, riskFlags: risk.flags, difficulty: diff.score,
      deps: [], parallelOk: true, conflictReasons: [],
      files: files.slice(0, 200),
      gates: gatesFor(snapshot), tests: files.filter((f) => /\.(test|spec)\./.test(f)).slice(0, 20),
      assignee: assigneeFor({ tier: p.tier, risk: risk.score, difficulty: diff.score, config: cfg }),
      autoFixAllowed: !NO_AUTO_FIX_KINDS.includes(kind),
      source: { finding: fs[0].id, findings: fs.map((f) => f.id), evidenceRank: Math.min(...fs.flatMap((f) => (f.evidence ?? []).map((e) => e.rank ?? 5)).concat([5])) },
      state: 'open',
    })
  }

  return items.sort(byPriority)
}

const byPriority = (a, b) => a.tier - b.tier || b.score - a.score || a.id.localeCompare(b.id)

function acceptanceFor(findings, verdict) {
  const out = []
  const kinds = uniq(findings.map((f) => f.kind))
  if (kinds.includes('open-patch')) out.push('열린 [Review][Patch] 가 0 이 되고 원장에 해소 표기가 붙는다')
  if (kinds.includes('open-decision')) out.push('결정 인박스의 해당 항목이 확정되고 스토리에 반영된다')
  if (kinds.includes('unfinished-task')) out.push('미완 Task 가 0 이 된다(사람 게이트 줄 제외)')
  if (kinds.includes('file-list-missing') || kinds.includes('file-list-file-missing')) out.push('File List 가 실제 변경 파일과 일치한다')
  if (kinds.includes('untested-files')) out.push('비테스트 파일마다 대응 테스트가 있다')
  if (kinds.includes('story-missing')) out.push('스토리 파일이 생성되고 sprint-status 에 상태가 붙는다')
  out.push('qa(typecheck·lint·test) exit 0')
  out.push(`판정이 ${verdict?.verdict === 'missing' ? 'verified-done' : 'verified-done'} 이 된다(문서 done 만으로는 안 된다)`)
  return uniq(out)
}
function gatesFor(snapshot) {
  const g = snapshot?.scripts?.gates ?? {}
  return Object.entries(g).filter(([, v]) => v?.available).map(([k]) => k)
}
function testsFor(findings, story) {
  const declared = (story?.fileList?.declared ?? []).filter((p) => /\.(test|spec)\./.test(p))
  const untested = story?.fileList?.untested ?? []
  return uniq([...declared, ...untested.map((p) => `${p} 에 대응하는 테스트(신규)`)]).slice(0, 30)
}

// ── 백로그 ──────────────────────────────────────────────────────────────────
/**
 * 작업 항목 + 병렬 판정 + 봉쇄 목록. `parallelOk` 는 **보수 범주까지 얹어** 판정한다.
 */
export function buildBacklog({ diagnosis, snapshot, config = null, round = 0 } = {}) {
  const items = toWorkItems(diagnosis, snapshot, { config })
  const opts = hazardOptsFor(items)

  // 항목 하나만 놓고도 mode:'any' 범주는 걸린다 — 「혼자서도 병렬 금지」가 보수 처리의 뜻이다.
  for (const it of items) {
    const solo = parallelHazardsExtended([it.files ?? []], opts)
    it.parallelOk = solo.parallelOk
    it.conflictReasons = solo.reasons.map((r) => ({ category: r.category, why: r.why }))
  }

  const byTier = {}
  for (const t of TIERS) byTier[t.tier] = items.filter((i) => i.tier === t.tier).length
  const blocked = (diagnosis?.stories ?? [])
    .filter((s) => s.verdict === 'blocked')
    .map((s) => ({ key: s.key, why: '열린 [Review][Decision] — 사람 판단 전까지 이 스토리만 멈춘다' }))

  return {
    schema: BACKLOG_SCHEMA,
    at: diagnosis?.at ?? null,
    round,
    items,
    byTier,
    blocked,
    questions: [],
    counts: { total: items.length, open: items.filter((i) => i.state === 'open').length, blocked: blocked.length, parallelOk: items.filter((i) => i.parallelOk).length },
    fingerprint: sha(items.map((i) => i.fingerprint).sort().join(',')).slice(0, 16),
  }
}

/**
 * 라운드 사이 합치기 — **id 는 fingerprint 로 안정**하고, 지난 라운드에 있었는데 이번에 없으면
 * 「해소」로 닫아 남긴다(지웠다고 없던 일이 되면 진전을 셀 수 없다).
 */
export function mergeBacklog(prev, next) {
  if (!prev) return { ...next, closed: [] }
  const nextFps = new Set((next?.items ?? []).map((i) => i.fingerprint))
  const closed = (prev.items ?? [])
    .filter((i) => !nextFps.has(i.fingerprint) && i.state !== 'closed')
    .map((i) => ({ ...i, state: 'closed', closedAt: next?.at ?? null, closedWhy: '다음 라운드 진단에서 사라졌다 — 해소로 본다' }))
  const prevById = new Map((prev.items ?? []).map((i) => [i.fingerprint, i]))
  const items = (next?.items ?? []).map((i) => {
    const p = prevById.get(i.fingerprint)
    return p ? { ...i, id: p.id, firstSeenRound: p.firstSeenRound ?? prev.round ?? 0 } : { ...i, firstSeenRound: next?.round ?? 0 }
  })
  return {
    ...next,
    items,
    closed,
    counts: { ...(next?.counts ?? {}), closed: closed.length, carried: items.filter((i) => prevById.has(i.fingerprint)).length },
  }
}

/**
 * 이번에 돌릴 것 고르기. 봉쇄·완료는 빼고 우선순위대로 cap 만큼.
 * 봉쇄된 스토리 **하나만** 멈춘다 — 다른 항목은 계속 돈다(무인 결정 규칙 ②).
 */
export function selectRunnable(backlog, { cap = 3, blocked = [], doneKeys = [] } = {}) {
  const blockedSet = new Set([...(blocked ?? []), ...((backlog?.blocked ?? []).map((b) => b.key))])
  const doneSet = new Set(doneKeys ?? [])
  return (backlog?.items ?? [])
    .filter((i) => i.state !== 'closed' && i.state !== 'blocked')
    .filter((i) => !(i.story && blockedSet.has(i.story)))
    .filter((i) => !(i.story && doneSet.has(i.story)))
    .sort(byPriority)
    .slice(0, Math.max(0, Number(cap) || 0))
}

// ── 실패 6분류 (SPEC §5 · 설계 §4-3) ────────────────────────────────────────
export const FAILURE_KINDS = Object.freeze(['env', 'code', 'test', 'security', 'performance', 'integration'])
/** 환경 실패의 종료 코드(엔진 계약) — 재실행해도 같은 결과라 **사람/대기**로 간다. */
export const ENV_EXITS = Object.freeze([2, 5, 6])
const ENV_LOG_RE = /(ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|rate limit|usage limit|한도|not logged in|please run .*login|authentication|자격 ?증명|credit balance|quota)/i
const FAILURE_ACTION = Object.freeze({
  env: { retry: false, action: '재실행 금지 — 대기하거나 사람이 푼다(인증·한도·네트워크)' },
  code: { retry: true, action: '실패한 파일 범위만 수리(같은 원인 3회 · 총 5회 예산)' },
  test: { retry: true, action: '테스트 파일 + File List 범위만 수리 — 테스트를 지워서 통과시키지 않는다' },
  security: { retry: false, action: '자동 수리 금지 — 질문 또는 중단(이월 금지 5범주)' },
  performance: { retry: true, action: '1회만 시도 — 안 되면 이연' },
  integration: { retry: false, action: 'rollback + STOP · push 금지(설정으로 우회 불가)' },
})

/**
 * 실패 1건을 6분류한다. `signature` 는 **같은 원인의 반복을 세는 열쇠**라 줄·열 번호처럼
 * 흔들리는 값을 넣지 않는다(quality-rules.classifyQaFailure 와 같은 정의를 재사용).
 */
export function classifyFailure({ stage = '', exit = null, qaLog = '', manifest = null, gate = null } = {}) {
  const st = String(stage ?? '').toLowerCase()
  const gt = String(gate ?? '').toLowerCase()
  const log = String(qaLog ?? '')
  const qa = classifyQaFailure(log)

  const decide = () => {
    if (gt === 'integration' || st === 'integration') return 'integration'
    if (gt === 'security' || st === 'security') return 'security'
    if (gt === 'performance' || st === 'performance' || st === 'perf') return 'performance'
    if (exit !== null && exit !== undefined && ENV_EXITS.includes(Number(exit))) return 'env'
    if (ENV_LOG_RE.test(log)) return 'env'
    if (qa.kind === 'test') return 'test'
    if (qa.kind === 'typecheck' || qa.kind === 'lint' || qa.kind === 'build') return 'code'
    return 'code'
  }
  const kind = decide()
  const scope = uniq([
    ...(manifest?.qa?.files ?? []),
    ...(manifest?.files ?? []),
    ...[...log.matchAll(/(?:^|\s)((?:src|tests?|tools|supabase)\/[\w./-]+\.[a-z]{2,4})/gm)].map((m) => m[1]),
  ]).slice(0, 30)
  const signature = kind === 'env'
    ? `env:${exit ?? 'x'}:${(ENV_LOG_RE.exec(log)?.[1] ?? 'unknown').toLowerCase()}`
    : kind === 'integration' || kind === 'security' || kind === 'performance'
      ? `${kind}:${st || gt || 'gate'}:${qa.signature}`
      : qa.signature
  return { kind, scope, signature, ...FAILURE_ACTION[kind], excerpt: qa.excerpt.slice(0, 2000) }
}
