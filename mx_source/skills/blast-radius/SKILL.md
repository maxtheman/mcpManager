---
name: blast-radius
description: Before modifying shared code (types, APIs, utilities), find all consumers. Prevents partial migrations and broken integrations. Trigger before changing any exported symbol.
---

# Blast Radius Assessment

## Purpose
Know exactly what will break before changing shared code. Prevents "fixed one thing, broke three others."

## When to Use
- Changing a type definition
- Modifying a function signature
- Renaming a prop or field
- Altering API response shape
- Updating shared utility
- Any change to exported symbols

## Prerequisites
- Change clearly defined (what's changing, how)
- HelixDB indexed and connected
- Repo Prompt connected

## Included Files (Optional)

This skill can bundle extra files in its directory.

- `scripts/read_file.py`: quick file-read preview script (demo/testing)
  - Run (from this skill folder): `python3 scripts/read_file.py path/to/file --max-bytes 4096`
  - Run (absolute path, user-scope install): `python3 ~/.codex/skills/blast-radius/scripts/read_file.py path/to/file`
  - (Optional) If you use `uv`: `uv run python scripts/read_file.py path/to/file`
- `scripts/run_uv.sh`: convenience wrapper
  - Runs with plain `python3` by default
  - If you add a `pyproject.toml` to this skill, it will create/use an isolated env at `~/.Mx/skill-envs/blast-radius` (override with `MX_SKILL_ENVS_DIR`) and run via `uv`
  - Run: `bash ~/.codex/skills/blast-radius/scripts/run_uv.sh scripts/read_file.py README.md --max-bytes 200`

---

## Protocol

### Step 1: Define the Change

**Document before starting:**

| Property | Value |
|----------|-------|
| Target file | `src/types/product.ts` |
| Symbol | `Product` type |
| Change type | Add field / Remove field / Rename / Change type |
| Before | `{ sku: string }` |
| After | `{ sku: string, skuSource: "auto" \| "manual" }` |
| Breaking | New required field |

### Step 2: Find All Consumers (HelixDB)

**For types:**
```
helix: get_references("<TypeName>")
```

**For functions:**
```
helix: get_call_hierarchy("<functionName>")
```

**For components:**
```
helix: get_references("<ComponentName>")
```

**For renamed fields:**
```
helix: search_code("<oldFieldName>", limit: 50)
```

### Step 3: Categorize Impact

For each consumer, read the usage:
```
read_file(path: "<consumer>", start_line: N, limit: 20)
```

**Categorize by risk:**

| Category | Definition | Action Required |
|----------|------------|-----------------|
| **Direct** | Uses changed field/param directly | MUST update |
| **Passthrough** | Receives and passes without transforming | MAY need type annotation |
| **Type-only** | Only imports the type | Update if renamed |
| **Test** | Test asserting on old shape | MUST update fixtures |
| **Indirect** | Uses via intermediate | Check intermediate |

### Step 4: Build Update Plan

**Order by dependency (roots first):**

1. Type definitions (the contract)
2. Producers (where data created)
3. Direct consumers
4. Passthroughs
5. Tests

### Step 5: Load Impact Set (Repo Prompt)

```
manage_selection(op: "set", paths: [<all impacted files>], mode: "codemap_only")
workspace_context(include: ["tokens", "selection"])
```

**If over budget, prioritize:**
1. Direct consumers → full
2. Tests → full  
3. Passthroughs → codemap

---

## Output Format

```markdown
## Blast Radius: [Change Description]

### Change Definition
| Property | Before | After |
|----------|--------|-------|
| File | src/types/product.ts | - |
| Symbol | Product | - |
| Field | - | skuSource: "auto" \| "manual" |
| Breaking | - | Yes (new required field) |

### Impact Assessment

#### By Category
| Category | Count | Files |
|----------|-------|-------|
| Direct | 3 | Products.tsx, Catalog.tsx, QuoteBuilder.tsx |
| Passthrough | 1 | ProductList.tsx |
| Type-only | 2 | index.ts, types.ts |
| Test | 2 | product.test.ts, catalog.test.ts |

#### Detailed Impact
| File | Category | Risk | Specific Change Needed |
|------|----------|------|------------------------|
| Products.tsx | Direct | HIGH | Add skuSource to form state |
| Catalog.tsx | Direct | HIGH | Display skuSource indicator |
| QuoteBuilder.tsx | Direct | MED | Handle missing skuSource |
| ProductList.tsx | Passthrough | LOW | Type annotation only |
| product.test.ts | Test | HIGH | Update all Product fixtures |
| catalog.test.ts | Test | HIGH | Update assertions |

### Update Order
| Order | File | Change | Depends On |
|-------|------|--------|------------|
| 1 | types/product.ts | Add skuSource field | - |
| 2 | convex/products.ts | Populate skuSource in queries | Step 1 |
| 3 | Products.tsx | Consume skuSource | Steps 1-2 |
| 4 | Catalog.tsx | Display skuSource | Steps 1-2 |
| 5 | QuoteBuilder.tsx | Handle skuSource | Steps 1-2 |
| 6 | product.test.ts | Update fixtures | Steps 1-5 |

### Migration Checklist
- [ ] All direct consumers identified
- [ ] Update order determined
- [ ] Tests identified for update
- [ ] Rollback plan documented
```

---

## Verification After Changes

**Search for stragglers:**
```
helix: search_code("<old_field_name>", limit: 20)
```

If results found → migration incomplete.

---

## Limitations
- Dynamic property access (`obj[key]`) not detected
- String-based field access (`obj["field"]`) may be missed
- Runtime-only consumers (config files, external systems) invisible
- Transitive dependencies may need recursive queries

## Risk Levels

| Change Type | Typical Risk | Mitigation |
|-------------|--------------|------------|
| Add optional field | Low | Usually safe, verify defaults |
| Add required field | High | All consumers must update |
| Remove field | High | Must verify no usage remains |
| Rename field | High | Find-replace across all consumers |
| Change type | Medium-High | Verify coercion doesn't hide bugs |
| Change optionality | Medium | Required→optional safe; reverse risky |

## Next Actions
1. Execute `coordinate-changes` with the update order
2. After changes, run `verify-seams`
3. If pattern likely to recur, `extract-contract`
