---
name: coordinate-changes
description: For changes spanning multiple files, ensures correct order and atomicity. Prevents partial migrations and broken intermediate states. Trigger when changing 3+ files or any shared contract.
---

# Coordinated Changes

## Purpose
Multi-file changes must be atomic and ordered. This skill ensures updates happen in dependency order to prevent broken intermediate states.

## When to Use
- Any change touching 3+ files
- Contract changes (types, APIs, shared utilities)
- Refactors affecting both producer and consumer
- Feature additions spanning multiple layers
- After `blast-radius` identifies multiple files to update

## Prerequisites
- Blast radius assessed (know all files to change)
- Update order determined
- Repo Prompt + HelixDB connected

---

## Methodology

**Why Order Matters:**
If you update a consumer before updating the producer, you get:
- Type errors (consumer expects new shape, producer returns old)
- Runtime errors (consumer accesses field that doesn't exist yet)
- Test failures (tests run against inconsistent state)

**Correct Order:**
```
Types → Producers → Consumers → Tests
(Roots)            (Leaves)
```

---

## Protocol

### Step 1: Build Dependency Order (HelixDB)

From your change target:
```
helix: get_references("<target>")
helix: get_definitions("<dependencies>")
```

**Build dependency graph:**
```
types/product.ts (defines Product)
       ↓
convex/products.ts (produces Product)
       ↓
Products.tsx (transforms Product)
       ↓
SkuPillEditor.tsx (renders Product.skuParts)
```

**Determine order:**
1. Types/Interfaces (contract definition)
2. Producers (API, queries, mutations)
3. Transformers (hooks, utilities, state)
4. Consumers (components, pages)
5. Tests (assertions, fixtures)

### Step 2: Load All Files (Repo Prompt)

```
manage_selection(op: "set", paths: [<all files in order>], mode: "full")
workspace_context(include: ["tokens"])
```

**If over token budget:**
- Work in batches: (types + producers), then (consumers + tests)
- Keep type files loaded throughout for reference

### Step 3: Execute Changes Atomically

For each file in dependency order:

**Apply the change:**
```
apply_edits(path: "<file>", search: "<old>", replace: "<new>")
```

**Verify structure after:**
```
get_code_structure(scope: "paths", paths: ["<file>"])
```

**Check downstream compatibility:**
Does new signature match what next file expects?

### Step 4: Cross-Verify Completeness

**Search for any remaining old patterns:**
```
helix: search_code("<old_pattern>", limit: 20)
```

If results → migration incomplete, find and update.

**Run seam verification:**
Invoke `verify-seams` skill on modified files.

---

## Output Format

```markdown
## Coordinated Change: [Description]

### Change Summary
| Property | Value |
|----------|-------|
| Change | Add skuSource field to Product |
| Files affected | 6 |
| Execution time | ~15 min |

### Execution Log

| Order | File | Change | Status | Notes |
|-------|------|--------|--------|-------|
| 1 | types/product.ts | Add `skuSource` field | ✓ Done | Contract updated |
| 2 | convex/products.ts | Populate `skuSource` | ✓ Done | Default to "auto" |
| 3 | Products.tsx | Use `skuSource` for manual flag | ✓ Done | Replaced !!sku |
| 4 | SkuPillEditor.tsx | No change needed | ✓ Skipped | Props unchanged |
| 5 | Catalog.tsx | Display skuSource badge | ✓ Done | Shows "manual" indicator |
| 6 | product.test.ts | Update fixtures | ✓ Done | All tests pass |

### Verification
| Check | Result |
|-------|--------|
| Old pattern search | 0 results |
| Seam verification | All match |
| Type check | No errors |
| Tests | Passing |

### Rollback Plan
If issues discovered:
1. `git diff` to see all changes
2. `git checkout -- <files>` to revert specific files
3. Or `git stash` to save work and revert all

### Status: ✓ COMPLETE
```

---

## Batch Execution Pattern

For large changes (10+ files), work in batches:

### Batch 1: Contract Layer
```
manage_selection(op: "set", paths: ["types/", "schema/"], mode: "full")
# Apply type changes
# Verify types compile
```

### Batch 2: Producer Layer
```
manage_selection(op: "set", paths: ["api/", "convex/", "lib/"], mode: "full")
# Apply producer changes
# Verify producers return new shape
```

### Batch 3: Consumer Layer
```
manage_selection(op: "set", paths: ["components/", "pages/"], mode: "full")
# Apply consumer changes
# Verify consumption works
```

### Batch 4: Test Layer
```
manage_selection(op: "set", paths: ["tests/", "*.test.*"], mode: "full")
# Update fixtures and assertions
# Run tests
```

---

## Conflict Resolution

**If files have circular dependencies:**
1. Identify the cycle
2. Break by introducing interface/type layer
3. Update interface first, then implementations

**If change breaks mid-execution:**
1. Note which files completed
2. Rollback incomplete files: `git checkout -- <file>`
3. Diagnose what broke
4. Resume from failed step

---

## Limitations
- Cannot guarantee runtime correctness (only structural)
- Concurrent changes by others may conflict
- Very large changes may exceed context limits
- Some frameworks have initialization order requirements beyond code

## Anti-Patterns
- ❌ Updating consumer before producer
- ❌ Skipping type updates "to save time"
- ❌ Updating tests before code (tests will fail during execution)
- ❌ Leaving migration half-done "to test"

## Next Actions
1. After completion, run `verify-seams`
2. Run test suite
3. If new integration pattern, `extract-contract`
