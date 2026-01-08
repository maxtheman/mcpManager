---
name: extract-contract
description: After successful integration, capture the working contract as a reusable skill. Prevents the same integration from breaking again. Trigger after fixing integration bugs or completing complex features.
---

# Contract Extraction

## Purpose
Capture working integration knowledge as a skill so future agents don't repeat mistakes. Transform tribal knowledge into executable guidance.

## When to Use
- After fixing an integration bug
- After completing a feature spanning multiple files
- When the "right way" wasn't obvious
- When you notice a pattern that could break again
- After any task where you learned something non-obvious

## Prerequisites
- Integration working correctly
- Understanding of what made it work
- Know which files participate
- Identified anti-patterns (what NOT to do)

---

## Methodology

**What is a Contract?**
A contract is the implicit agreement between producer and consumer:
- What data shape is expected
- What invariants must hold
- What assumptions exist
- What breaks if violated

**Why Extract?**
- Future agents inherit your knowledge
- Prevents regression to known bugs
- Documents the "why" alongside the "what"
- Creates searchable patterns for common issues

---

## Protocol

### Step 1: Identify Contract Elements

**Participating files:**
```
manage_selection(op: "get", view: "files")
```
Which files must stay in sync?

**Invariants:**
What must ALWAYS be true?
- "skuParts must be passed when template exists"
- "isManuallyEdited must compare to generatedSku, not !!sku"

**Anti-patterns:**
What broke it before?
- "Using !!sku to determine manual state"
- "Dropping skuParts in prop drilling"

**Verification steps:**
How would someone verify this works?

### Step 2: Determine Trigger Conditions

Write a description that will trigger discovery:
- What files? "Products.tsx, SkuPillEditor, generateSkuPreview"
- What concepts? "SKU generation, manual override, pill display"
- What actions? "modifying SKU data flow"

### Step 3: Write the Contract Skill

```
file_actions(
  action: "create",
  path: "~/.claude/skills/<contract-name>/SKILL.md",
  content: "<skill content>"
)
```

### Step 4: Copy to Codex (if using both)

```
file_actions(
  action: "create", 
  path: "~/.codex/skills/<contract-name>/SKILL.md",
  content: "<same content>"
)
```

### Step 5: Verify Trigger

Test: Would an agent working on these files find this skill?
- Description must mention specific file names
- Description must mention concepts/features

---

## Contract Skill Template

```markdown
---
name: <feature>-contract
description: Integration contract for <feature>. Trigger when modifying: <file1>, <file2>, <file3>, or working on <concept>.
---

# <Feature> Integration Contract

## Purpose
<1-2 sentences on what this contract ensures>

## When This Applies
- Modifying <specific files>
- Working on <feature/concept>
- Debugging <symptom patterns>

## Participating Files

| File | Role | Key Symbols |
|------|------|-------------|
| path/to/producer.ts | Produces data | functionName, TypeName |
| path/to/consumer.tsx | Consumes data | ComponentName |
| path/to/types.ts | Defines contract | InterfaceName |

## Data Flow

```
Producer (file.ts)
    │
    ▼ returns Shape
Transformer (hook.ts)  
    │
    ▼ passes as props
Consumer (Component.tsx)
```

## Invariants (MUST be true)

1. **<Invariant name>**
   - Condition: <what must be true>
   - Violated when: <what breaks it>
   - Check: <how to verify>

2. **<Invariant name>**
   - Condition: <what must be true>
   - Violated when: <what breaks it>
   - Check: <how to verify>

## Anti-Patterns (DO NOT)

| Pattern | Why It Breaks | Correct Approach |
|---------|---------------|------------------|
| `<bad pattern>` | <explanation> | `<good pattern>` |
| `<bad pattern>` | <explanation> | `<good pattern>` |

## Verification Protocol

1. **Check producer:**
   ```
   get_code_structure(scope: "paths", paths: ["<producer>"])
   ```
   Verify: <what to look for>

2. **Check consumer:**
   ```
   read_file(path: "<consumer>", start_line: N, limit: 20)
   ```
   Verify: <what to look for>

3. **Verify seam:**
   Producer field `X` → Consumer expects `X` (exact match)

## Known Bug History

| Date | Bug | Root Cause | Fix |
|------|-----|------------|-----|
| <date> | <symptom> | <cause> | <fix applied> |

## Test Coverage

| Test File | What It Verifies |
|-----------|------------------|
| <test.ts> | <invariant tested> |

## Related Contracts
- `<other-contract>` - <relationship>
```

---

## Output Format

```markdown
## Contract Extracted: [Name]

### Skill Created
| Property | Value |
|----------|-------|
| Path | ~/.claude/skills/<name>/SKILL.md |
| Also copied to | ~/.codex/skills/<name>/SKILL.md |
| Trigger pattern | "<description excerpt>" |

### Contract Coverage
| Element | Count |
|---------|-------|
| Participating files | 4 |
| Invariants | 3 |
| Anti-patterns | 2 |
| Verification steps | 3 |

### Trigger Test
An agent working on Products.tsx would find this skill: ✓ Yes
Search terms that would match: "SKU", "SkuPillEditor", "manual override"

### Future Agent Benefit
When modifying <files>, future agents will:
1. Find this contract via description match
2. Read invariants before coding
3. Avoid documented anti-patterns
4. Verify using documented steps
5. Learn from bug history
```

---

## Quality Checklist

Before finalizing contract:

- [ ] **Specific trigger:** Description mentions exact file names
- [ ] **Clear invariants:** Each invariant is testable
- [ ] **Actionable anti-patterns:** Each shows what TO do, not just what NOT to do
- [ ] **Verification steps:** Include actual tool calls
- [ ] **Bug history:** Documents what broke before (if applicable)
- [ ] **Test coverage:** Links to relevant tests

---

## Limitations
- Skills are discovered by description matching (semantic, not exact)
- Very long skills may not be fully loaded
- Skills don't auto-update when code changes
- Agent must choose to read skill (not forced)

## Maintenance
Contracts should be updated when:
- New files join the integration
- New invariants discovered
- New anti-patterns found
- Bugs occur despite contract (improve it)

## Anti-Patterns for Contract Writing
- ❌ Too generic ("don't break things")
- ❌ Too specific (only works for one exact scenario)  
- ❌ No verification steps (untestable)
- ❌ Missing file names in description (won't trigger)
- ❌ Wall of text (won't be read)
