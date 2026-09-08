#!/usr/bin/env node
// auto-story-finish 실패 분류 가드 — `node failure-classify.test.mjs` 로 단독 실행(의존성 0).
//
// 왜 이 파일이 있나 (2026-08-30 · 반복 종결)
//   「모델 한도」 주제가 5번 반복됐고, 5번째의 진짜 원인은 사다리도 사용량도 아니었다:
//   **월 지출 한도(monthly spend limit)를 사용량 한도와 같은 갈래로 묶어 「기다리면 풀린다」고
//   안내한 것**이다. 2026-08-28 에 그 문구를 LIMIT_RE 에 넣으면서 주석에는 「월 한도는 대기로
//   안 풀린다」고 정확히 적어 놓고도 대기하는 갈래에 분류했다 — 진단은 맞고 처방이 반대였다.
//   그날은 fable 만 걸려 사다리가 opus 로 넘겨 피해가 0이라 아무도 밟지 않았고, 2026-08-30
//   전 모델이 걸리자 슬롯마다 30분씩 헛기다리며 수 시간을 버렸다.
//
//   원장(feedback-repeated-topics-ledger)의 결론: **규정이 문서·주석에만 있으면 반복된다.**
//   그래서 이 파일이 생겼다 — 분류 규율을 기계가 집행한다.
//
// 이 가드가 지키는 불변식
//   ① spend limit 문구는 "spend" 로 분류된다(절대 "limit" 이 아니다)
//   ② spend 안내 문구에 「기다리」라는 말이 들어가면 안 된다(그 오안내가 사고의 실체였다)
//   ③ spend 는 대기 경로를 타지 않는다(handleFailure 가 waitForRecovery 를 건너뛴다)
//   ④ spend 는 모델 사다리를 타지 않는다(계정 전체 지갑이라 전환이 무의미)
//   ⑤ 사용량 한도(usage/rate limit)는 종전대로 "limit" 이고 대기가 맞다

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// CRLF 내성 — Windows autocrlf 체크아웃이면 LF 기준 '\n}\n' 탐색이 빗나가 classifyFailure 를 못 떼어낸다
// (2026-09-02 기준선 실측: 이식 직후 `node --test` 가 ReferenceError 로 RED). 개행을 LF 로 정규화한 뒤 읽는다.
const src = readFileSync(join(here, 'auto-story-pipeline.mjs'), 'utf8').replace(/\r\n/g, '\n')

let fail = 0
const check = (name, cond, why) => {
  if (cond) { console.log(`  ✔ ${name}`) } else { fail++; console.log(`  ✖ ${name}\n      ${why}`) }
}

// ── 분류 함수를 소스에서 그대로 떼어 실행한다(사본 유지보수 없이 실물을 문다) ──
const grab = (name) => {
  const i = src.indexOf(`const ${name} =`)
  if (i < 0) throw new Error(`${name} 가 소스에 없다`)
  return src.slice(i, src.indexOf('\n', i) + 1)
}
const fnStart = src.indexOf('function classifyFailure(out) {')
if (fnStart < 0) { console.error('✖ classifyFailure 가 소스에 없다 — 분류 규율이 사라졌다'); process.exit(1) }
const fnText = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 3)
const classify = new Function(`${grab('AUTH_RE')}${grab('SPEND_RE')}${grab('LIMIT_RE')}${fnText}; return classifyFailure`)()

console.log('── ① 문구 분류 ──')
const 실제문구 = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets 2am (Asia/Seoul)"
check('실제 CLI 문구(2026-08-30 실측) → spend', classify(실제문구) === 'spend',
  `받은 값 = ${classify(실제문구)} · 이게 "limit" 이면 배치가 또 헛기다린다`)
check('spending limit 변형도 spend', classify('monthly spending limit reached') === 'spend', '변형 문구 누락')
check('사용량 한도는 종전대로 limit', classify('usage limit exceeded') === 'limit', 'usage limit 이 spend 로 새면 대기가 사라진다')
check('rate limit 도 limit', classify('rate limit · 429') === 'limit', 'rate limit 회귀')
check('401 은 auth (spend 보다 우선)', classify('401 unauthorized · spend limit') === 'auth', '인증 우선순위 깨짐')
check('무관한 실패는 other', classify('ECONNRESET') === 'other', 'other 갈래 붕괴')
// 2026-09-04 실측 — 모델별 한도(어순 반대 · 처방 = 모델 전환 = limit 사다리). other 로 새면 exit 1 STOP → 창 차단(그날 실사고)
const 모델한도문구 = "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
check('모델별 한도 문구 → limit(사다리로 opus 전환)', classify(모델한도문구) === 'limit',
  `받은 값 = ${classify(모델한도문구)} · other 면 사다리가 안 돌아 배치가 선다`)
check('「Switch to another model」 단독도 limit', classify('Switch to another model to continue') === 'limit', '모델 전환 지시 누락')
check('모델별 한도가 spend 를 가로채지 않는다', classify("You've hit your monthly spend limit — switch to another model") === 'spend', 'spend 우선순위 붕괴')

console.log('── ② 안내 문구 ──')
const spendFix = /spend:\s*\{[\s\S]*?fix:\s*"([^"]+)"/.exec(src)?.[1] ?? ''
check('spend 안내가 존재한다', spendFix.length > 0, 'KIND.spend.fix 가 없다')
check('spend 안내에 「기다리」가 없다', !/기다리(면|세요|시면)/.test(spendFix.replace('기다려도 풀리지 않습니다', '')),
  `오안내 재발 — "${spendFix.slice(0, 60)}"`)
check('spend 안내가 설정 경로를 알려 준다', /settings\/usage|사용 크레딧|지출 한도/.test(spendFix),
  '사람이 무엇을 눌러야 하는지 없다')

console.log('── ③ 대기·사다리 경로 ──')
check('handleFailure 가 spend 를 대기에서 제외', /kind !== "spend" && waitForRecovery/.test(src),
  'spend 가 waitForRecovery 를 타면 슬롯마다 30분을 버린다')
check('사다리는 limit 에만 걸린다(runStage)', /if \(r === "limit"\) \{/.test(src) && !/if \(r === "spend"\)/.test(src),
  'spend 가 사다리를 타면 계정 전체 지갑인데 모델만 3번 바꾼다')
check('사다리는 limit 에만 걸린다(프로브)', /if \(p === "limit"\) \{/.test(src) && !/if \(p === "spend"\)/.test(src),
  '프로브 경로 사다리 회귀')

console.log('── ④ LIMIT_RE 오염 방지 ──')
const limitRe = grab('LIMIT_RE')
check('LIMIT_RE 에 spend 가 다시 들어가지 않았다', !/spend/i.test(limitRe),
  'spend 를 LIMIT_RE 에 넣으면 SPEND_RE 가 먼저 걸러도 의도가 흐려진다 — 2026-08-28 과 같은 실수')

console.log(fail === 0 ? '\n전건 통과' : `\n실패 ${fail}건`)
process.exit(fail === 0 ? 0 : 1)
