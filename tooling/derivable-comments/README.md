# derivable-comments

> Unaccepted. Not wired into any hook or CI, and its calibration is unverified.

Flags comments whose content is recoverable from the code they annotate: param restatement, signature restatement, rotting counts, repo-path references, pure decoration.

Across 600 files it reports one param restatement and one signature restatement. `packages/http-api-projector/src/dx.ts` alone was identified by hand as containing several, so those two checks are likely tuned too tight to be worth running.

It also predates a second set of tells found later in prose rather than code: stale `file.ts:123` citations, emphasis words that carry no information, em dashes, and bold on a sentence's own subject. It cannot see any of them.
