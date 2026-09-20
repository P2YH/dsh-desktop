# DSH Architecture Review

Standalone Host and Web Client plugin for a local-first architecture review workspace.

The package contributes both faces through a normal DSH Profile bundle:

- the Host registers authenticated workspace and review routes;
- the Web Client adds an Architecture Review panel through public DSH slots;
- the Host contributes the packaged `architecture-review-knowledge` skill to the DSH skill catalog;
- workspace data stays under an explicit local directory selected by the user.

The Settings directory button uses DSH's `uiWorkspace.pickDirectory()` service and the Profile's directory picker. Cancelling leaves the current path untouched; a typed path remains available.

From **资料与知识**, **维护知识** starts a DSH session rooted in the selected workspace. Enter a question and choose **查询** to check the wiki against original sources. Progress and answers remain in the workbench, where you can stop a running task or ask follow-up questions in the same session. **资料核对** from a review detail opens its result in the same workbench view. These agent tasks are separate from the Host's deterministic import summary and local completeness checks; findings and decisions remain subject to human confirmation. The skill is also available directly as `/architecture-review-knowledge` in a DSH session.

Creating a project saves a draft and optional 待评审资料. The detail page offers a separate 资料预检, which can run with zero materials to produce a missing-item list. Choose participating experts; collaboration through the Profile's public `subagent` tool is always enabled. Applicable Markdown standards under `raw/sources/standards/` are derived from the selected experts' catalog references, and missing originals block expert review. The Host records hashes of the source and standards snapshot and prevents duplicate runs. Tool results are matched to expert IDs; a call without a result never counts as completion. Run ID, session ID, individual status and original conclusions persist in `expert-run.json`. The workbench restores the session on return and can retry a failed expert alone.

Expert opinions are grouped conservatively by matching title in `candidates.json`, with original wording, evidence, counter-evidence and limitations retained. A human confirms, rejects, requests evidence, or accepts risk with a recorded reason. The Host opens decisions only after expert tasks settle and candidates are handled; an unconditional approval additionally requires all experts and traceable original evidence. Reports include the run snapshot, individual results, human dispositions and limitations. The base DSH Profile supplies the subagent service and in-process spawn provider; this plugin adds no private Desktop or Electron dependency.

## Build and verify

From the repository root:

```powershell
corepack yarn workspaces focus dsh-plugin-architecture-review
corepack yarn workspace dsh-plugin-architecture-review check
```

## Install into a Profile

Build a tarball, then install it through the DSH plugin command:

```powershell
corepack yarn workspace dsh-plugin-architecture-review pack --out ../.build/dsh-plugin-architecture-review.tgz
dsh plugin --profile architecture-review add ./.build/dsh-plugin-architecture-review.tgz
```

The package has one direct runtime dependency: `@deepseek-ai/dsh-atomic-write`. Cordis, Connection, WebServer, Skill, Session Controller, React, and the UI services are supplied by the selected DSH Web Profile.
