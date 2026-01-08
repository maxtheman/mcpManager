---
name: verify-seams
description: After making changes, verify all integration points match. Uses HelixDB to find seams, Repo Prompt to inspect both sides. Trigger after any multi-file change before declaring done.
---

# Seam Verification

## Purpose
Prove that integrations actually connect. The most common bugs live at boundaries between components/modules. This skill makes "it compiles" into "it works."

## When to Use
- After any multi-file change
- After fixing a bug (verify fix didn't break other seams)
- Before declaring a task "done"
- When integration behavior seems wrong

## Prerequisites
- Changes already applied
- Know which files were modified
- HelixDB + Repo Prompt connected

---

## Methodology

**What is a Seam?**
A seam is where data crosses a boundary:
- API response → Frontend consumer
- Parent component → Child props
- Context provider → Context consumer
- Function return → Caller usage
- Type definition → Implementation

**Why Seams Break:**
- Producer changes signature, consumer doesn't update
- Field renamed on one side
- Optionality mismatch (required vs optional)
- Type mismatch masked by `any` or casting
- Silent defensive code (`?.`) hides missing data

---

## Protocol

### Step 1: Identify Seams (HelixDB)

For each modified file:
```
helix: get_references("<modified_symbol>")
helix: get_definitions("<consumed_symbols>")
```

**Build seam list:**
```
producer_file:symbol → consumer_file:usage
```

### Step 2: Verify Each Seam

For each seam identified:

**Get producer contract:**
```
get_code_structure(scope: "paths", paths: ["<producer_file>"])
```

Extract:
- Return type / exported type
- Field names
- Optional markers (`?`)
- Default values

**Get consumer usage:**
```
read_file(path: "<consumer_file>", start_line: N, limit: 30)
```

Extract:
- How fields are accessed
- What's assumed about shape
- Defensive code present

### Step 3: Compare Contracts

| Check | Producer | Consumer | Status |
|-------|----------|----------|--------|
| Field exists | `skuParts` defined | `props.skuParts` accessed | ✓ or ✗ |
| Type matches | `Array<Part>` | expects `.map()` | ✓ or ✗ |
| Optionality | required (`skuParts:`) | `skuParts?.map()` | ⚠️ |
| Naming | `skuParts` | `parts` | ✗ MISMATCH |

### Step 4: Flag and Fix Mismatches

**Type mismatch:**
Producer returns `string`, consumer expects `number`
→ Fix producer, consumer, or add explicit conversion

**Name mismatch:**
Producer has `skuParts`, consumer accesses `parts`
→ Rename to match or add explicit mapping

**Optionality mismatch:**
- Producer required, consumer defensive → OK (safe)
- Producer optional, consumer assumes present → BUG (will crash)

**Shape mismatch:**
Producer returns `{ data: X }`, consumer accesses `X` directly
→ Consumer must unwrap or producer must flatten

---

## Output Format

```markdown
## Seam Verification: [Task/Feature Name]

### Summary
| Metric | Value |
|--------|-------|
| Seams checked | 5 |
| Matches | 4 |
| Mismatches | 1 |
| Status | ⚠️ ISSUES FOUND |

### Seams Checked

| # | Producer | Consumer | Data | Status |
|---|----------|----------|------|--------|
| 1 | generateSkuPreview | Products.tsx | SkuPreview | ✓ MATCH |
| 2 | Products.tsx | SkuPillEditor | skuParts | ✓ MATCH |
| 3 | Products.tsx | SkuPillEditor | isManuallyEdited | ✗ MISMATCH |
| 4 | Product type | ProductList | Product[] | ✓ MATCH |
| 5 | convex/products | Catalog.tsx | Product | ✓ MATCH |

### Mismatch Details

#### Seam #3: isManuallyEdited
| Side | File:Line | Contract |
|------|-----------|----------|
| Producer | Products.tsx:145 | `!!formData.sku` (boolean from truthy check) |
| Consumer | SkuPillEditor:23 | Expects true only when SKU manually overridden |

**Problem:** Producer computes from existence, consumer expects semantic meaning.

**Fix:** Change producer to `formData.sku !== skuPreview?.generatedSku`

### Verification Checklist
- [x] All seams from modified files identified
- [x] Producer contracts extracted
- [x] Consumer usages inspected
- [ ] All mismatches resolved
- [ ] Re-verified after fixes

### Evidence
| Seam | Producer Evidence | Consumer Evidence |
|------|-------------------|-------------------|
| #3 | `get_code_structure` shows return type | `read_file` lines 20-30 show usage |
```

---

## Quick Verification Checklist

For each seam, verify:

- [ ] **Field names match exactly** (no renaming without mapping)
- [ ] **Types align** (no implicit coercion)
- [ ] **Optionality consistent** (required→optional OK, reverse not)
- [ ] **No silent failures** (`?.` should be intentional, not defensive)
- [ ] **No type assertions** (`as any` masks real mismatches)
- [ ] **Defaults are intentional** (not hiding missing data)

---

## Limitations
- Cannot verify runtime behavior (only static contracts)
- API responses must be typed for verification
- Dynamic data shapes (JSON blobs) harder to verify
- Third-party library types may be incomplete

## Common False Positives
- Intentional defensive code (document why)
- Backward-compatible optional fields
- Overloaded functions with multiple signatures

## Next Actions
1. Fix all mismatches found
2. Re-run verification after fixes
3. If seams frequently break, `extract-contract` to prevent recurrence
