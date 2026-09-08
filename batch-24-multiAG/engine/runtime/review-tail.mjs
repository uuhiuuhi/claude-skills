// review-tail.mjs — 리뷰 꼬리 정책(👤 2026-09-07 「리뷰 횟수 최적화」 · 2026-09-01 P0-④ low 꼬리 정책의 집행판).
//
// 왜: 11-6(6차)·11-7(11차)·11-4(10차)·2-25(9차) — 리뷰가 매 라운드 10~20건을 새로 만들어 수렴하지 않았다. 문서 정책
// (2연속 low → Defer 후 done)은 advisory 라 한 번도 집행되지 않았고, 완주 규칙(canBeDone)은 열린 Patch 가 1건이라도 있으면
// done 을 막는다 — 그래서 low 1건이 스토리를 한 라운드(수십만 토큰) 더 돌렸다.
// 무엇: N차(fromRound · 기본 3) 이상의 리뷰 라운드에서 **high/critical 이 아닌** 열린 Patch 를 ⏭️ Defer 로 닫고 deferred-work 로
// 넘긴다(원장 형식 = `- [x] ~~원문~~ — ⏭️ …` · story-ledger-guard 래칫 통과). 이월 금지 5범주(NO_DEFER_RE)는 심각도 무관 그대로 둔다 —
// 판정은 **들여쓴 이어지는 줄까지 포함한 지적 전문**으로 한다(Codex 2차 H1: 첫 줄만 보면 둘째 줄의 「개인정보」가 빠져나간다).
// 심각도 표기 없는 Patch 는 medium 으로 본다(리뷰 지시문이 표기를 의무화한다 · 5범주 어휘는 그래도 잡힌다).
// 대상: applyReviewTail = 파일의 **이번 라운드 블록**(before 를 주면 before 에 없던 리뷰 헤딩 중 마지막 — 삽입 위치가 파일 끝이 아닐 수 있다 · 2차 M3 ·
//       없으면 마지막 리뷰 헤딩)부터 같거나 얕은 깊이의 다음 ATX 헤딩(앞 공백 0~3 · 탭 구분 허용 · 2차 M5) 전 ·
//       applyReviewTailBlock = 삽입 전 렌더 블록 전체(Codex 경로 · 1차 M3). 펜스는 story-ledger.fenceStep(기호·길이 추적).
import { NO_DEFER_RE } from './providers/codex.mjs'
import { fenceStep, atxHeadingDepth, reviewRoundHeadingDepth } from '../story-ledger.mjs'

// 심각도는 닫는 강조 기호·공백 뒤에도 올 수 있다: `**[Review][Patch]**[high]` · `[Review][Patch] [low]` (1차 H2)
const OPEN_PATCH_RE = /^([ \t]*- )\[ \] ([*_]{0,2}\[Review\]\[Patch\][*_]{0,2}[ \t]*(?:\[([A-Za-z]+)\])?.*)$/
// ── 5범주 틈 좁히기(👤 2026-09-07 「나」) — 단어 목록(NO_DEFER_RE)만으로는 리뷰어가 에둘러 쓰면 medium 이 이월될 수 있다. 두 겹을 더한다.
// ① 리뷰어 표식: 지시문이 5범주 지적에 [5범주]([guard]·[no-defer] 동의어)를 붙이게 한다 — 표식이 있으면 심각도 무관 유지.
const GUARD_TAG_RE = /\[(5범주|guard|no-defer)\]/i
// ② 경로 보호: 지적이 가리키는 **파일 경로**가 민감 영역이면 문구와 무관하게 유지. 엔진 기본(프로젝트 공통 어휘) + autonomy.noDeferPaths(프로젝트 정규식 문자열 배열).
//    경로 토큰만 본다(본문 단어가 아니라) — "session" 같은 낱말이 산문에 있어도 경로가 아니면 안 잡힌다(과잉 유지로 꼬리 정책을 무력화하지 않게).
export const NO_DEFER_PATH_DEFAULT_RE = /(^|[/\\])(supabase|migrations?|auth|login|session|rls|polic(?:y|ies)|permissions?|roles?|billing|invoices?|payments?|charges?|청구|결제|vault|notify|notifications?|outbox|mail|sms|telegram|webhooks?|dispatch|deploy|wrangler|workflows|backup|restore|purge|secrets?|credentials?)(?=[/\\.\-_]|$)|(^|[/\\])\.env(?:\.|$)|\.(?:sql|pem|key)$/i
// 경로 토큰 — 허용 문자(유니코드 글자·숫자·_ . - / \)의 연속을 **한 번의 선형 스캔**으로 자른 뒤(Codex 2차 M1: 구분자 없는 4만 자에서 1.9초 → 선형),
// ① 구분자(/ 또는 \)가 든 것은 경로 ② 구분자 없는 점 토큰은 **위치 표기 안([…]·백틱)** 이거나 점파일(.env)이거나 알려진 파일 확장자일 때만 경로다 —
// `notifications.length`·`session.duration` 같은 산문 멤버식은 경로가 아니다(Codex 2차 M2). 따옴표·괄호·백틱은 문자 클래스 밖이라 자동 제외(1차 M3).
const RUN_RE = /[\p{L}\p{N}_.\-/\\]+/gu
const FILE_EXT_RE = /^(?:[cm]?[jt]sx?|sql|toml|jsonc?|ya?ml|md|env|sh|ps1|bat|cmd|py|rb|go|rs|java|kt|cs|php|tsv|csv|txt|html?|css|scss|svg|pem|key|crt|cer|p12|pfx|lock|cfg|ini|conf|properties|xml|gradle|dockerfile)$/i
export function pathTokens(text) {
  const src = String(text); const out = []
  for (const m of src.matchAll(RUN_RE)) {
    const raw = m[0]; const s = raw.replace(/[.,;:]+$/, '')
    if (s.length < 2 || /^\.{1,2}$/.test(s)) continue
    if (/[/\\]/.test(s)) { out.push(s); continue }
    const dot = s.lastIndexOf('.'); if (dot < 0) continue
    const before = src[m.index - 1] ?? '', after = src[m.index + raw.length] ?? ''
    const inRef = before === '[' || before === '`' || after === ']' || after === '`'
    if (inRef || s.startsWith('.') || FILE_EXT_RE.test(s.slice(dot + 1))) out.push(s)
  }
  return out
}
export function buildNoDeferPathRes(extra = []) {
  const res = [NO_DEFER_PATH_DEFAULT_RE]
  for (const s of Array.isArray(extra) ? extra : []) { try { res.push(new RegExp(String(s), 'i')) } catch { /* 잘못된 정규식은 무시(설정 오류가 밤을 세우지 않게) */ } }
  return res
}
const pathGuarded = (full, res) => pathTokens(full).some((p) => res.some((re) => re.test(p)))
// 지적의 이어지는 줄 = 들여쓴 줄(중첩 불릿 `  - …` 포함) · 빈 줄 뒤에 들여쓴 문단이 오면 그 문단까지(CommonMark 목록 항목 경계 · Codex 3차 H1).
// 헤딩·펜스(앞 공백 0~3)는 항목이 아니다.
const isIndented = (line) => /^[ \t]+\S/.test(line) && !atxHeadingDepth(line) && !/^ {0,3}(`{3,}|~{3,})/.test(line)
/** i 다음부터 to 전까지 이어지는 줄을 모은다 — 반환 [줄들, 다음 인덱스] */
function collectContinuation(lines, i, to) {
  const cont = []; let j = i + 1
  while (j < to) {
    if (lines[j].trim() === '') { let k = j + 1; while (k < to && lines[k].trim() === '') k++; if (k < to && isIndented(lines[k])) { j = k; continue } break }
    if (!isIndented(lines[j])) break
    cont.push(lines[j]); j++
  }
  return cont
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim()

function rewriteRegion(lines, from, to, { round, date, story, noDeferPaths }) {
  const pathRes = buildNoDeferPathRes(noDeferPaths)
  const out = { deferred: [], kept: [] }
  let fence = null
  for (let i = from; i < to; i++) {
    const line = lines[i]
    const f = fenceStep(fence, line); fence = f.state
    if (f.toggled || fence) continue
    const m = OPEN_PATCH_RE.exec(line)
    if (!m) continue
    const cont = collectContinuation(lines, i, to)
    const full = [line, ...cont].join('\n')
    const tagged = Boolean(m[3])
    const sev = (m[3] || 'medium').toLowerCase()
    if (sev === 'high' || sev === 'critical') { out.kept.push({ line: i + 1, why: sev }); continue }
    if (NO_DEFER_RE.test(full)) { out.kept.push({ line: i + 1, why: '이월 금지 5범주' }); continue }
    if (GUARD_TAG_RE.test(full)) { out.kept.push({ line: i + 1, why: '5범주 표식' }); continue }
    if (pathGuarded(full, pathRes)) { out.kept.push({ line: i + 1, why: '5범주 경로' }); continue }
    const body = m[2].replace(/\s+$/, '')
    lines[i] = m[1] + '[x] ~~' + body + '~~ — ⏭️ Defer(리뷰 꼬리 정책 · ' + round + '차 · ' + date + ' · deferred-work 이관)'
    out.deferred.push(oneLine(body + (cont.length ? ' ' + cont.map(oneLine).join(' ') : '')) + ' — ⏭️ 리뷰 꼬리 정책(' + story + ' ' + round + '차 · ' + date + ' · ' + (tagged ? sev : '심각도 미표기=medium') + ')')
  }
  return out
}

function finish(text, lines, nl, r, round) {
  if (!r.deferred.length) return { text, applied: false, deferred: [], kept: r.kept, why: round + '차 · 이월 대상 0건(high/5범주 유지 ' + r.kept.length + '건)' }
  return { text: lines.join(nl), applied: true, deferred: r.deferred, kept: r.kept, why: round + '차 · ⏭️ 이월 ' + r.deferred.length + '건 · high/5범주 유지 ' + r.kept.length + '건' }
}

const gate = (round, fromRound) => {
  const from = Number(fromRound)
  if (!(from > 0)) return '꼬리 정책 꺼짐(deferTailFromRound 0)'
  if (!(Number(round) >= from)) return round + '차 < 시작 라운드 ' + from + ' — 전 심각도 회수'
  return ''
}

/** 펜스 밖 리뷰 라운드 헤딩 [{i, depth, text}] */
function reviewHeadings(lines) {
  const out = []; let fence = null
  lines.forEach((line, i) => {
    const f = fenceStep(fence, line); fence = f.state
    if (f.toggled || fence) return
    const d = reviewRoundHeadingDepth(line)
    if (d) out.push({ i, depth: d, text: line.trim() })
  })
  return out
}

/**
 * 파일 전체에서 이번 라운드 블록에 적용한다(bmad-code-review 경로).
 * @param {string} md 스토리 원문(리뷰 기재 후)
 * @param {{round:number, fromRound?:number, date?:string, story?:string, before?:string|null, noDeferPaths?:string[]}} o
 *   round = 이번 라운드 번호 · before = 리뷰 워커 실행 전 원문(주면 그때 없던 헤딩 중 마지막을 이번 블록으로 고른다)
 * @returns {{text:string, applied:boolean, deferred:string[], kept:{line:number, why:string}[], why:string}}
 */
export function applyReviewTail(md, { round, fromRound = 3, date = '', story = '', before = null, noDeferPaths = [] } = {}) {
  const text = String(md ?? '')
  const base = { text, applied: false, deferred: [], kept: [] }
  const g = gate(round, fromRound); if (g) return { ...base, why: g }
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const heads = reviewHeadings(lines)
  if (!heads.length) return { ...base, why: '리뷰 라운드 헤딩 없음' }
  let pick = heads[heads.length - 1]
  if (before != null) {
    const seen = new Set(reviewHeadings(String(before).split(/\r?\n/)).map((h) => h.text))
    const fresh = heads.filter((h) => !seen.has(h.text))
    if (fresh.length) pick = fresh[fresh.length - 1]
  }
  // 블록 끝 = 같거나 얕은 깊이의 다음 ATX 헤딩(펜스 밖) — ### Review … 뒤의 ### Replan/회수 라운드 줄은 dev 몫이라 손대지 않는다
  let end = lines.length, fence = null
  for (let i = pick.i + 1; i < lines.length; i++) {
    const f = fenceStep(fence, lines[i]); fence = f.state
    if (f.toggled || fence) continue
    const d = atxHeadingDepth(lines[i])
    if (d && d <= pick.depth) { end = i; break }
  }
  return finish(text, lines, nl, rewriteRegion(lines, pick.i + 1, end, { round, date, story, noDeferPaths }), round)
}

/** 삽입 전 렌더 블록(헤딩 포함 · 한 라운드) 전체에 적용한다(Codex 경로). */
export function applyReviewTailBlock(block, { round, fromRound = 3, date = '', story = '', noDeferPaths = [] } = {}) {
  const text = String(block ?? '')
  const base = { text, applied: false, deferred: [], kept: [] }
  const g = gate(round, fromRound); if (g) return { ...base, why: g }
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  return finish(text, lines, nl, rewriteRegion(lines, 0, lines.length, { round, date, story, noDeferPaths }), round)
}
