/** Bind publication to the tree actually verified by this landing gate. */
export function verifiedLandingFingerprint(report, { landingBase, head, currentFingerprint }) {
  if (report?.schema !== 'batch-24-multiag/quality/1' || report.verdict !== 'ready' ||
      report.phase !== 'landing' || report.base !== landingBase || report.commit !== head) {
    throw new Error('landing report is missing, stale, or not ready for this HEAD/base')
  }
  const before = report.codeFingerprint
  const docsOnly = report.risk?.category === 'docs' && Array.isArray(report.gates) &&
    report.gates.length === 0 && report.coverage?.result === 'not-required'
  // Docs-only reports predate afterFingerprint because they return before running code gates.
  const verified = docsOnly && report.afterFingerprint == null ? before : report.afterFingerprint
  if (typeof before !== 'string' || !/^[a-f0-9]{64}$/.test(before) || before !== verified || verified !== currentFingerprint) {
    throw new Error('landing code fingerprint changed after verification; publication blocked')
  }
  return verified
}
