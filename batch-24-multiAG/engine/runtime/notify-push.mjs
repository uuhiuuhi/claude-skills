#!/usr/bin/env node
// notify-push.mjs — 배치 알림 1건 전송기 (2026-09-02 3차 리뷰 M5)
//
// 왜 별도 파일인가: 파이프라인은 25곳에서 `process.exit()` 하는 **동기 스크립트**라, 본체에서 `fetch` 를
// 띄우면 종료가 전송을 잘라먹는다(러너는 `await flushNotify()` 가 있어서 괜찮다). 그래서 전송만
// 이 작은 프로세스에 맡기고 파이프라인은 `spawnSafe(node, [이 파일, url, bodyFile])` 로 **동기 대기**한다.
// 결과: 셸 문자열 0 · curl 의존 0 · 러너와 같은 `fetch` 경로.
//
// 인자: <url> <bodyFile>  — 본문은 UTF-8 파일로 받는다(명령줄 인코딩·길이 제한 회피).
// 실패는 조용히 exit 1 — 알림 실패가 배치를 흔들면 안 된다(호출부도 결과를 보지 않는다).
import { readFileSync } from 'node:fs'

const [url, bodyFile] = process.argv.slice(2)
if (!url || !bodyFile) process.exit(2)
try {
  const body = readFileSync(bodyFile, 'utf8')
  const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(10_000) })
  try { await res.arrayBuffer() } catch { /* 응답 본문은 쓰지 않는다 — 소켓만 비운다 */ }
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}
