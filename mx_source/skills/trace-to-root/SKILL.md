---
name: trace-to-root
description: Systematic debugging by tracing data backwards from symptom to root cause. Uses HelixDB for relationships, Repo Prompt for inspection. Trigger when investigating bugs or unexpected behavior.
---

# Root Cause Tracing

## Purpose
Find the actual source of bugs by tracing data flow backwards. Bugs are symptoms; this finds the disease.

## When to Use
- Component renders wrong data
- Test failing unexpectedly
- API returning unexpected shape
- "It worked before" situations
- Integration appears broken

## Prerequisites
- Territory mapped (or at least anchor identified)
- Symptom clearly identified (what's wrong, where it appears)
- HelixDB + Repo Prompt connected

---

## Protocol

### Step 1: Locate Symptom

**Identify the exact expression that's wrong:**
```
read_file(path: "<symptom_file>", start_line: N, limit: 30)
```

**Document:**
- File and line number
- Variable or expression
- Expected value vs actual value

### Step 2: Find Data Source (HelixDB)

**If symptom is a prop:**
```
helix: get_references("<ComponentName>")
```
→ Shows where component is rendered, what props passed

**If symptom is from hook/function:**
```
helix: get_definitions("<hook_or_function>")
```
→ Shows implementation

**If symptom is from context/state:**
```
helix: search_code("<context_name> provider", limit: 5)
```
→ Shows where state originates

### Step 3: Walk the Chain (Iterative)

For each link discovered:

**Read the handoff point:**
```
read_file(path: "<source_file>", start_line: N, limit: 30)
```

**Check for transformation bugs:**

| Pattern | Risk | Example |
|---------|------|---------|
| Field renaming | Data lost | `skuParts` → `parts` |
| Defensive code | Silent failure | `?.`, `\|\|`, `??` |
| Type assertions | Type mismatch masked | `as any`, `as Type` |
| Computed values | Logic error | `isManual = !!sku` |
| Default values | Override intended value | `value ?? defaultValue` |

**Document each hop:**
```
API response
  → convex/products.ts:generateSkuPreview (transforms)
  → Products.tsx:useQuery (receives)
  → SkuPillEditor (consumes via props)
```

### Step 4: Identify Disconnect

The bug lives where the contract breaks:
- Shape changes unexpectedly
- Transformation drops/corrupts data
- Assumption violated
- Types say X, runtime says Y

### Step 5: Verify Hypothesis

**Check producer output:**
```
get_code_structure(scope: "paths", paths: ["<producer_file>"])
```

**Check consumer expectation:**
```
read_file(path: "<consumer_file>", start_line: N, limit: 20)
```

**Compare fields, types, optionality.**

---

## Output Format

```markdown
## Root Cause Trace: [Bug Description]

### Symptom
| Property | Value |
|----------|-------|
| File | SkuPillEditor.tsx |
| Line | 45 |
| Expression | `isManuallyEdited` |
| Expected | false (auto-generated SKU) |
| Actual | true |

### Data Flow Trace

| Step | File:Line | Action | Data Shape |
|------|-----------|--------|------------|
| 1 | convex/products.ts:67 | generateSkuPreview returns | `{ generatedSku, skuParts }` |
| 2 | Products.tsx:123 | useQuery receives | `{ generatedSku, skuParts }` |
| 3 | Products.tsx:145 | computes isManuallyEdited | `!!formData.sku` ← **BUG** |
| 4 | Products.tsx:189 | passes to SkuPillEditor | `isManuallyEdited=true` |

### Root Cause
| Property | Value |
|----------|-------|
| Location | Products.tsx:145 |
| Expression | `isManuallyEdited = !!formData.sku` |
| Problem | Treats any non-empty SKU as manually edited |
| Fix | Compare `formData.sku !== skuPreview?.generatedSku` |

### Verification
- [ ] Producer returns correct shape
- [ ] Fix applied at root cause (not symptom)
- [ ] Downstream consumers unaffected by fix
```

---

## Common Bug Patterns

| Pattern | Why It Breaks | Fix |
|---------|---------------|-----|
| `!!value` | Empty string is falsy but valid | Check against explicit sentinel |
| `value?.field` | Swallows undefined silently | Fail explicitly or default intentionally |
| `as any` | Bypasses type checking | Remove cast, fix actual type |
| `data.field` when optional | Runtime error on undefined | Add existence check |
| Wrong comparison | `==` vs `===`, string vs number | Use strict equality, normalize types |

---

## Limitations
- Cannot trace runtime-only data (API responses not in code)
- Dynamic property access (`obj[key]`) hard to trace
- Async timing bugs may not show in static trace
- State mutations outside React/framework patterns may be invisible

## Next Actions After Tracing
1. Fix at root cause, not symptom
2. Run `blast-radius` if fix changes a contract
3. Run `verify-seams` after fix applied
4. Consider `extract-contract` if pattern could recur
