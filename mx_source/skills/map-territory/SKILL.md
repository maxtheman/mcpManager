---
name: map-territory
description: First step for any task. Uses HelixDB to map code relationships, then loads precise context into Repo Prompt. Trigger when starting work, feeling lost, or context seems stale.
---

# Territory Mapping

## Purpose
Build a complete architectural mental model before touching code. Replaces manual grep/find with semantic graph traversal.

## When to Use
- Starting any new task
- Unfamiliar area of codebase
- Context feels incomplete or stale
- Task description mentions multiple files/components

## Prerequisites
- HelixDB MCP server connected and indexed
- Repo Prompt MCP server connected
- Know the "anchor" (component, function, type, or concept to start from)

---

## Protocol

### Phase 1: Identify Anchor
Ask yourself or the user: What is the entry point?
- Component name: `SkuPillEditor`
- Function name: `generateSkuPreview`
- Type name: `Product`
- Concept: "SKU generation logic"

### Phase 2: Graph Traversal (HelixDB)

**Find consumers (what calls the anchor):**
```
helix: get_references("<anchor_name>")
```

**Find dependencies (what anchor relies on):**
```
helix: get_definitions("<symbols_used_in_anchor>")
```

**Find call hierarchy (for functions):**
```
helix: get_call_hierarchy("<function_name>")
```

**Semantic search (when name unknown):**
```
helix: search_code("<concept description>", limit: 10)
```

**Expected output:** 5-15 files with relationship types noted.

### Phase 3: Context Loading (Repo Prompt)

**Clear stale context:**
```
manage_selection(op: "clear")
```

**Load graph-identified files as codemaps:**
```
manage_selection(op: "add", paths: [<files from Phase 2>], mode: "codemap_only")
```

**Check token budget:**
```
workspace_context(include: ["tokens", "selection"])
```

**Promote anchor and key consumers to full:**
```
manage_selection(op: "promote", paths: ["<anchor>", "<primary_consumer>"])
```

### Phase 4: Validate Understanding

Before proceeding, confirm:
1. **Data origin:** Where does the data come from?
2. **Transformations:** What happens along the way?
3. **Consumption:** Where does it end up?
4. **Seams:** Where are the integration boundaries?

If unclear → return to Phase 2 with refined queries.

---

## Output Format

```markdown
## Territory Map: [Feature/Bug Name]

### Anchor
| Property | Value |
|----------|-------|
| File | path/to/anchor.ts |
| Symbol | functionName / ComponentName |
| Type | Component / Function / Type / API |

### Dependency Graph

#### Upstream (data sources)
| File | Symbol | Produces |
|------|--------|----------|
| api/products.ts | generateSkuPreview | SkuPreview object |
| schema.ts | Product | Type definition |

#### Downstream (consumers)
| File | Symbol | Consumes |
|------|--------|----------|
| Products.tsx | ProductEditor | skuPreview via useQuery |
| SkuPillEditor.tsx | SkuPillEditor | skuParts via props |

#### Seams (integration points)
| From | To | Data | Mechanism |
|------|-----|------|-----------|
| generateSkuPreview | Products.tsx | SkuPreview | useQuery hook |
| Products.tsx | SkuPillEditor | skuParts | props |

### Context Loaded
| File | Mode | Tokens (approx) |
|------|------|-----------------|
| anchor.ts | full | ~500 |
| consumer.tsx | full | ~800 |
| types.ts | codemap | ~100 |

**Total tokens:** ~1400 / budget
```

---

## Limitations
- Graph queries miss dynamic imports (`import()` expressions)
- Aliased re-exports may not trace fully
- Very large codebases may need scoped queries (start from subdirectory)
- Runtime-constructed function calls invisible to static analysis

## Next Actions After Mapping
1. If debugging → invoke `trace-to-root`
2. If changing shared code → invoke `blast-radius`
3. If implementing → invoke `coordinate-changes`
