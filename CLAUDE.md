# CLAUDE.md

This file serves dual purpose: (1) development guide for the docr CLI tool, and (2) **schema** for the HRSSC team knowledge base — defining structure, conventions, and workflows that Claude Code follows when maintaining the wiki.

Role: **资深 HRSSC 知识管理专家**

---

## Part 1: Project (docr CLI)

### Commands

```
npm run scan -- <dir>        # Scan directory, build index
npm run search -- <dir> <q>  # Search indexed markdown files
npm run serve -- <dir>       # Start web UI on port 3000 (--port override)
npm test                     # Run all tests (Node.js native test runner)
npm run test:watch           # Run tests in watch mode
```

### Architecture

**Pipeline:** scanner → indexer → search (or server)

**scanner.js** — Recursive directory walk, returns `[{ path, mtimeMs, size }]` for `.md` files. Skips dot-directories and configured ignore patterns.

**indexer.js** — Parses YAML frontmatter (gray-matter), builds MiniSearch index. Returns `{ index, bodies }` where `bodies` is `Map<path, { body, frontmatter }>`. Fields: `title` (3x boost), `aliases` (2x), `tags` (2x), `body` (1x). All prefix-searchable.

**search.js** — Queries MiniSearch, returns 20 results with context snippets extracted from the bodies Map.

**server.js** — Express: `GET /` (self-contained search UI), `GET /search?q=`, `GET /stats`.

**store.js** — Cache persistence to `.docr-cache/`. `saveIndex`, `loadIndex`, `isCacheValid`.

**wikilinks.js** — Parses `[[wikilinks]]` and `![[embeds]]`. `buildLinkGraph(docs)` returns forwardLinks, backlinks, orphans, brokenLinks.

**analytics.js** — Tag counts, co-occurrence pairs.

**dashboard.js** — Full vault dashboard: note count, word count, size, tags, link graph stats.

**config.js** — `~/.docr-config.json`: vaultPath, port, ignorePatterns.

### Conventions

- ESM only (`"type": "module"`). No build step.
- Each module exports one primary function, no side effects.
- Tests in `test/`, operate on real `docs/` directory (no mocks).

---

## Part 2: Knowledge Base Schema

### Three-Layer Architecture

```
Layer 1: Raw Sources (raw/)     — Immutable. Original policy PDFs, screenshots, emails, chat logs, system requirement specs.
Layer 2: Wiki (wiki/)           — LLM-owned. Interlinked answer pages, policy interpretations, entity pages, operation guides, feature descriptions.
Layer 3: This file (CLAUDE.md)  — The schema. Role definition, workflows, page conventions.
```

### Vault Structure

```
vault/                               # H:/小事情/小事情
├── raw/                             # Layer 1: Immutable raw sources
│   ├── policies/                    #   Policy documents (PDF, scanned)
│   ├── screenshots/                 #   Email screenshots, posters, chat records
│   ├── assets/                      #   Attachments, images
│   └── specs/                       #   系统需求规格（字段逻辑、映射规则、校验规则）
├── wiki/                            # Layer 2: LLM-maintained knowledge
│   ├── _index.md                    #   Master index: by topic, role, lifecycle
│   ├── _log.md                      #   Chronological audit log
│   ├── _contradictions.md           #   Pending contradiction queue for human adjudication
│   ├── answers/                     #   标准解答页 (Standard answer pages)
│   ├── policies/                    #   政策解读页 (Policy interpretation pages)
│   ├── entities/                    #   实体页 (Entity pages: concept, dept/role, system)
│   ├── guides/                      #   系统操作指引 (System operation guides)
│   ├── features/                    #   功能特性说明 (Feature descriptions)
│   └── attachments/                 #   附件（图片等），按来源文档分子目录
│   └── synthesis/                   #   综合对比/专题研究页
├── 00_Inbox/                        # Staging area for new sources awaiting ingest
├── 01_Areas/                        # Personal domains (optional)
├── 01_Daily/                        # Daily notes (YYYY-MM-DD.md)
├── templates/                       # Page templates for LLM use
└── archives/                        # Deprecated/archived content
```

### Page Types

#### 1. 标准解答页 (Standard Answer)

**Directory**: `wiki/answers/`
**Naming**: `[主题] - [适用范围] - 标准解答`
**Template**: `templates/tpl-answer.md`

```markdown
---
title: "[主题] - 标准解答"
tags: [answer, <topic-tag>]
date: YYYY-MM-DD
scope: "全员 / 某部门 / 某地区"
status: draft-pending-review | published | outdated | archived
reviewer: ""
review_date: ""
expiry_date: ""           # 如适用
aliases: []
policy_refs: []           # [[政策页链接]]
entity_refs: []           # [[实体页链接]]
---

# [主题] - 标准解答

此解答适用对象：[全员 / 某部门 / 某地区]

## 问题变体集
- [问法1]
- [问法2]

## 标准解答
[核心回答]

## 关联政策索引
- 来源：[[政策文件名]] § [段落]

## 生效/失效日期
生效：YYYY-MM-DD
失效：YYYY-MM-DD（如适用）
注意：此数据有强时效性

## 常见追问
- Q: [追问] → A: [解答]
```

**AI 职责**:
- 初始化创建，状态设为 `draft-pending-review`
- 发现新问法 → 自动补充"问题变体集"
- 关联政策更新 → 自动修订解答内容
- `expiry_date` 临近 → 主动提醒

#### 2. 政策解读页 (Policy Interpretation)

**Directory**: `wiki/policies/`
**Naming**: `[政策文件名] - 解读`
**Template**: `templates/tpl-policy.md`

```markdown
---
title: "[政策文件名] - 解读"
tags: [policy, <topic-tag>]
date: YYYY-MM-DD
status: draft-pending-review | published | outdated
source_file: ""           # 原始文件在 raw/ 中的路径
reviewer: ""
aliases: []
---

# [政策文件名] - 解读

## 白话要点
[用日常语言重述核心内容]

## 影响范围
- 适用对象：
- 涉及流程：
- 生效时间：
注意：此数据有强时效性

## 常见理解误区
- 误区：→ 正解：
- 误区：→ 正解：

## 与旧政策差异
| 项目 | 旧规 | 新规 |
|------|------|------|
|      |      |      |

## 关联标准解答
- [[解答A - 标准解答]]
- [[解答B - 标准解答]]
```

**AI 职责**:
- 根据原始政策文件自动生成初版解读
- 建立与相关标准解答页的双向链接
- 政策更新时自动生成差异对比
- 发现新旧政策矛盾 → 追加到 `_contradictions.md`

#### 3a. 概念实体页 (Concept Entity)

**Directory**: `wiki/entities/`
**Naming**: `[概念名]`
**Template**: `templates/tpl-entity-concept.md`

```markdown
---
title: "[概念名]"
tags: [entity, concept, <topic-tag>]
date: YYYY-MM-DD
entity_type: concept
aliases: []
---

# [概念名]

## 涉及政策
- [[政策A - 解读]]
- [[政策B - 解读]]

## 涉及流程
- [[流程X - 标准解答]]

## 计算公式/关键数据
[如有]

## 关联标准解答
- [[解答Y - 标准解答]]
- [[解答Z - 标准解答]]
```

**AI 职责**: 关联页面创建/更新时，自动更新本页链接列表。

#### 3b. 部门/角色实体页 (Department/Role Entity)

**Directory**: `wiki/entities/`
**Naming**: `[部门名/角色名]`
**Template**: `templates/tpl-entity-dept.md`

```markdown
---
title: "[部门/角色名]"
tags: [entity, dept, <tag>]
date: YYYY-MM-DD
entity_type: dept
aliases: []
---

# [部门/角色名]

## 负责业务
- [业务1] → [[相关解答]]
- [业务2] → [[相关解答]]

## 联系方式
- 联系人：
- 邮箱：
- 飞书群：

## 相关系统
- [[E-HR系统]]
```

**AI 职责**: 关联页面创建/更新时，自动更新业务列表。

#### 3c. 系统实体页 (System Entity)

**Directory**: `wiki/entities/`
**Naming**: `[系统名]`
**Template**: `templates/tpl-entity-system.md`

```markdown
---
title: "[系统名]"
tags: [entity, system, <tag>]
date: YYYY-MM-DD
entity_type: system
aliases: []
---

# [系统名]

## 操作指南
- [[指南A - 标准解答]]
- [[指南B - 标准解答]]

## 常见报错
- [[错误码X - 标准解答]]
- [[错误码Y - 标准解答]]

## 负责部门
- [[IT支持组]]
```

**AI 职责**: 关联页面创建/更新时，自动更新指南和报错列表。

#### 4. 系统操作指引 (System Operation Guide)

**Directory**: `wiki/guides/`
**Naming**: `[功能名称] - 操作指引`
**Template**: `templates/tpl-guide.md`

```markdown
---
title: "[功能名称] - 操作指引"
tags: [guide, system, <feature-tag>]
date: YYYY-MM-DD
scope: ""
status: draft-pending-review
reviewer: ""
review_date: ""
aliases: []
feature_refs: []           # [[特性说明页链接]]
system_refs: []            # [[系统实体页链接]]
---

# [功能名称] - 操作指引

此指引适用对象：[全员 / 某部门 / 某角色]

## 功能简介
[一句话说明该功能做什么、解决什么问题]

## 适用范围
- 适用系统：[系统名]
- 适用角色：[角色]
- 前置条件：[如有]

## 操作步骤
1. [步骤1描述]
   - 操作路径：[菜单/按钮路径]
   - 预期结果：[操作后的页面/状态变化]
2. [步骤2描述]
   - 操作路径：
   - 预期结果：
3. [步骤3描述]
   - 操作路径：
   - 预期结果：

## 注意事项
- [容易误操作的点]
- [权限限制]
- [数据时效性说明]

## 关联功能
- [[功能A - 特性说明]]
- [[功能B - 操作指引]]
```

**AI 职责**:
- 根据系统需求文档，同时产出操作指引和特性说明两页
- 操作步骤需精确到菜单/按钮路径，便于测试人员复现
- 系统更新时自动修订操作步骤，保持与最新界面一致
- 与对应的特性说明页保持双向链接
- 同一功能需同时面向供应商时，同步创建供应商版操作指引

#### 4b. 系统操作指引 - 供应商版 (Vendor Operation Guide)

**Directory**: `wiki/guides/`
**Naming**: `[功能名称] - 操作指引（供应商）`
**Template**: `templates/tpl-guide-vendor.md`
**Use when**: 功能涉及外部供应商入口，操作路径、系统、数据范围均与内部版不同

```markdown
---
title: "[功能名称] - 操作指引（供应商）"
tags: [guide, vendor, <feature-tag>]
date: YYYY-MM-DD
scope: "外部供应商"
status: draft-pending-review
reviewer: ""
review_date: ""
aliases: []
internal_guide_refs: []    # [[内部版操作指引]]
---

# [功能名称] - 操作指引（供应商版）

此指引适用对象：**外部供应商**

## 功能简介
[该功能是什么，供应商需要在系统中完成什么操作]

## 系统入口
- 系统名称：[供应商门户/外部系统名]
- 访问地址：[URL]
- 浏览器要求：[如有]

## 前置条件
- 供应商账号已开通并激活
- 对公信息已完成认证
- [其他必要条件]

## 操作步骤
1. [步骤1描述]
   - 操作路径：[菜单/按钮路径]
   - 预期结果：[操作后的页面/状态变化]
2. [步骤2描述]
   - 操作路径：
   - 预期结果：
3. [步骤3描述]
   - 操作路径：
   - 预期结果：

## 数据可见范围
- 仅可查看/操作与自身服务相关的数据
- [其他数据隔离说明]

## 注意事项
- [权限限制]
- [常见错误操作]
- [合规要求]

## 联系支持
- 供应商管理接口人：[如有]
- 邮箱/工单入口：[如有]
```

**AI 职责**:
- 从内部版操作指引派生，调整系统入口、前置条件、数据可见范围
- 不复制内部版的操作步骤——供应商的操作路径通常完全不同
- 不得包含内部 URL、内部联系人、内网系统路径等内部信息
- 与内部版保持 `internal_guide_refs` 单向链接，内部版通过 `feature_refs` 关联特性说明页

#### 5. 功能特性说明 (Feature Description)

**Directory**: `wiki/features/`
**Naming**: `[功能模块名称] - 特性说明`
**Template**: `templates/tpl-feature.md`

特性说明页为**模块级聚合页**，一个功能模块对应一页，下属特性以编号条目列出。每条特性标注涉及平台和功能描述，不涉及操作步骤。

```markdown
---
title: "[功能模块名称] - 特性说明"
tags: [feature, <feature-tag>]
date: YYYY-MM-DD
scope: ""
status: draft-pending-review
reviewer: ""
review_date: ""
aliases: []
system_refs: []            # [[系统实体页链接]]
guide_refs: []             # [[操作指引页链接]]
---

# [功能模块名称] - 特性说明

此模块适用对象：[全员 / 某部门 / 某角色]

## 功能简介
[一句话说明该模块整体解决什么业务问题]

## 特性列表

### 1.1 [特性名称]
- 涉及平台：[全集团 / 某平台 / 某体系]
- [特性描述：做了什么、影响什么]

### 1.2 [特性名称]
- 涉及平台：[全集团 / 某平台 / 某体系]
- [特性描述]

## 关联系统
- [[系统A]]
- [[系统B]]

## 关联操作指引
- [[功能X - 操作指引]]
```

**AI 职责**:
- 从系统需求文档中提炼功能模块，按"涉及平台"维度切分特性条目
- 保持描述简洁，每条特性只说明"做了什么、影响谁"，不涉及操作步骤
- 与对应的操作指引页保持双向链接
- 系统功能变更时同步更新特性列表
- 一个功能模块对应一页特性说明，不按单一功能拆页

### Special Pages

| File | Purpose | AI Responsibility |
|------|---------|-------------------|
| `wiki/_index.md` | 按主题/角色/生命周期三级分类索引 | 每次摄入后自动更新 |
| `wiki/_log.md` | 按日期追加的审计日志，格式 `## [YYYY-MM-DD] <action> \| <desc>` | 每次操作后追加 |
| `wiki/_contradictions.md` | 发现的矛盾点队列，含状态：待裁决/已裁决/已忽略 | 摄入时检测到矛盾即追加 |

### Page Status Flow

```
draft-pending-review → published → outdated → archived
       ↑                    ↓          ↓
       └── 审核通过 ───────┘          │
              ↑_______________________↓ (政策更新回到 draft)
```

### Required Frontmatter (All Pages)

```yaml
---
title: ""                   # Required
tags: []                    # Required, lowercase hyphenated
date: YYYY-MM-DD            # Required
status: draft-pending-review | published | outdated | archived  # Required
---
```

### HRSSC-Specific Conventions

1. **标准解答页开头必写**: `此解答适用对象：[全员 / 某部门 / 某地区]`
2. **时效性标注**: 任何金额、日期、税率、比例在正文中标注 `注意：此数据有强时效性`
3. **引用精确度**: `来源：[[政策文件名]] § <段落号/条目名>`
4. **角色边界**: 主动标记矛盾、时效性风险、建议交叉引用。不直接入库——所有页面的 `status: draft-pending-review` 等待人工审核。

---

## Part 3: Workflows

### Workflow: Ingest（智能摄入与整合）

Triggered when a new source is added to `00_Inbox/` or `raw/`.

```
1.  READ the source. Identify type:
    policy-doc / SOP / FAQ / meeting-notes / weekly-report / screenshot / poster / chat-log / system-spec

2.  EXTRACT key information:
    - Core content (one sentence)
    - Applicable scope (who does this affect?)
    - Any monetary amounts, dates, rates? → flag 强时效性
    - References to existing policies or processes?

2a. IMAGE HANDLING (if source contains images — e.g. docx):
    **Step 1 — Automatic extraction (pandoc)**
    - docx sources → run `pandoc <source.docx> -t markdown --extract-media="wiki/attachments/<source-name>/" --wrap=none -o <source-pandoc.md>`
    - Result: all images extracted to `wiki/attachments/<source-name>/media/` with inline `![]()` references in the output markdown
    - Fix absolute paths to Obsidian-compatible relative paths: `../attachments/<source-name>/media/imageN.png`
    - Place the pandoc output as a reference file in `wiki/policies/` or `wiki/` for the user to review

    **Step 2 — Manual placement (user)**
    - The pandoc reference file shows every image in its original document position
    - User reviews images in Obsidian, renames them as needed (right-click → rename → auto-updates all references)
    - User manually drags images into the correct wiki pages based on actual image content
    - NOT all images need to be embedded — only those that add information beyond the text
    - AI cannot determine correct image placement (cannot read image content); this step must be done by the user

    **Step 3 — Archival (optional)**
    - Original images also saved to `raw/screenshots/<source-name>/` for backup
    - Create `raw/screenshots/<source-name>/_index.md` with image inventory

    Flag to user: "本文档有 N 张图片，已通过 pandoc 提取到 wiki/attachments/<source-name>/media/，参考文件详见 [[pandoc参考文件]]。请在 Obsidian 中对照参考文件，将图片手动插入到对应 wiki 页面。"

2b. FIELD SPEC EXTRACTION (if source contains field-level logic):
    Identify: field mappings, value rules, validation logic, code-value mappings, data source lookups
    If found → extract to raw/specs/<source-name>/
    Naming convention: raw/specs/<source-name>/字段逻辑-<topic>.md
    Format per spec file:
    ```markdown
    # <topic> - 字段逻辑
    来源：<original document path>
    提取日期：YYYY-MM-DD

    ## <字段区域/步序>
    | 字段名 | 取值逻辑 | 码值 | 必填 | 备注 |
    |--------|----------|------|------|------|
    |        |          |      |      |      |
    ```
    Wiki pages reference these with: `来源：[[raw/specs/.../字段逻辑-xxx]] § <section>`
    Note: raw/specs files are Layer 1 (immutable source), no wiki frontmatter needed.

3.  COMPARE against existing wiki:
    - Is this new information or an update to existing knowledge?
    - Does it contradict any existing page? → flag for _contradictions.md

4.  DISCUSS with you:
    Output: brief summary + image handling result + field spec extracted + suggested page placement
    Wait for: your confirmation, corrections, priority direction

5.  CONTRADICTION CHECK (step 4 continued):
    If contradiction found → propose creating a _contradictions.md entry:
    "我发现 [新信息] 与 [[已有页面]] 中的 [具体内容] 存在矛盾。
     新文件说：[内容]
     已有页面说：[内容]
     建议：[保留哪个/合并/等待裁决]
     是否需要我创建待裁决条目？"

6.  CREATE / UPDATE wiki pages (after your confirmation):
    - Write new pages using correct templates, status: draft-pending-review
    - Update affected existing pages with new cross-references
    - Update entity pages whose link lists need to change
    - Extract field-level specs to raw/specs/ if applicable
    - Save referenced screenshots to raw/screenshots/ if applicable

    Q&A BATCH INGEST rules (when source is CSV/飞书多维表格 like RAG Flow FAQ):
    a) GROUP by 三级问题分类 → one wiki page per 三级分类
    b) DEDUPLICATE: merge identical question text across platforms into one entry
    c) PLATFORM COVERAGE: scope field lists full platform names, not just a count
    d) CHUNK TRACEABILITY: all chunkIDs for the topic stored in frontmatter `rag_chunks` array
       ```yaml
       rag_chunks:
         - <chunkid1>  # <platform> - <question summary>
         - <chunkid2>  # <platform> - <question summary>
       ```
    e) SPLIT DETECTION (MANDATORY — run platform_diff.py scan after every batch ingest):
       - Group same questions across platforms, compare answer text
       - 联系人差异：答案模板相同但联系人/电话不同 → 在合并页面中以表格形式列出各平台对应联系人，不可只保留一个版本
       - 规则/流程差异：阈值不同（3次 vs 6次）、流程不同（"请联系HRBP" vs 详细步骤）、适用条件不同 → 需拆分独立页面
       - 对每个关注级差异 → flag to user: "[[主题]] 中 [平台X] 的答案与其他平台不一致（说明差异），是否需要拆分为独立页面？"
       - 差异扫描报告追加到 _log.md
    f) PAGE RELATIONSHIP fields for split scenarios:
       - Main page frontmatter: `platform_variants: ["[[分拆页]]"]`
       - Split page frontmatter: `extends: "[[主页]]"`
       - Split page scope: the specific platform name only

7.  UPDATE _index.md:
    Add/update entries for all changed pages under correct category

8.  APPEND to _log.md:
    ## [YYYY-MM-DD] ingest | <source title> | <type> | <N pages affected>
    - Created: [[pageA]], [[pageB]]
    - Updated: [[pageC]], [[pageD]]

9.  FINAL CHECK prompt:
    "所有更改已完成。建议在 Obsidian 图谱视图中检查受影响的页面，确认无遗漏。"
```

### Workflow: Query（探索式学习与固化）

Triggered when you ask a question requiring knowledge synthesis.

```
1.  READ _index.md to locate relevant pages by topic/role/lifecycle.

2.  READ the located pages in full.

3.  SYNTHESIZE answer:
    [首行] 此解答适用对象：[全员/某部门/某地区]
    [正文] 综合回答。如涉及对比，使用表格。
    [引用] 来源：[[页面A]] § <段落>；[[页面B]] § <段落>
    [时效性] 注意：此数据有强时效性（如适用）

4.  OFFER archiving:
    "此回答涉及的内容尚未独立成页。是否需要我基于此回答创建标准解答页？"

5.  IF CONFIRMED — ARCHIVE:
    a. Create the page in wiki/answers/ using tpl-answer.md template
    b. Fill: 问题变体集 (from your original question), 标准解答, 关联政策索引, 时效性
    c. Update all related entity pages' link lists
    d. Update _index.md
    e. Append _log.md:
       ## [YYYY-MM-DD] query→archive | <query summary> | → [[新页面]]
```

### Workflow: Split（平台独立答案拆分）

Triggered when: a single platform's answer within an existing standard-answer page needs to differ from the rest.

Trigger phrase examples: "XX平台的XX答案要独立出来" / "远东租赁的育儿假和其他不一样"

```
1.  READ the existing page. Identify:
    - The platform to split out
    - Which questions have different answers for that platform
    - The specific rag_chunk entries belonging to that platform

2.  EXTRACT:
    - Remove the platform from the main page's scope list
    - Remove the platform's rag_chunk entries from the main page's frontmatter
    - Update 问题变体集 if necessary (remove questions unique to the split platform)

3.  CREATE the split page:
    - Template: tpl-answer.md
    - Naming: [主题] - [平台名] - 标准解答
    - scope: the specific platform name only
    - extends: "[[主页]]" in frontmatter
    - Contains only the answers specific to that platform

4.  LINK back to main page:
    - Add `platform_variants: ["[[分拆页]]"]` to main page frontmatter

5.  UPDATE _index.md, _log.md

6.  CONFIRM to user:
    "已完成拆分。主页 [[xxx]] 现覆盖 N 个平台，独立页 [[xxx - 平台名 - 标准解答]] 仅覆盖 [平台名]。
     两个页面通过 platform_variants / extends 双向链接，用户搜索时可互相导航。"
```

### Workflow: Lint（自动化健康巡检）

Recommended frequency: **weekly**. Triggered by `docr lint` or user request.

```
1.  STRUCTURAL checks (automated via docr):
    a. Broken links: `docr broken-links`
    b. Orphan pages: `docr orphans`
    c. Vault stats: `docr stats` → compare to last week

2.  EXPIRY check (scan all pages with expiry_date or 强时效性 markers):
    a. List pages where expiry_date has passed → suggest mark as "outdated"
    b. List pages where expiry_date is within 30 days → suggest review
    c. List pages mentioning "强时效性" but MISSING expiry_date → suggest add date

3.  CONTRADICTION check:
    a. Review pending items in _contradictions.md — any still unresolved?
    b. LLM reads related pages side-by-side, flags new contradictions
    c. Any new contradictions → append to _contradictions.md

4.  PROACTIVE suggestions (基于使用模式):
    a. Check _log.md for frequently queried topics that lack dedicated pages
    b. Identify pages with high incoming links but low content quality
    c. Spot "dead-end journeys": concepts linked but missing their own page
    d. Output: "我注意到 [X] 被频繁调阅，但 [Y] 条目缺少详细解释，是否补充？"

5.  REPORT output — graded by severity:
    ## [YYYY-MM-DD] lint | weekly巡检报告
    ### 🔴 紧急
    - [需人工处理的事项]
    ### 🟡 重要
    - [建议近期处理的事项]
    ### 🔵 建议
    - [前瞻性改进建议]

    Stats snapshot: N pages | N broken links | N orphans | N expired | N contradictions pending

6.  APPEND full report to _log.md.
```

---

## Part 4: Daily Notes

At the end of each working session, write a daily note to `01_Daily/YYYY-MM-DD.md`. If the note already exists, append to it. Link to relevant vault pages with `[[wikilinks]]`.

---

## Part 5: Memory

This project has an auto-memory system at `C:\Users\sande\.claude\projects\c--slef-learning\memory\`. Key memories:

- User is learning Claude Code with this project as the sandbox
- Obsidian vault at `H:/小事情/小事情` — HRSSC team knowledge base MVP
- After each session, write daily note without being asked
- See `memory/MEMORY.md` for full index
