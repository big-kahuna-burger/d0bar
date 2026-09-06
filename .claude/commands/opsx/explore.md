---
name: "OPSX: Explore"
description: "Enter explore mode - think through ideas, investigate problems, clarify requirements"
allowed-tools: Bash(openspec:*)
category: "Workflow"
tags: ["workflow", "explore", "experimental", "thinking"]
---

<!--
  Thin on purpose. The body of this workflow lives in exactly one place: the skill named
  above.

  `openspec` generates both a skill and a slash command per workflow, with the same
  instructions in each. Measured across the six: 1211 lines of skill against 1123 of command,
  differing by 16 to 152 lines apiece and identical in substance. Both are advertised to an
  agent every session, so the duplicate was being carried twice for nothing.

  There is no CLI flag to install one mechanism rather than both, so `openspec update` will
  regenerate the long version over this file. If these files grow back, that is what happened
  — re-collapse them rather than assuming someone reverted it on purpose.
-->

Invoke the `openspec-explore` skill and follow it. It is the single source of truth for this
workflow; everything below is only about how `/opsx:explore` reads its argument.

**Input**: The argument after `/opsx:explore` is whatever the user wants to think about. Could be:
- A vague idea: "real-time collaboration"
- A specific problem: "the auth system is getting unwieldy"
- A change name: "add-dark-mode" (to explore in context of that change)
- A comparison: "postgres vs sqlite for this"
- Nothing (just enter explore mode)
