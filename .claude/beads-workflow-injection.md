<beads-workflow>
<requirement>You MUST follow this workflow for ALL implementation work.</requirement>

<on-task-start>
1. **Parse task parameters from orchestrator:**
   - BEAD_ID: Your task ID (e.g., BD-001 for standalone, BD-001.2 for epic child)
   - EPIC_ID: (epic children only) The parent epic ID (e.g., BD-001)

2. **Mark in progress (claim):**
   ```bash
   bd update {BEAD_ID} --claim
   ```
   `--claim` sets status=in_progress AND assigns the bead to you in one call.

3. **Read bead comments for investigation context:**
   ```bash
   bd show {BEAD_ID}
   bd comments {BEAD_ID}
   ```

4. **Read project context:**
   ```bash
   cat PROJECT-CONTEXT.md
   ```

5. **If epic child: Read design doc:**
   ```bash
   design_path=$(bd show {EPIC_ID} --json | jq -r '.[0].design // empty')
   # If design_path exists: Read and follow specifications exactly
   ```

6. **Invoke discipline skill:**
   ```
   Skill(skill: "subagents-discipline")
   ```

7. **Record start commit:**
   ```bash
   START_COMMIT=$(git rev-parse HEAD)
   ```
   Save this for the completion report — orchestrator uses it for code review scope.
</on-task-start>

<execute-with-confidence>
The orchestrator has investigated and logged findings to the bead.

**Default behavior:** Execute the fix confidently based on bead comments.

**Only deviate if:** You find clear evidence during implementation that the fix is wrong.

If the orchestrator's approach would break something, explain what you found and propose an alternative.
</execute-with-confidence>

<during-implementation>
1. Work in the project root directory on the current branch
2. Commit frequently with descriptive messages referencing BEAD_ID
3. Log progress: `bd comments add {BEAD_ID} "Completed X, working on Y"`
</during-implementation>

<on-completion>
WARNING: You will be BLOCKED if you skip any step. Execute ALL in order:

1. **Simplify — проверка на дублирование и упрощение:**
   ```
   /simplify
   ```

2. **Commit ONLY your changes (НЕ использовать `git add -A` или `git add .`):**
   ```bash
   # Add only the specific files you changed by name — never -A / .
   git add file1 file2 ... && git commit -m "feat/fix: description [{BEAD_ID}]"
   ```

3. **Push via merge-slot (serialises concurrent sessions):**
   ```bash
   bd merge-slot acquire
   git pull --rebase && git push
   bd merge-slot release
   ```
   The merge-slot prevents two parallel sessions from racing on the same remote.

4. **Optionally log learnings:**
   ```bash
   bd comments add {BEAD_ID} "LEARNED: [key technical insight]"
   ```
   If you discovered a gotcha or pattern worth remembering, log it. Not required.

5. **Leave completion comment:**
   ```bash
   bd comments add {BEAD_ID} "Completed: [summary]"
   ```

6. **Mark status inreview — supervisor's job ends here:**
   ```bash
   bd update {BEAD_ID} --status inreview
   ```
   Review chain (simplified → reviewed → accepted → closed) is run by orchestrator afterwards. Do NOT set those statuses yourself.

7. **Return completion report:**
   ```
   BEAD {BEAD_ID} COMPLETE
   Branch: {current_branch}
   Start-Commit: {START_COMMIT}
   Files: [names only]
   Tests: pass
   Summary: [1 sentence]
   ```

The SubagentStop hook verifies: no unpushed commits, bead status updated, completion format present.
</on-completion>

<banned>
- Working directly on main/master branch
- Implementing without BEAD_ID
- Merging your own branch (user merges via PR when feature is done)
- Force-pushing
</banned>

<note>
Схема выше — supervisor-side workflow. Orchestrator после возврата supervisor'а запускает skill `reviewing-code` (simplify → review → RAMS/WIG → locale-sync → acceptance → close). Supervisor НЕ вызывает skill `land` — push выполняется inline как часть Step 3 в `<on-completion>` выше.
</note>
</beads-workflow>
