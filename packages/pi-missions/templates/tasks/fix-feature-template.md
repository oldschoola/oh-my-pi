# Task: {{fixFeatureId}} — Fix: {{summary}}

**Created:** {{createdAt}}
**Size:** S
**Review Level:** 2

## Milestone: {{milestoneId}}

## Fulfills: {{assertionIds}}

## Parent Feature: {{parentFeatureId}}

## Fix Feature: true

## Mission

A validator ran after milestone `{{milestoneId}}` completed its feature work
and flagged a blocking issue on assertion `{{assertionIds}}`. This fix
feature exists to resolve that finding so the milestone can advance.

**Validator:** `{{validatorKind}}` (round {{validationRound}})
**Finding severity:** `{{severity}}`

## Finding Detail

{{findingDescription}}

## Evidence Cited By Validator

{{findingEvidence}}

## Resolution Strategy

{{resolutionStrategy}}

## Dependencies

- **Parent feature:** `{{parentFeatureId}}`

## Context to Read First

- The validator output at `{{validatorOutputPath}}`
- The parent feature folder at `{{parentFeatureFolder}}`

## File Scope

{{fileScope}}

## Steps

### Step 0: Read the finding

- [ ] Open `{{validatorOutputPath}}` and read the specific finding for this fix feature.
- [ ] Confirm the cited assertion(s) match the `## Fulfills:` metadata above.

### Step 1: Diagnose the root cause

- [ ] Inspect the parent feature's deliverable against the assertion criteria.
- [ ] Identify the minimal change that would make the validator's acceptance
      criteria pass.

### Step 2: Apply the fix

- [ ] Make the targeted change. Do not expand scope beyond the finding.
- [ ] Keep the change narrow: this fix feature is one validator round, not a
      rewrite.

### Step 3: Verify

- [ ] Run the relevant tests and confirm they pass.
- [ ] Re-read the assertion's acceptance criteria and walk through each one
      manually.

### Step 4: Delivery

- [ ] Commit with `fix({{fixFeatureId}}): ...` message format.
- [ ] Update STATUS.md and signal `.DONE`.

## Completion Criteria

- [ ] The cited validator finding no longer applies.
- [ ] Each acceptance criterion under `{{assertionIds}}` is independently
      verifiable.
- [ ] No new findings introduced in the same area.

## Git Commit Convention

- **Fix commits:** `fix({{fixFeatureId}}): description`
- **Checkpoints:** `checkpoint: {{fixFeatureId}} description`

## Do NOT

- Modify features outside `{{parentFeatureId}}`'s file scope unless the
  finding explicitly names them.
- Introduce new assertions — this fix feature only serves the cited ones.
- Skip the verification step: the validator re-runs after this fix feature
  completes.

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution. -->
