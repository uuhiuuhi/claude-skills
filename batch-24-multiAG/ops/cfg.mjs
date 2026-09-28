// ops/cfg.mjs — auto.config.json 에서 값 하나를 읽어 출력한다(없으면 빈 출력).
// 사용: node cfg.mjs <auto.config.json 경로> <점으로 이은 키>      예: node cfg.mjs tools/auto/auto.config.json watchdog.runnerTask
//       node cfg.mjs --pin <runtime-pin.json 경로> <커밋>          런타임 핀의 commit·recordedAt 을 다시 적는다
import { readFileSync, writeFileSync } from 'node:fs'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
const [a, b, c] = process.argv.slice(2)
if (a === '--pin') {
  const d = readJson(b)
  d.commit = c
  d.recordedAt = new Date().toISOString()
  d.note = 'gap-apply — 문서·설정 반영 커밋 뒤 핀 재기록'
  writeFileSync(b, JSON.stringify(d, null, 2) + '\n')
} else {
  const v = String(b ?? '').split('.').reduce((o, k) => (o == null ? o : o[k]), readJson(a))
  if (v != null) process.stdout.write(String(v))
}
