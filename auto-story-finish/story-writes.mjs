// story-writes.mjs — 스토리 원장·sprint-status·deferred-work 에 대한 **순수 텍스트 변환**.
//
// 왜 엔진(node)이 직접 쓰나: Codex 리뷰는 read-only 샌드박스라 파일을 못 쓴다. 대신 구조화 JSON 을 받아
// 여기서 bmad-code-review 와 같은 자리·같은 형식으로 기재한다(형식은 providers/codex.mjs 렌더러 소유).
// 개행은 원문(CRLF/LF)을 따른다 — Windows 파일 교훈(CRLF 주의).
const eol = (text) => (String(text).includes('\r\n') ? '\r\n' : '\n')
const withEol = (block, nl) => String(block).replace(/\r?\n/g, nl)

/** `## Tasks …` 절 끝(다음 `## ` 앞)에 블록을 붙인다 — 편성기(readStorySignals)가 Tasks 절 안의 `- [ ]` 를
 *  일감으로 세므로 **반드시 그 절 안**이어야 한다. Tasks 절이 없으면 파일 끝에 `### Review Findings` 를 연다. */
export function insertReviewFindings(md, block) {
  const text = String(md ?? '')
  const nl = eol(text)
  const b = withEol(block, nl)
  const tasksAt = text.search(/^## Tasks/m)
  if (tasksAt < 0) return text.replace(/\s*$/, '') + nl + nl + '### Review Findings' + nl + nl + b + nl
  const rest = text.slice(tasksAt + 1)
  const nextH2 = rest.search(/^## /m)
  const endIdx = nextH2 < 0 ? text.length : tasksAt + 1 + nextH2
  const before = text.slice(0, endIdx).replace(/\s*$/, '')
  const after = text.slice(endIdx)
  return before + nl + nl + b + nl + nl + after
}

/** 스토리 `Status: <값>` 줄(첫 등장) — 뒤의 주석은 보존 */
export function setStoryStatus(md, status) {
  const text = String(md ?? '')
  const re = /^(Status:[ \t]*)(\S+)/m
  if (!re.test(text)) return { text, changed: false }
  const next = text.replace(re, (_, p) => `${p}${status}`)
  return { text: next, changed: next !== text }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** sprint-status.yaml 의 `  <key>: <status>` 한 줄만 바꾼다 — 주석·다른 줄·STATUS DEFINITIONS 보존.
 *  last_updated 는 값만 갱신(뒤 주석 보존). 키가 없으면 changed=false(호출부가 경고). */
export function setSprintStatus(yaml, key, status, date) {
  const text = String(yaml ?? '')
  const re = new RegExp('^( {2}' + escapeRe(key) + ':[ \\t]*)(backlog|ready-for-dev|in-progress|review|done)\\b', 'm')
  if (!re.test(text)) return { text, changed: false }
  let next = text.replace(re, (_, p) => `${p}${status}`)
  if (date) next = next.replace(/^(last_updated:[ \t]*)(\S+)/m, (_, p) => `${p}${date}`)
  return { text: next, changed: next !== text }
}

/** 열린 findings 수 — ⚠️ night-batch-ops/engine/story-ledger.mjs `openFindings` 와 **같은 정규식**이어야 한다
 *  (전역 스킬은 프로젝트 파일을 import 할 수 없어 사본을 둔다 · 굵게/기울임·들여쓰기 허용 · `[x]` 제외).
 *  이전 라운드의 열린 Patch/Decision 이 남아 있으면 「이번 라운드 0건」이어도 done 이 아니다(F30). */
export const countOpenFindings = (text, tag) =>
  (String(text ?? '').match(new RegExp('^[ \\t]*- \\[ \\] [*_]{0,2}\\[Review\\]\\[' + tag + '\\]', 'gm')) ?? []).length

/** DECISIONS-INBOX.md 맨 위(H1 아래)에 결정 대기 절을 끼운다 — 편성기 규칙 2 는 인박스에 스토리 번호(예 2.3)가
 *  있는지 본다(단일 창구). 형식은 현행 인박스 관례(`## 🟠 결정 대기 — … (등재 <날짜> …)`). */
export function appendDecisionsInbox(text, { storyKey, date, decisions = [], source = 'Codex 교차리뷰(무인 배치)', mode = 'wait' }) {
  const t = String(text ?? '')
  if (!decisions.length) return t
  const nl = eol(t)
  const short = storyKey.split('-').slice(0, 2).join('.')
  // mode 'post-hoc'(자율운전 full · 2026-09-03): 사람 결정 대기가 아니라 **AI 결정 후보**로 등재한다 —
  // 다음 라운드(replan/dev)가 ⭐추천안을 자동 채택하고 근거를 이 인박스에 남기며, 사람은 사후 확인만 한다.
  if (mode === 'post-hoc') {
    const section = [
      `## 🔵 사후 확인 — AI 결정 후보 Story ${short} ${source} Decision ${decisions.length}건 (등재 ${date} · 자율운전: 다음 라운드가 추천안을 자동 채택)`,
      '',
      `스토리 파일 \`${storyKey}.md\` 의 Review Findings 절에 \`- [ ] [Review][Decision]\` 로 기재됨. 다음 replan/dev 라운드가 ⭐추천안을 채택해 \`- [x] ~~원문~~ — ✅ AI 결정(날짜 · 선택 · 사후 확인)\` 로 닫고 근거를 아래 절에 남긴다. 되돌리려면 「내가 할 일 뭐야」에서 그 항목을 뒤집는다.`,
      '',
      ...decisions.map((d) => `- ${d}`),
      '',
    ].join(nl)
    return insertBelowH1(t, section, nl)
  }
  const section = [
    `## 🟠 결정 대기 — Story ${short} ${source} Decision ${decisions.length}건 (등재 ${date} · 무인 규칙 ③ 정책/UX 판단은 즉시 대기)`,
    '',
    `스토리 파일 \`${storyKey}.md\` 의 Review Findings 절에 \`- [ ] [Review][Decision]\` 로 기재됨. 확정되면 그 줄을 \`- [x] ~~원문~~ — ✅ 👤 확정(날짜 · 선택)\` 로 닫고 이 절을 「✅ 해소」로 바꾼다.`,
    '',
    ...decisions.map((d) => `- ${d}`),
    '',
  ].join(nl)
  return insertBelowH1(t, section, nl)
}

/** H1 바로 아래에 절을 끼운다(H1 이 없으면 맨 앞) — 결정 대기·사후 확인 절이 같은 자리를 쓴다. */
function insertBelowH1(t, section, nl) {
  const h1End = t.search(/\r?\n/)
  if (!t.startsWith('#') || h1End < 0) return section + nl + t
  const head = t.slice(0, h1End)
  const rest = t.slice(h1End).replace(/^(\r?\n)+/, '')
  return head + nl + nl + section + nl + rest
}

/** deferred-work.md 끝에 절 하나 추가 (bmad-code-review step-04 §2 와 같은 제목 형식) */
export function appendDeferredWork(text, heading, bullets) {
  const t = String(text ?? '')
  const nl = eol(t)
  if (!bullets || bullets.length === 0) return t
  const body = [`## ${heading}`, '', ...bullets.map((b) => `- ${b}`)].join(nl)
  return t.replace(/\s*$/, '') + nl + nl + body + nl
}
