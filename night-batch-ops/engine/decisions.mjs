// decisions.mjs — 「무엇을 사람에게 묻고 무엇을 묻지 않는가」(설계 §1-5 · §5 · SPEC §6).
//
// 원칙 하나: **코드·문서·테스트·기존 결정으로 판단할 수 있는 기술 사항은 묻지 않는다.** 물어도 되는 것은
// 8범주뿐이고, 그 8범주는 「사람이 아니면 되돌릴 수 없는 것」이다. 그래서 이 파일의 절반은 *묻지 않는
// 이유*를 만드는 코드다.
//
// 두 번째 원칙: **질문은 비개발자 언어로 쓴다.** 파일 경로·함수명·확장자가 들어가면 그 질문은 답을
// 받지 못한다 — 2026-08-24 실사고(결정 대기가 스토리 파일 안에만 있어 7일 정체)의 재발 방지로
// 단일 창구(`DECISIONS-INBOX.md`)에 **읽고 바로 고를 수 있는 형태**로만 올린다.
//
// 이 모듈은 **쓰지 않는다** — 계획(op)만 만들어 `bmad-sync.applyBmadWrites` 에 넘긴다.

import { createHash } from 'node:crypto'
import { resolveAsf } from './asf-resolve.mjs'
const { appendDecisionsInbox } = await import(resolveAsf('story-writes.mjs'))

/** 질문이 허용되는 8범주(SPEC §6). 이 밖은 질문 자체를 만들지 않는다. */
export const QUESTION_CATEGORIES = Object.freeze([
  'product-intent',
  'ux-business',
  'irreversible-data',
  'paid-cost',
  'account-auth-secret',
  'legal-policy',
  'public-egress',
  'vcs-approval',
])

/** 범주별 사람말 이름 · 기본 심각도 · 무인 기본값 허용 여부(무인 규칙 ③ = 정책·문구는 즉시 대기). */
export const CATEGORY_META = Object.freeze({
  'product-intent': { label: '제품 의도가 여러 갈래', marker: '🟠', severity: 'medium', autoDefault: false, why: '무엇을 만들지가 갈리면 코드로 정할 수 없다' },
  'ux-business': { label: '화면 문구·사업 방향', marker: '🟠', severity: 'medium', autoDefault: false, why: '사용자에게 보이는 말과 사업 판단은 사람 몫이다(무인 규칙 ③)' },
  'irreversible-data': { label: '되돌릴 수 없는 데이터 변경', marker: '🔴', severity: 'high', autoDefault: false, why: '지운 데이터는 되살릴 수 없다' },
  'paid-cost': { label: '돈이 나가는 선택', marker: '🔴', severity: 'high', autoDefault: false, why: '비용은 사람이 승인한다' },
  'account-auth-secret': { label: '계정·인증·비밀정보', marker: '🔴', severity: 'high', autoDefault: false, why: '열쇠를 다루는 일은 사람이 판단한다' },
  'legal-policy': { label: '법률·개인정보·약관', marker: '🔴', severity: 'high', autoDefault: false, why: '규정 판단을 기계가 대신할 수 없다' },
  'public-egress': { label: '외부로 나가는 발송·공개', marker: '🔴', severity: 'high', autoDefault: false, why: '한 번 나가면 회수할 수 없다' },
  'vcs-approval': { label: '커밋·푸시·머지·배포 승인', marker: '🟠', severity: 'medium', autoDefault: false, why: '외부 반영은 언제나 사람 승인이다' },
})

export const INBOX_HEADER = '# 결정 인박스 (상시)'
const INBOX_H1_RE = /^#\s+.*결정 인박스/

// ── 작은 도구 ────────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
const uniq = (a) => [...new Set(a)]
const todayOf = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString().slice(0, 10)
const shortId = (key) => String(key ?? '').split('-').slice(0, 2).join('-')
const dotId = (key) => shortId(key).replace('-', '.')

/**
 * 비개발자 언어로 정리 — 경로·함수 표기·확장자·코드 인용을 **지운다**.
 * 지우고 나서 문장이 이상해지면 그건 애초에 질문에 넣을 문장이 아니었다는 뜻이다.
 */
export function plainKo(text) {
  return String(text ?? '')
    .replace(/`[^`]*`/g, ' ') // 코드 인용
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ') // 링크
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\([^)]{0,80}\)/g, ' ') // 함수 표기
    .replace(/[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+/g, ' ') // 경로
    .replace(/\b[A-Za-z0-9_-]+\.(mjs|cjs|js|jsx|ts|tsx|json|sql|ya?ml|md|html|css|toml)\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.·—])/g, '$1')
    .trim()
}

/** 질문의 안정 지문 — 같은 질문을 두 번 올리지 않기 위한 열쇠. */
export function questionFingerprint(subject = {}) {
  const kind = subject.kind ?? subject.category ?? 'question'
  const story = subject.story ?? ''
  const title = plainKo(subject.title ?? subject.why ?? '').replace(/\s+/g, ' ').slice(0, 120)
  return sha([kind, story, title].join('|')).slice(0, 10)
}

// ═══════════════════════════════════════════════════════════════════════════
// ① needsHuman — 8범주 트리거 (설계 §5-1)
// ═══════════════════════════════════════════════════════════════════════════

const TRIGGERS = [
  // ⚠️ 「배포할 수 없다」 같은 **서술**까지 승인 질문으로 읽으면 기술 판단이 전부 질문이 된다 —
  // 승인을 구하는 맥락(승인·할까요·요청·여부)이나 실제 명령어일 때만 문다.
  ['vcs-approval', /(커밋|푸시|머지|병합|배포)\s*(승인|여부|요청|할까요|해도 될까|하시겠)|\bgit\s+(push|merge)\b|\bdeploy:(prod|dev)\b/i, ['commit', 'push', 'merge', 'deploy']],
  ['account-auth-secret', /비밀정보|비밀번호|자격\s?증명|환경\s?변수|api\s?key|API 키|토큰|시크릿|테스트 계정|인증 정보/i, ['secret-value', 'secret-path-tracked', 'temp-code-in-secret-path', 'new-env-var', 'test-account']],
  ['irreversible-data', /\bDROP\s+(TABLE|COLUMN|POLICY|SCHEMA|INDEX)|\bDELETE\s+FROM\b|\bTRUNCATE\b|drop\s+policy|되돌릴 수 없|비가역|대량 삭제|영구 삭제/i, ['destructive-migration', 'data-loss-risk']],
  ['legal-policy', /개인정보|주민등록|약관|법률|계약서 조항|규정 준수|GDPR/i, ['privacy', 'legal']],
  ['public-egress', /외부 발송|외부 공개|공개 게시|SNS|고객에게 발송|메일 발송|알림 발송|발송 경로/i, ['external-send', 'public-publish']],
  ['paid-cost', /유료|구독료|과금|요금|비용이 발생|결제 API|paid plan/i, ['paid-api', 'billing-cost']],
  ['ux-business', /새 문구|신규 문구|사용자 노출 문구|화면 문구|안내 문구|목업 미승인|목업 승인|UX 판단|사업 방향/i, ['new-user-copy', 'mockup-unapproved', 'ux-change']],
  ['product-intent', /어느 에픽|제품 의도|무엇을 만들|범위 판단|매핑할 수 없/i, ['unmappable', 'open-decision', 'scope-question']],
]

/** 기술 판단으로 끝나는 것들 — 여기 걸리면 **묻지 않는다**(SPEC §6). */
export const TECHNICAL_KINDS = Object.freeze([
  'open-patch', 'unfinished-task', 'file-list-missing', 'file-list-file-missing', 'untested-files',
  'test-only', 'test-skip', 'test-integrity', 'test-only-needs-review', 'test-skip-justified',
  'gate-red', 'gate-not-run', 'build-missing', 'story-defect', 'story-partial', 'story-missing',
  'temp-code', 'orphan-doc', 'plan-only-story', 'sprint-only-story', 'status-drift', 'stale-installed-parser',
  'perf-risk', 'a11y-risk', 'deploy-env-missing', 'deploy-preflight-missing',
])

const haystackOf = (s) => [s?.kind, s?.title, s?.why, s?.purpose, s?.userImpact, s?.text, s?.sql, s?.diff, s?.action, ...(s?.files ?? [])].filter(Boolean).join('\n')

/**
 * 이 건을 사람에게 물어야 하는가.
 * @param {object} subject `{kind,title,why,purpose,story,files,text,sql,diff,action}` 또는 WorkItem
 * @param {{inboxText?:string, round?:number}} ctx
 * @returns {{ask:boolean, category:string|null, why:string, confidence:'high'|'medium'|'low', evidence:object[]}}
 */
export function needsHuman(subject = {}, ctx = {}) {
  const s = subject?.item ? { ...subject.item, ...subject } : subject
  const kind = String(s.kind ?? s.category ?? '')
  const hay = haystackOf(s)

  let category = null
  for (const [cat, re, kinds] of TRIGGERS) {
    if (kinds.includes(kind) || re.test(hay)) { category = cat; break }
  }

  // 기술 판단은 트리거 문자열이 스쳐도 묻지 않는다 — 단, 되돌릴 수 없는 범주 4종은 kind 를 이긴다.
  const HARD = ['irreversible-data', 'account-auth-secret', 'legal-policy', 'public-egress', 'vcs-approval', 'paid-cost']
  if (category && TECHNICAL_KINDS.includes(kind) && !HARD.includes(category)) category = null

  if (!category) {
    return {
      ask: false, category: null, confidence: 'high', evidence: [],
      why: '코드·문서·테스트로 판단할 수 있는 기술 사항이다 — 묻지 않고 진행한다(SPEC §6)',
    }
  }

  // 기존 확정 결정이 있으면 다시 묻지 않는다(같은 것을 두 번 묻는 것이 정체의 원인이었다).
  const found = findConfirmed(ctx.inboxText ?? '', s)
  if (found) {
    return {
      ask: false, category, confidence: 'medium',
      why: `이미 확정된 결정이 있다 — "${found.quote}"`,
      evidence: [{ kind: 'story', rank: 4, what: found.heading }],
    }
  }

  const meta = CATEGORY_META[category]
  return {
    ask: true, category, confidence: 'high',
    why: `${meta.label} — ${meta.why}`,
    evidence: [{ kind: 'story', rank: 4, what: plainKo(s.why ?? s.title ?? '') }],
  }
}

/** 인박스의 `✅ 확정`/`✅ 해소` 절에서 이 건의 답을 찾는다. */
export function findConfirmed(inboxText, subject = {}) {
  const text = String(inboxText ?? '')
  if (!text) return null
  const story = subject.story ? [shortId(subject.story), dotId(subject.story)] : []
  const words = uniq(plainKo(subject.title ?? subject.why ?? '').split(/[\s,·—]+/).filter((w) => w.length >= 3)).slice(0, 6)
  const lines = text.split('\n')
  const heads = []
  lines.forEach((l, i) => { if (/^##\s/.test(l)) heads.push(i) })
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h]
    const end = heads[h + 1] ?? lines.length
    const heading = lines[start]
    if (!/^##\s*✅/.test(heading)) continue
    const body = lines.slice(start, end).join('\n')
    const hitStory = story.some((k) => k && body.includes(k))
    const hitWord = words.filter((w) => body.includes(w)).length >= (story.length ? 1 : 2)
    if (!hitStory && !hitWord) continue
    const quote = lines.slice(start + 1, end).map((l) => l.trim()).find((l) => l && !/^[-*#>]/.test(l)) ?? heading.replace(/^#+\s*/, '')
    return { heading: heading.replace(/^#+\s*/, '').trim().slice(0, 160), quote: quote.slice(0, 120) }
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 질문 렌더 (설계 §5-2)
// ═══════════════════════════════════════════════════════════════════════════

/** subject + 판정 → 질문 객체. 선택지가 없으면 ⓐ추천/ⓑ대안/ⓒ그대로 3개를 만들어 준다. */
export function buildQuestion(subject = {}, verdict = null, { index = 1, now = null } = {}) {
  const v = verdict ?? needsHuman(subject)
  const meta = CATEGORY_META[v.category] ?? CATEGORY_META['product-intent']
  const s = subject?.item ? { ...subject.item, ...subject } : subject
  const title = plainKo(s.title ?? s.why ?? '판단이 필요한 항목')
  const options = (s.options ?? []).length ? s.options : [
    { mark: 'ⓐ', label: plainKo(s.recommend ?? '추천안대로 진행한다'), pros: '진단이 찾은 문제가 사라진다', cons: '판단이 뒤집히면 되돌리는 손이 든다', recommended: true },
    { mark: 'ⓑ', label: plainKo(s.alternative ?? '다른 방식으로 처리한다'), pros: '다른 제약을 피할 수 있다', cons: '작업량이 늘어난다' },
    { mark: 'ⓒ', label: '지금 그대로 둔다', pros: '아무것도 바뀌지 않는다', cons: '같은 문제가 다음 라운드에도 그대로 남는다' },
  ]
  return {
    index,
    marker: meta.marker,
    severity: s.severity ?? meta.severity,
    category: v.category,
    story: s.story ?? null,
    title,
    situation: plainKo(s.situation ?? s.why ?? s.purpose ?? '진단이 이 지점을 문제로 보았다'),
    whyAsk: plainKo(s.whyAsk ?? v.why ?? meta.why),
    options,
    safeDefault: plainKo(s.safeDefault ?? (autoDefault(s)?.value ?? '답이 올 때까지 아무것도 바꾸지 않는다')),
    meanwhile: plainKo(s.meanwhile ?? '이 항목만 멈추고, 나머지 작업은 계속 돕니다'),
    fingerprint: s.fingerprint ?? questionFingerprint(s),
    date: todayOf(now),
  }
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

/** 질문 하나 → 인박스에 그대로 들어가는 markdown. **파일명·함수명은 들어가지 않는다.** */
export function renderQuestion(q = {}) {
  const idx = CIRCLED[(q.index ?? 1) - 1] ?? `${q.index ?? 1}.`
  const sev = q.severity ?? 'medium'
  const opt = (o) => `- ${o.mark ?? 'ⓐ'} ${plainKo(o.label)}${o.recommended ? ' **(추천)**' : ''}${o.pros || o.cons ? ` — 좋은 점: ${plainKo(o.pros ?? '-')} / 아쉬운 점: ${plainKo(o.cons ?? '-')}` : ''}`
  return [
    `### ${idx} ${q.marker ?? '🟠'} ${plainKo(q.title)} [${sev}] · 지문 ${q.fingerprint ?? ''}`,
    '',
    `**지금 무슨 일** — ${plainKo(q.situation ?? '')}`,
    '',
    `**왜 물어보나** — ${plainKo(q.whyAsk ?? '')}`,
    '',
    '**선택지**',
    '',
    ...(q.options ?? []).map(opt),
    '',
    `**안전 기본값** — ${plainKo(q.safeDefault ?? '')}`,
    '',
    `**기다리는 동안 계속 도는 것** — ${plainKo(q.meanwhile ?? '')}`,
    '',
  ].join('\n')
}

/**
 * 인박스에 넣을 블록 하나. 절 제목·목록 형식은 `story-writes.appendDecisionsInbox`(공용 관례)를 그대로 쓰고,
 * 그 아래에 질문 본문을 붙인다.
 */
export function buildInboxBlock(questions = [], { date = null, source = '자율 마무리 진단(무인)', storyKey = null, now = null } = {}) {
  const qs = questions.map((q, i) => (q.title && q.options ? q : buildQuestion(q, null, { index: i + 1, now })))
  if (qs.length === 0) return ''
  const d = date ?? todayOf(now)
  const titles = qs.map((q) => `${q.marker} ${plainKo(q.title)} [${q.severity}] · 지문 ${q.fingerprint}`)
  const head = storyKey
    ? appendDecisionsInbox('', { storyKey, date: d, decisions: titles, source }).replace(/\s+$/, '')
    : [
        `## 🟠 결정 대기 — 프로젝트 전체 ${source} 결정 ${qs.length}건 (등재 ${d} · 무인 규칙 ③ 정책·문구 판단은 즉시 대기)`,
        '',
        '아래 항목만 멈춥니다 — 나머지 작업은 계속 돕니다.',
        '',
        ...titles.map((t) => `- ${t}`),
      ].join('\n')
  return [head, '', ...qs.map((q, i) => renderQuestion({ ...q, index: q.index ?? i + 1 })), ''].join('\n')
}

/** 인박스가 없을 때 만들 파일 전문(BRIEF 정책 15 — 안전한 기본 형식으로 **생성**한다). */
export function renderNewInbox(block, { now = null } = {}) {
  return [
    INBOX_HEADER,
    '',
    `> ${todayOf(now)} 자율 마무리가 만들었다. 결정 대기의 단일 창구다 — 확정하면 그 절을 \`✅ 확정\` 으로 바꾼다.`,
    '',
    String(block ?? '').replace(/\s+$/, ''),
    '',
  ].join('\n')
}

/** 같은 지문이 이미 올라가 있는가(재등재 금지). */
export function alreadyAsked(inboxText, fingerprint) {
  if (!fingerprint) return false
  return String(inboxText ?? '').includes(`지문 ${fingerprint}`)
}

/**
 * 인박스 쓰기 계획 — `bmad-sync` op 로 변환할 수 있는 형태로 돌려준다.
 * 인박스를 만들 수도 없으면 `{ok:false}` — 호출부는 **Decision 적용 실패**로 처리한다(BRIEF 정책 15).
 */
export function inboxWritePlan({ path = null, exists = false, text = '', questions = [], date = null, source, storyKey = null, now = null } = {}) {
  if (!path) return { ok: false, op: null, why: '결정 인박스 경로를 알 수 없다 — Decision 을 적용할 수 없다' }
  const fresh = questions.filter((q) => !alreadyAsked(text, q.fingerprint ?? questionFingerprint(q)))
  if (fresh.length === 0) return { ok: true, op: 'skip', path, questions: [], why: '같은 지문이 이미 등재돼 있다 — 다시 올리지 않는다' }
  const block = buildInboxBlock(fresh, { date, source, storyKey, now })
  if (!exists) return { ok: true, op: 'create-file', path, body: renderNewInbox(block, { now }), block, questions: fresh, why: '인박스가 없어 안전한 기본 형식으로 만든다' }
  const first = String(text ?? '').split('\n')[0] ?? ''
  const anchor = INBOX_H1_RE.test(first) ? first.trim() : INBOX_HEADER
  if (!INBOX_H1_RE.test(first)) return { ok: false, op: null, path, why: '인박스 첫 줄이 예상한 제목이 아니다 — 사람이 볼 파일을 함부로 고치지 않는다' }
  return { ok: true, op: 'insert-after-heading', path, anchor, body: block, block, questions: fresh, why: '인박스 맨 앞(제목 바로 아래)에 끼운다' }
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ pendingKeys — 인박스에서 「아직 답 안 온 것」을 읽는다 (봉쇄 목록)
// ═══════════════════════════════════════════════════════════════════════════

const PENDING_MARK_RE = /🟠|🔴/
const PENDING_PHRASE_RE = /결정 대기|남은 사람 판단|사람 게이트|판단 필요/
const RESOLVED_RE = /^#+\s*(✅|⏳|🟢)/

/**
 * 인박스 본문 → 봉쇄 목록. `validatePlan` 의 `constraints.blocked` 재료다.
 *
 * ⚠️ 실물 함정: `## ✅ 해소 — …` 절 **안에도** `### ① 🟠 …(medium)` 같은 줄이 남아 있다(그 질문들은
 * 이미 답이 나왔고 기록만 남은 것이다). 그래서 번호 붙은 하위 항목은 **부모 절이 열려 있을 때만** 센다.
 * 반대로 `### 🟠 남은 사람 판단 1건 — …` 처럼 **표지 문구를 가진 하위 절**은 부모가 확정이어도 열린 것이다.
 *
 * @param {string} inboxText
 * @param {{storyKeys?:string[]}} o sprint 키를 주면 `2.24` → `2-24-…` 전체 키로 풀어 준다
 * @returns {{key:string,id:string|null,why:string,severity:string,heading:string}[]}
 */
export function pendingKeys(inboxText, { storyKeys = [] } = {}) {
  const lines = String(inboxText ?? '').split('\n')
  const out = []
  const seen = new Set()
  let parentOpen = false
  let parentId = null

  const expand = (id) => {
    if (!id) return null
    const hit = storyKeys.find((k) => shortId(k) === id)
    return hit ?? id
  }
  const idIn = (s) => {
    const m = /\b(\d+)[.-](\d+)\b/.exec(String(s ?? ''))
    return m ? `${m[1]}-${m[2]}` : null
  }
  const add = (heading, inherited = null) => {
    // 하위 항목(`### ① 🟠 …`)에는 스토리 번호가 없다 — 부모 절의 번호를 물려받는다.
    const id = idIn(heading) ?? inherited
    const key = expand(id) ?? '(프로젝트 전체)'
    const sev = /\b(low|medium|high)\b/.exec(heading)?.[1] ?? (/🔴/.test(heading) ? 'high' : 'medium')
    const why = heading.replace(/^#+\s*/, '').trim().slice(0, 200)
    const dedupe = `${key}|${why}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    out.push({ key, id, why, severity: sev, heading: why })
  }

  for (const line of lines) {
    const lv = /^(#{2,3})\s/.exec(line)?.[1].length ?? 0
    if (lv === 0) continue
    const open = PENDING_MARK_RE.test(line) && !RESOLVED_RE.test(line)
    if (lv === 2) {
      parentOpen = open && PENDING_PHRASE_RE.test(line)
      parentId = idIn(line)
      if (parentOpen) add(line)
      continue
    }
    // h3
    if (!open) continue
    if (PENDING_PHRASE_RE.test(line)) { add(line, parentId); continue } // 표지 문구가 있으면 독립적으로 열린 절
    if (parentOpen) add(line, parentId) // 번호 항목은 부모가 열려 있을 때만
  }
  return out
}

/** `pendingKeys` 결과 → `validatePlan(constraints.blocked)` 의 맵 형태. */
export function blockedMap(pending = []) {
  const out = {}
  for (const p of pending) if (p.key && p.key !== '(프로젝트 전체)') out[p.key] = p.why
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ autoDefault — 답을 기다리는 동안 무인 배치가 취할 기본값
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = Object.freeze({
  'product-intent': { value: '스토리로 만들지 않고 대기 목록에만 둔다', why: '어느 에픽 것인지 모르는 채로 만들면 나중에 통째로 지워야 한다' },
  'vcs-approval': { value: '커밋·푸시·머지·배포를 하지 않고 로컬 상태로 남긴다', why: '외부 반영은 승인 전 금지(배포 가능 상태 ≠ 배포)' },
})

/**
 * 무인 기본값(무인 규칙 ①). 정책·문구·비가역·비용·보안·법률·외부 발송은 **기본값을 만들지 않는다**(null).
 * @returns {{value:string, why:string}|null}
 */
export function autoDefault(subject = {}) {
  const v = needsHuman(subject)
  if (!v.ask) return { value: '추천안대로 진행한다(무인 기본값)', why: '기술 판단이라 사람 확인 없이 진행하고 사후 확인에만 올린다(무인 규칙 ①)' }
  return DEFAULTS[v.category] ?? null
}
