---
name: ship-check
description: Final check before calling a step done or committing. Runs tests and type check, asks the code-reviewer subagent for a review, and walks the spec acceptance list. Use at the end of every implementation step.
---

# Ship check

Run these in order and stop at the first failure:

1. `npm test`
2. `npx tsc --noEmit`
3. `npm run lint`
4. Delegate to the `code-reviewer` subagent with: "Review the current diff against docs/spec.md and docs/review-checklist.md."
5. Open `docs/spec.md` section 9 and mark which acceptance items are now covered by a test, with the test name.

## Report format
```
Tests:      pass (N tests)
Types:      pass
Lint:       pass
Review:     <blocking count> blocking, <should-fix count> should fix
Acceptance: <covered>/<total>
  [x] item  →  tests/file.test.ts > test name
  [ ] item  →  not covered yet
Next:       <what's left>
```

If anything is blocking, list it and propose the fix. Don't commit. Wait for the user.
