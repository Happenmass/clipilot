# Skill 系统实现指导文档

> 基于 OpenClaw 项目的 Skill 机制深度解析，面向移植到其他 TypeScript 项目的实现指导。

## 目录

1. [架构概览](#1-架构概览)
2. [Skill 存储与定义格式](#2-skill-存储与定义格式)
3. [多源优先级存储](#3-多源优先级存储)
4. [Skill 发现与加载](#4-skill-发现与加载)
5. [Skill 过滤与资格评估](#5-skill-过滤与资格评估)
6. [系统提示词注入（惰性加载）](#6-系统提示词注入惰性加载)
7. [命令注册与名称规范化](#7-命令注册与名称规范化)
8. [Skill 执行——双路径架构](#8-skill-执行双路径架构)
9. [环境变量注入与安全](#9-环境变量注入与安全)
10. [SkillSnapshot 与缓存](#10-skillsnapshot-与缓存)
11. [配置系统](#11-配置系统)
12. [实现步骤指导](#12-实现步骤指导)

---

## 1. 架构概览

### 1.1 核心设计理念

Skill 系统的核心目标是让 AI agent 能够**按需获取特定领域的专业能力**，而不必将所有能力一次性塞入系统提示词。三个关键设计理念：

1. **惰性加载**：系统提示词中只注入 skill 的索引信息（名称 + 描述 + 文件路径），不注入 SKILL.md 正文。模型在需要时主动使用 `read` 工具读取完整指令。
2. **双路径执行**：简单操作走「工具派发」路径（零 LLM 调用），复杂操作走「提示词驱动」路径（模型推理执行）。
3. **多源优先级**：支持从多个目录源加载 skill，通过优先级覆盖机制实现项目级 → 用户级 → 内置级的灵活定制。

### 1.2 六层架构

```
┌──────────────────────────────────────────────────────┐
│                    存储层 (Storage)                     │
│  每个 skill = 一个目录 + SKILL.md (YAML frontmatter)     │
│  7 层优先级目录，同名去重                                 │
└──────────────────────┬───────────────────────────────┘
                       │ loadSkillEntries()
                       ▼
┌──────────────────────────────────────────────────────┐
│                   发现层 (Discovery)                    │
│  目录扫描 → frontmatter 解析 → 元数据/策略解析             │
│  安全限制（数量/大小上限）                                │
└──────────────────────┬───────────────────────────────┘
                       │ filterSkillEntries()
                       ▼
┌──────────────────────────────────────────────────────┐
│                   过滤层 (Filtering)                    │
│  配置禁用 → 内置白名单 → 运行时资格评估                    │
│  (OS / 二进制 / 环境变量 / 配置路径)                      │
└──────────┬───────────────────────┬───────────────────┘
           │                       │
           ▼                       ▼
┌────────────────────┐  ┌─────────────────────────┐
│ 提示注入层 (Inject) │  │ 命令注册层 (Commands)     │
│ 格式化 skill 列表   │  │ 生成 /command 规格        │
│ → 系统提示词        │  │ 名称规范化 + 冲突处理     │
│ 预算管控(数量+字符)  │  │                          │
└────────┬───────────┘  └───────────┬─────────────┘
         │                          │
         ▼                          ▼
┌──────────────────────────────────────────────────────┐
│                   执行层 (Execution)                    │
│  路径 A：工具派发（直接调用工具，零 LLM）                  │
│  路径 B：提示词驱动（改写输入 → 模型读取 SKILL.md → 执行）  │
└──────────────────────────────────────────────────────┘
```

### 1.3 数据流总览

```
用户输入 "/github create issue"
  ↓
命令解析 → resolveSkillCommandInvocation()
  ↓ 匹配到 "github" skill
检查 dispatch 配置
  ├─ 有 command-dispatch: tool → 工具派发路径
  │   ├─ 查找工具 → tool.execute()
  │   └─ 返回结果（无 LLM 调用）
  │
  └─ 无 dispatch → 提示词驱动路径
      ├─ 改写用户输入为：
      │   Use the "github" skill for this request.
      │   User input:
      │   create issue
      ├─ 模型读取系统提示词中的 skills 列表
      ├─ 模型用 read 工具读取 SKILL.md
      └─ 模型遵循 SKILL.md 中的指令执行
```

---

## 2. Skill 存储与定义格式

### 2.1 目录结构

每个 skill 是一个独立目录，核心文件为 `SKILL.md`：

```
skills/
├── github/
│   └── SKILL.md          # 必须：skill 定义文件
├── 1password/
│   └── SKILL.md
├── peekaboo/
│   ├── SKILL.md
│   └── templates/        # 可选：辅助资源
│       └── config.yaml
└── my-custom-skill/
    └── SKILL.md
```

**规则**：
- 目录名即为 skill 的默认名称（实际名称由 frontmatter 的 `name` 字段决定）
- 每个目录只需包含一个 `SKILL.md` 文件
- 可以包含额外辅助文件，但系统只解析 `SKILL.md`

### 2.2 SKILL.md 格式

SKILL.md 采用 **YAML frontmatter + Markdown 正文** 的格式：

```yaml
---
name: github
description: "GitHub operations via `gh` CLI: PRs, issues, releases, actions."
user-invocable: true
disable-model-invocation: false
command-dispatch: tool
command-tool: sessions_send
command-arg-mode: raw
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "primaryEnv": "GITHUB_TOKEN",
        "os": ["darwin", "linux"],
        "requires":
          {
            "bins": ["gh"],
            "env": ["GITHUB_TOKEN"],
          },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, pull requests, and issues.

## When to Use
- Checking PR status, reviews, checks
- Creating/updating issues
- Managing releases

## Common Commands

### Pull Requests
```bash
gh pr list --repo owner/repo
gh pr view 123 --repo owner/repo
```

### Issues
```bash
gh issue list --repo owner/repo
gh issue create --title "Bug" --body "Description"
```
```

### 2.3 Frontmatter 字段详解

#### 核心字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | 目录名 | Skill 唯一标识符 |
| `description` | string | 正文首段 | 简短描述，用于系统提示词索引 |
| `user-invocable` | boolean | `true` | 是否暴露为 `/command` |
| `disable-model-invocation` | boolean | `false` | 是否从系统提示词中排除 |

#### 工具派发字段（可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| `command-dispatch` | `"tool"` | 启用工具直接派发 |
| `command-tool` | string | 目标工具名称 |
| `command-arg-mode` | `"raw"` | 参数传递模式（原样转发） |

#### 元数据块（metadata）

元数据嵌套在 `metadata` 字段中，以你的项目名为键：

```typescript
type SkillMetadata = {
  always?: boolean;       // true 则跳过所有资格检查
  skillKey?: string;      // 覆盖 skill.name 用于配置查找
  primaryEnv?: string;    // API key 注入的目标环境变量名
  emoji?: string;         // 显示图标
  homepage?: string;      // 文档链接
  os?: string[];          // 平台要求 ["darwin", "linux", "win32"]
  requires?: {
    bins?: string[];      // 必须全部存在的二进制
    anyBins?: string[];   // 至少存在一个的二进制
    env?: string[];       // 必须设置的环境变量
    config?: string[];    // 必须为 truthy 的配置路径
  };
  install?: SkillInstallSpec[];  // 安装方法
};
```

### 2.4 调用策略的四种组合

| user-invocable | disable-model-invocation | 模式 | 适用场景 |
|:-:|:-:|:--|:--|
| `true` | `false` | **完全集成** | 多数 skill：用户可 `/command`，模型也能主动使用 |
| `false` | `false` | **模型专用** | 内部辅助 skill：不暴露命令，模型自行判断使用 |
| `true` | `true` | **用户专用** | 敏感操作：仅用户显式触发，模型不能主动调用 |
| `false` | `true` | **禁用** | 临时下线 skill |

### 2.5 Frontmatter 解析实现

解析流程采用 **YAML + 行解析双策略合并**：

```typescript
import yaml from "yaml";

type ParsedSkillFrontmatter = Record<string, string>;

function parseFrontmatterBlock(content: string): ParsedSkillFrontmatter {
  // 1. 标准化换行符
  const normalized = content.replace(/\r\n|\r/g, "\n");

  // 2. 检查 frontmatter 定界符
  if (!normalized.startsWith("---")) {
    return {};
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {};
  }

  // 3. 提取 frontmatter 块
  const block = normalized.slice(4, endIndex);

  // 4. YAML 解析
  let yamlResult: Record<string, unknown> = {};
  try {
    const parsed = yaml.parse(block);
    if (parsed && typeof parsed === "object") {
      yamlResult = parsed;
    }
  } catch {
    // YAML 解析失败，回退到行解析
  }

  // 5. 行解析（处理 YAML 难以正确解析的 JSON 值）
  const lineResult = parseByLines(block);

  // 6. 合并：YAML 为基础，行解析的 JSON/数组值覆盖
  const result: ParsedSkillFrontmatter = {};
  for (const [key, value] of Object.entries(yamlResult)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  for (const [key, value] of Object.entries(lineResult)) {
    if (value.startsWith("{") || value.startsWith("[")) {
      result[key] = value;  // JSON 值优先使用行解析结果
    }
  }

  return result;
}

function parseByLines(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}
```

### 2.6 元数据解析

```typescript
function resolveSkillMetadata(
  frontmatter: ParsedSkillFrontmatter,
): SkillMetadata | undefined {
  const metadataRaw = frontmatter.metadata;
  if (!metadataRaw) return undefined;

  // 解析 JSON 字符串
  let metadataObj: Record<string, unknown>;
  try {
    metadataObj = JSON.parse(metadataRaw);
  } catch {
    return undefined;
  }

  // 查找项目特定键（如 "myproject"）
  const block = metadataObj["myproject"] as Record<string, unknown> | undefined;
  if (!block) return undefined;

  return {
    always: typeof block.always === "boolean" ? block.always : undefined,
    emoji: typeof block.emoji === "string" ? block.emoji : undefined,
    homepage: typeof block.homepage === "string" ? block.homepage : undefined,
    skillKey: typeof block.skillKey === "string" ? block.skillKey : undefined,
    primaryEnv: typeof block.primaryEnv === "string" ? block.primaryEnv : undefined,
    os: Array.isArray(block.os) ? block.os.filter((v): v is string => typeof v === "string") : undefined,
    requires: resolveRequires(block.requires),
    install: resolveInstallSpecs(block.install),
  };
}

function resolveRequires(raw: unknown): SkillMetadata["requires"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const normalizeStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return {
    bins: normalizeStringList(obj.bins),
    anyBins: normalizeStringList(obj.anyBins),
    env: normalizeStringList(obj.env),
    config: normalizeStringList(obj.config),
  };
}
```

### 2.7 调用策略解析

```typescript
type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseBool(frontmatter["user-invocable"], true),
    disableModelInvocation: parseBool(frontmatter["disable-model-invocation"], false),
  };
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return defaultValue;
}
```

---

## 3. 多源优先级存储

### 3.1 七层优先级目录

系统从多个位置加载 skill，按优先级从低到高排列：

| 优先级 | 源标识 | 路径 | 说明 |
|:------:|--------|------|------|
| 1 | `extra` | 配置的 `extraDirs` + 插件 | 额外扩展目录 |
| 2 | `bundled` | `<package-root>/skills/` | 内置 skill |
| 3 | `managed` | `~/.myproject/skills/` | 用户本地共享 |
| 4 | `agents-personal` | `~/.agents/skills/` | 用户个人 agent 级别 |
| 5 | `agents-project` | `<workspace>/.agents/skills/` | 项目 agent 级别 |
| 6 | `workspace` | `<workspace>/skills/` | 项目专属（最高优先级） |

### 3.2 同名去重策略

当多个源中存在同名 skill 时，**后写入 Map 的覆盖先写入的**，即高优先级覆盖低优先级：

```typescript
function loadSkillEntries(workspaceDir: string, opts?: LoadOptions): SkillEntry[] {
  // 按优先级从低到高依次加载
  const extraSkills = loadFromExtraDirs(...);
  const bundledSkills = loadSkills({ dir: bundledSkillsDir, source: "bundled" });
  const managedSkills = loadSkills({ dir: managedDir, source: "managed" });
  const personalAgentsSkills = loadSkills({ dir: personalAgentsDir, source: "agents-personal" });
  const projectAgentsSkills = loadSkills({ dir: projectAgentsDir, source: "agents-project" });
  const workspaceSkills = loadSkills({ dir: workspaceSkillsDir, source: "workspace" });

  // 按优先级 低→高 依次写入 Map，同名覆盖
  const merged = new Map<string, Skill>();
  for (const skill of extraSkills) merged.set(skill.name, skill);
  for (const skill of bundledSkills) merged.set(skill.name, skill);
  for (const skill of managedSkills) merged.set(skill.name, skill);
  for (const skill of personalAgentsSkills) merged.set(skill.name, skill);
  for (const skill of projectAgentsSkills) merged.set(skill.name, skill);
  for (const skill of workspaceSkills) merged.set(skill.name, skill);

  // 解析 frontmatter
  return Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatterBlock(raw);
    } catch { /* 忽略损坏的 skill */ }

    return {
      skill,
      frontmatter,
      metadata: resolveSkillMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
}
```

### 3.3 路径压缩

为节省系统提示词 token，将用户 home 目录前缀替换为 `~`：

```typescript
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix)
      ? "~/" + s.filePath.slice(prefix.length)
      : s.filePath,
  }));
}
```

**效果**：每个 skill 路径节省约 5-6 个 token，50 个 skill 可节省 250-300 token。

### 3.4 嵌套 skills 目录检测

如果某个 skill 根目录下存在 `skills/` 子目录，且子目录中有 `SKILL.md` 文件，则将 `skills/` 视为真正的 skill 根：

```typescript
function resolveNestedSkillsRoot(
  dir: string,
  opts?: { maxEntriesToScan?: number },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
    return { baseDir: dir };
  }

  // 启发式检查：扫描 nested/*/SKILL.md
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = opts?.maxEntriesToScan ?? 100;
  const toScan = nestedDirs.slice(0, scanLimit);

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested };
    }
  }
  return { baseDir: dir };
}
```

---

## 4. Skill 发现与加载

### 4.1 目录扫描流程

```typescript
function loadSkills(params: { dir: string; source: string }): Skill[] {
  const { baseDir } = resolveNestedSkillsRoot(params.dir);

  // 情况 1：根目录本身就是一个 skill
  const rootSkillMd = path.join(baseDir, "SKILL.md");
  if (fs.existsSync(rootSkillMd)) {
    const size = fs.statSync(rootSkillMd).size;
    if (size > MAX_SKILL_FILE_BYTES) return [];  // 超大文件跳过
    return loadSkillsFromDir({ dir: baseDir, source: params.source });
  }

  // 情况 2：扫描子目录
  const childDirs = listChildDirectories(baseDir);
  const loadedSkills: Skill[] = [];

  for (const name of childDirs.sort().slice(0, MAX_SKILLS_LOADED_PER_SOURCE)) {
    const skillDir = path.join(baseDir, name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;

    const size = fs.statSync(skillMd).size;
    if (size > MAX_SKILL_FILE_BYTES) continue;

    const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
    loadedSkills.push(...loaded);

    if (loadedSkills.length >= MAX_SKILLS_LOADED_PER_SOURCE) break;
  }

  return loadedSkills;
}
```

### 4.2 子目录列表（安全过滤）

```typescript
function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;      // 跳过隐藏目录
      if (entry.name === "node_modules") continue;    // 跳过 node_modules

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);                    // 支持符号链接
          }
        } catch { /* 忽略断开的符号链接 */ }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}
```

### 4.3 loadSkillsFromDir 实现

这是从单个 skill 目录加载 Skill 对象的核心函数：

```typescript
type Skill = {
  name: string;           // skill 名称
  description?: string;   // 简短描述（从正文提取）
  filePath: string;       // SKILL.md 的绝对路径
  baseDir: string;        // skill 目录路径
  source: string;         // 来源标识
};

function loadSkillsFromDir(params: { dir: string; source: string }): Skill[] {
  const skillMdPath = path.join(params.dir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) return [];

  const content = fs.readFileSync(skillMdPath, "utf-8");
  const frontmatter = parseFrontmatterBlock(content);

  // 名称：frontmatter.name > 目录名
  const name = (frontmatter.name || path.basename(params.dir)).trim();
  if (!name) return [];

  // 描述：frontmatter.description > 正文第一段
  const description = frontmatter.description?.trim()
    || extractFirstParagraph(content);

  return [{
    name,
    description,
    filePath: skillMdPath,
    baseDir: params.dir,
    source: params.source,
  }];
}

function extractFirstParagraph(content: string): string {
  // 跳过 frontmatter 部分
  const bodyStart = content.indexOf("\n---", 3);
  if (bodyStart === -1) return "";
  const body = content.slice(bodyStart + 4).trim();

  // 取第一个非空、非标题行作为描述
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 200);  // 截断过长描述
  }
  return "";
}
```

### 4.4 安全限制常量

```typescript
const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;     // 每个根目录最多扫描子目录数
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200; // 每个源最多加载 skill 数
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;         // 系统提示词最多包含 skill 数
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;   // 系统提示词 skill 块最大字符数
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;     // 单个 SKILL.md 最大字节数
```

### 4.5 SkillEntry 完整数据结构

```typescript
type SkillEntry = {
  skill: Skill;                        // 基础信息
  frontmatter: ParsedSkillFrontmatter; // 原始 frontmatter
  metadata?: SkillMetadata;            // 解析后的元数据
  invocation?: SkillInvocationPolicy;  // 调用策略
};
```

---

## 5. Skill 过滤与资格评估

### 5.1 三级过滤流程

```
所有已加载的 SkillEntry[]
  │
  ├─ 第一级：配置禁用检查
  │   skillConfig.enabled === false → 排除
  │
  ├─ 第二级：内置 skill 白名单
  │   如果设置了 allowBundled 且 skill 来源为 "bundled"
  │   → skill.name 必须在白名单中
  │
  └─ 第三级：运行时资格评估
      ├─ OS 平台检查
      ├─ always: true 旁路
      ├─ bins 全部匹配检查
      ├─ anyBins 任一匹配检查
      ├─ env 环境变量检查
      └─ config 配置路径检查
```

### 5.2 shouldIncludeSkill 实现

```typescript
function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: AppConfig;
}): boolean {
  const { entry, config } = params;
  const skillKey = entry.metadata?.skillKey ?? entry.skill.name;
  const skillConfig = resolveSkillConfig(config, skillKey);

  // 第一级：配置禁用
  if (skillConfig?.enabled === false) {
    return false;
  }

  // 第二级：内置白名单
  const allowBundled = config?.skills?.allowBundled;
  if (allowBundled && allowBundled.length > 0) {
    if (entry.skill.source === "bundled") {
      if (!allowBundled.includes(skillKey) && !allowBundled.includes(entry.skill.name)) {
        return false;
      }
    }
  }

  // 第三级：运行时资格
  return evaluateRuntimeEligibility({
    os: entry.metadata?.os,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasEnv: (envName) => Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName)
    ),
    isConfigPathTruthy: (configPath) => isTruthy(resolveConfigPath(config, configPath)),
  });
}
```

### 5.3 运行时资格评估算法

```typescript
function evaluateRuntimeEligibility(params: {
  os?: string[];
  always?: boolean;
  requires?: RuntimeRequires;
  hasEnv: (envName: string) => boolean;
  isConfigPathTruthy: (pathStr: string) => boolean;
}): boolean {
  // 1. OS 平台检查
  const osList = params.os ?? [];
  if (osList.length > 0 && !osList.includes(process.platform)) {
    return false;
  }

  // 2. always=true 跳过所有后续检查
  if (params.always === true) {
    return true;
  }

  // 3. 评估 requires
  const requires = params.requires;
  if (!requires) return true;

  // 3a. bins：所有指定的二进制必须存在
  for (const bin of requires.bins ?? []) {
    if (!hasBinary(bin)) return false;
  }

  // 3b. anyBins：至少一个指定的二进制存在
  const anyBins = requires.anyBins ?? [];
  if (anyBins.length > 0) {
    if (!anyBins.some((bin) => hasBinary(bin))) return false;
  }

  // 3c. env：所有指定的环境变量必须设置
  for (const envName of requires.env ?? []) {
    if (!params.hasEnv(envName)) return false;
  }

  // 3d. config：所有指定的配置路径必须为 truthy
  for (const configPath of requires.config ?? []) {
    if (!params.isConfigPathTruthy(configPath)) return false;
  }

  return true;
}
```

### 5.4 二进制查找（带缓存）

```typescript
let cachedPath: string | undefined;
const binaryCache = new Map<string, boolean>();

function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";

  // PATH 变更时清空缓存
  if (cachedPath !== pathEnv) {
    cachedPath = pathEnv;
    binaryCache.clear();
  }

  if (binaryCache.has(bin)) {
    return binaryCache.get(bin)!;
  }

  // 遍历 PATH 的每个目录
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT?.split(";") ?? [".EXE", ".CMD", ".BAT"])]
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        binaryCache.set(bin, true);
        return true;
      } catch { /* 继续搜索 */ }
    }
  }

  binaryCache.set(bin, false);
  return false;
}
```

### 5.5 配置路径求值

支持点分路径遍历配置对象：

```typescript
function resolveConfigPath(config: unknown, pathStr: string): unknown {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}
```

### 5.6 技能过滤入口

```typescript
function filterSkillEntries(
  entries: SkillEntry[],
  config?: AppConfig,
  skillFilter?: string[],
): SkillEntry[] {
  // 基础过滤
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config }));

  // 名称过滤（如果提供了 skillFilter）
  if (skillFilter !== undefined) {
    const normalized = skillFilter.map((s) => s.trim()).filter(Boolean);
    filtered = normalized.length > 0
      ? filtered.filter((entry) => normalized.includes(entry.skill.name))
      : [];
  }

  return filtered;
}
```

---

## 6. 系统提示词注入（惰性加载）

### 6.1 Skills 必选段落结构

系统提示词中包含一个 `## Skills (mandatory)` 段落：

```typescript
function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
}): string[] {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) return [];

  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}
```

**模型行为指引**：
1. **扫描**：检查 `<available_skills>` 列表中每个 skill 的 `<description>`
2. **匹配**：找到最相关的（且只选一个）
3. **读取**：使用 `read` 工具读取 SKILL.md 的 `<location>` 路径
4. **执行**：遵循 SKILL.md 正文中的指令

### 6.2 formatSkillsForPrompt 输出格式

skill 列表使用 XML-like 标签格式化：

```xml
<available_skills>
<skill name="github" description="GitHub operations via gh CLI" location="~/skills/github/SKILL.md" />
<skill name="1password" description="1Password CLI operations" location="~/skills/1password/SKILL.md" />
<skill name="peekaboo" description="Capture and automate macOS UI" location="~/skills/peekaboo/SKILL.md" />
</available_skills>
```

实现示例：

```typescript
function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines = ["<available_skills>"];
  for (const skill of skills) {
    const desc = (skill.description ?? "").replace(/"/g, "&quot;");
    lines.push(
      `<skill name="${skill.name}" description="${desc}" location="${skill.filePath}" />`
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
```

### 6.3 提示词预算管理

两层预算管控，确保 skill 列表不会撑爆上下文窗口：

```typescript
function applySkillsPromptLimits(params: {
  skills: Skill[];
  limits: { maxSkillsInPrompt: number; maxSkillsPromptChars: number };
}): {
  skillsForPrompt: Skill[];
  truncated: boolean;
  truncatedReason: "count" | "chars" | null;
} {
  const { maxSkillsInPrompt, maxSkillsPromptChars } = params.limits;

  // 第一层：数量限制
  const byCount = params.skills.slice(0, Math.max(0, maxSkillsInPrompt));
  let skillsForPrompt = byCount;
  let truncated = params.skills.length > byCount.length;
  let truncatedReason: "count" | "chars" | null = truncated ? "count" : null;

  // 第二层：字符预算
  const fits = (skills: Skill[]): boolean => {
    return formatSkillsForPrompt(skills).length <= maxSkillsPromptChars;
  };

  if (!fits(skillsForPrompt)) {
    // 二分搜索找最大可容纳前缀
    let lo = 0;
    let hi = skillsForPrompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(skillsForPrompt.slice(0, mid))) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    skillsForPrompt = skillsForPrompt.slice(0, lo);
    truncated = true;
    truncatedReason = "chars";
  }

  return { skillsForPrompt, truncated, truncatedReason };
}
```

**二分搜索算法说明**：
- 范围 `[0, N]`，N 为通过数量限制后的 skill 数
- `mid = Math.ceil((lo + hi) / 2)` 向上取整
- 若 `slice(0, mid)` 符合预算 → 提升下界 `lo = mid`
- 若不符合 → 降低上界 `hi = mid - 1`
- 不变式：`lo` 始终是已知可行的最大前缀索引

### 6.4 截断警告

```typescript
const truncationNote = truncated
  ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}.`
  : "";
```

### 6.5 完整的提示词构建流程

```typescript
function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: BuildOptions,
): { eligible: SkillEntry[]; prompt: string; resolvedSkills: Skill[] } {
  // 1. 加载全部 skill
  const skillEntries = loadSkillEntries(workspaceDir, opts);

  // 2. 过滤（配置 + 资格 + 名称过滤）
  const eligible = filterSkillEntries(skillEntries, opts?.config, opts?.skillFilter);

  // 3. 排除 disableModelInvocation 的 skill
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );

  // 4. 预算管控
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const { skillsForPrompt, truncated } = applySkillsPromptLimits({
    skills: resolvedSkills,
    limits: resolveSkillsLimits(opts?.config),
  });

  // 5. 格式化
  const truncationNote = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}.`
    : "";
  const prompt = [truncationNote, formatSkillsForPrompt(compactSkillPaths(skillsForPrompt))]
    .filter(Boolean)
    .join("\n");

  return { eligible, prompt, resolvedSkills };
}
```

---

## 7. 命令注册与名称规范化

### 7.1 SkillCommandSpec 生成流程

```typescript
type SkillCommandSpec = {
  name: string;           // 规范化后的命令名（如 "github"）
  skillName: string;      // 原始 skill 名称
  description: string;    // ≤100 字符的描述
  dispatch?: {            // 可选：工具派发配置
    kind: "tool";
    toolName: string;
    argMode?: "raw";
  };
};

function buildSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: AppConfig;
    skillFilter?: string[];
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const eligible = filterSkillEntries(
    loadSkillEntries(workspaceDir, opts),
    opts?.config,
    opts?.skillFilter,
  );

  // 只处理 user-invocable 的 skill
  const userInvocable = eligible.filter(
    (entry) => entry.invocation?.userInvocable !== false,
  );

  const used = new Set<string>(opts?.reservedNames ?? []);
  const specs: SkillCommandSpec[] = [];

  for (const entry of userInvocable) {
    // 1. 名称规范化
    const base = sanitizeSkillCommandName(entry.skill.name);
    const unique = resolveUniqueSkillCommandName(base, used);
    used.add(unique.toLowerCase());

    // 2. 描述截断
    const rawDesc = entry.skill.description?.trim() || entry.skill.name;
    const description = rawDesc.length > 100
      ? rawDesc.slice(0, 99) + "…"
      : rawDesc;

    // 3. 解析 dispatch 配置
    const dispatch = resolveCommandDispatch(entry.frontmatter);

    specs.push({
      name: unique,
      skillName: entry.skill.name,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }

  return specs;
}
```

### 7.2 名称规范化

```typescript
const SKILL_COMMAND_MAX_LENGTH = 32;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")   // 非字母数字下划线 → 下划线
    .replace(/_+/g, "_")             // 合并连续下划线
    .replace(/^_+|_+$/g, "");        // 去掉首尾下划线

  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || "skill";         // 空字符串回退
}
```

**示例**：
- `"My Custom-Skill!"` → `"my_custom_skill"`
- `"@org/package"` → `"org_package"`
- `""` → `"skill"`

### 7.3 冲突处理

```typescript
function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) {
    return base;
  }

  // 尝试 base_2, base_3, ..., base_999
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // 极端回退
  return `${base.slice(0, SKILL_COMMAND_MAX_LENGTH - 2)}_x`;
}
```

**示例**：若已存在 `github`，后续同名 skill 命名为 `github_2`、`github_3`。

### 7.4 Tool Dispatch 配置解析

```typescript
function resolveCommandDispatch(
  frontmatter: ParsedSkillFrontmatter,
): SkillCommandSpec["dispatch"] | undefined {
  const kind = (frontmatter["command-dispatch"] ?? frontmatter["command_dispatch"] ?? "")
    .trim().toLowerCase();

  if (kind !== "tool") return undefined;

  const toolName = (frontmatter["command-tool"] ?? frontmatter["command_tool"] ?? "").trim();
  if (!toolName) return undefined;  // 缺少 toolName 视为无效

  return {
    kind: "tool",
    toolName,
    argMode: "raw",
  };
}
```

---

## 8. Skill 执行——双路径架构

### 8.1 命令解析

支持两种语法：
- **直接命令**：`/github create issue` → 命令名 `github`，参数 `create issue`
- **通用语法**：`/skill github create issue` → 命令名 `github`，参数 `create issue`

```typescript
function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string } | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;

  // 通用 /skill <name> <args> 语法
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;

    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;

    const command = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
    if (!command) return null;

    return { command, args: skillMatch[2]?.trim() || undefined };
  }

  // 直接 /commandName args 语法
  const command = params.skillCommands.find(
    (entry) => entry.name.toLowerCase() === commandName,
  );
  if (!command) return null;

  return { command, args: match[2]?.trim() || undefined };
}
```

### 8.2 命令查找（模糊匹配）

```typescript
function findSkillCommand(
  skillCommands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  const normalized = lowered.replace(/[\s_]+/g, "-");

  return skillCommands.find((entry) => {
    // 精确匹配
    if (entry.name.toLowerCase() === lowered) return true;
    if (entry.skillName.toLowerCase() === lowered) return true;
    // 规范化匹配（下划线/空格 → 连字符）
    if (entry.name.toLowerCase().replace(/[\s_]+/g, "-") === normalized) return true;
    if (entry.skillName.toLowerCase().replace(/[\s_]+/g, "-") === normalized) return true;
    return false;
  });
}
```

### 8.3 路径 A：工具派发（Tool Dispatch）

当 skill 配置了 `command-dispatch: tool` 时，**直接调用指定工具，绕过 LLM**：

```typescript
async function executeToolDispatch(params: {
  skillInvocation: { command: SkillCommandSpec; args?: string };
  availableTools: AgentTool[];
}): Promise<{ text: string }> {
  const { command, args } = params.skillInvocation;
  const dispatch = command.dispatch!;
  const rawArgs = (args ?? "").trim();

  // 查找目标工具
  const tool = params.availableTools.find((t) => t.name === dispatch.toolName);
  if (!tool) {
    return { text: `❌ Tool not available: ${dispatch.toolName}` };
  }

  // 生成唯一 tool call ID
  const toolCallId = `cmd_${generateSecureToken(8)}`;

  try {
    const result = await tool.execute(toolCallId, {
      command: rawArgs,
      commandName: command.name,
      skillName: command.skillName,
    });

    const text = extractTextFromToolResult(result) ?? "✅ Done.";
    return { text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `❌ ${message}` };
  }
}
```

**特点**：
- 零 LLM 调用，延迟最低
- 结果直接返回给用户
- 适合确定性操作（发送消息、查询状态等）

### 8.4 路径 B：提示词驱动（Prompt-Driven）

当 skill 没有配置 dispatch 时，将用户命令**改写为自然语言**，交给模型处理：

```typescript
function rewriteForPromptDriven(
  skillInvocation: { command: SkillCommandSpec; args?: string },
): string {
  const parts = [
    `Use the "${skillInvocation.command.skillName}" skill for this request.`,
    skillInvocation.args ? `User input:\n${skillInvocation.args}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  return parts.join("\n\n");
}

// 使用示例：
// 输入：/github create issue about bug
// 改写为：
//   Use the "github" skill for this request.
//
//   User input:
//   create issue about bug
```

模型收到改写后的输入后：
1. 扫描系统提示词中的 `<available_skills>` 列表
2. 找到匹配 skill 的 `<location>` 路径
3. 使用 `read` 工具读取 SKILL.md 完整内容
4. 遵循 SKILL.md 中的指令，使用可用工具执行任务

### 8.5 执行路径选择决策树

```
用户输入 /command args
  │
  ├─ 匹配到 skill？
  │   ├─ 否 → 作为普通消息处理
  │   └─ 是 → 检查 dispatch
  │       ├─ dispatch.kind === "tool"
  │       │   ├─ 工具存在 → 直接执行 → 返回结果
  │       │   └─ 工具不存在 → 返回错误 "❌ Tool not available"
  │       │
  │       └─ 无 dispatch
  │           └─ 改写消息 → 送入 LLM → 模型读取 SKILL.md → 执行
```

---

## 9. 环境变量注入与安全

### 9.1 注入流程

```
配置中的 skill 条目
  │
  ├─ skillConfig.env: { KEY: "value" }
  │   → 如果 process.env[KEY] 未设置，则注入
  │
  └─ skillConfig.apiKey + metadata.primaryEnv
      → 如果 primaryEnv 对应的环境变量未设置，则注入 apiKey
```

### 9.2 核心实现

```typescript
type EnvUpdate = { key: string; prev: string | undefined };

function applySkillEnvOverrides(params: {
  skills: SkillEntry[];
  config?: AppConfig;
}): () => void {
  const updates: EnvUpdate[] = [];

  for (const entry of params.skills) {
    const skillKey = entry.metadata?.skillKey ?? entry.skill.name;
    const skillConfig = resolveSkillConfig(params.config, skillKey);
    if (!skillConfig) continue;

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env,
      skillKey,
    });
  }

  // 返回清理函数
  return createEnvReverter(updates);
}

function applySkillConfigEnvOverrides(params: {
  updates: EnvUpdate[];
  skillConfig: SkillConfig;
  primaryEnv?: string | null;
  requiredEnv?: string[] | null;
  skillKey: string;
}) {
  const allowedSensitiveKeys = new Set<string>();

  // primaryEnv 和 requiredEnv 作为允许的敏感键
  const normalizedPrimaryEnv = params.primaryEnv?.trim();
  if (normalizedPrimaryEnv) {
    allowedSensitiveKeys.add(normalizedPrimaryEnv);
  }
  for (const envName of params.requiredEnv ?? []) {
    const trimmed = envName.trim();
    if (trimmed) allowedSensitiveKeys.add(trimmed);
  }

  const pendingOverrides: Record<string, string> = {};

  // 收集 skillConfig.env 中的变量（仅当未设置时）
  if (params.skillConfig.env) {
    for (const [rawKey, envValue] of Object.entries(params.skillConfig.env)) {
      const envKey = rawKey.trim();
      if (!envKey || !envValue || process.env[envKey]) continue;
      pendingOverrides[envKey] = envValue;
    }
  }

  // 注入 apiKey → primaryEnv
  if (normalizedPrimaryEnv && params.skillConfig.apiKey && !process.env[normalizedPrimaryEnv]) {
    if (!pendingOverrides[normalizedPrimaryEnv]) {
      pendingOverrides[normalizedPrimaryEnv] = params.skillConfig.apiKey;
    }
  }

  // 安全检查
  const sanitized = sanitizeSkillEnvOverrides({
    overrides: pendingOverrides,
    allowedSensitiveKeys,
  });

  // 应用到 process.env
  for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
    if (process.env[envKey]) continue;
    params.updates.push({ key: envKey, prev: process.env[envKey] });
    process.env[envKey] = envValue;
  }
}
```

### 9.3 安全卫生检查

```typescript
// 始终阻止的危险环境变量
const DANGEROUS_ENV_KEYS = new Set([
  "HOME", "PATH", "LD_LIBRARY_PATH", "LD_PRELOAD",
  "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS", "NODE_PATH",
]);

const BLOCKED_PATTERNS = [/^OPENSSL_CONF$/i];

function sanitizeSkillEnvOverrides(params: {
  overrides: Record<string, string>;
  allowedSensitiveKeys: Set<string>;
}): { allowed: Record<string, string>; blocked: string[]; warnings: string[] } {
  const allowed: Record<string, string> = {};
  const blocked: string[] = [];
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(params.overrides)) {
    // 阻止危险键
    if (DANGEROUS_ENV_KEYS.has(key) || BLOCKED_PATTERNS.some((p) => p.test(key))) {
      blocked.push(key);
      continue;
    }

    // 检查 null 字节
    if (value.includes("\0")) {
      blocked.push(key);
      continue;
    }

    // 敏感键（看起来像 token/key/secret 的）需要在允许列表中
    if (looksLikeSensitiveKey(key) && !params.allowedSensitiveKeys.has(key)) {
      blocked.push(key);
      continue;
    }

    allowed[key] = value;
  }

  return { allowed, blocked, warnings };
}
```

### 9.4 清理函数

确保 skill 执行结束后恢复原始环境：

```typescript
function createEnvReverter(updates: EnvUpdate[]): () => void {
  return () => {
    for (const update of updates) {
      if (update.prev === undefined) {
        delete process.env[update.key];   // 恢复为未设置
      } else {
        process.env[update.key] = update.prev;  // 恢复为原始值
      }
    }
  };
}

// 使用模式：
const revert = applySkillEnvOverrides({ skills, config });
try {
  await runAgentWithSkills();
} finally {
  revert();  // 无论成功失败，都恢复环境
}
```

---

## 10. SkillSnapshot 与缓存

### 10.1 SkillSnapshot 数据结构

```typescript
type SkillSnapshot = {
  prompt: string;    // 格式化后的 skills 提示词块
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
  }>;
  skillFilter?: string[];     // 构建此快照时使用的过滤器
  resolvedSkills?: Skill[];   // 已解析的 Skill 对象（可选，避免重复解析）
  version?: number;           // 版本号
};
```

### 10.2 快照构建

```typescript
function buildSkillSnapshot(
  workspaceDir: string,
  opts?: BuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);

  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),  // 防御性拷贝
    })),
    ...(opts?.skillFilter !== undefined ? { skillFilter: opts.skillFilter } : {}),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}
```

### 10.3 快照复用逻辑

```typescript
function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: AppConfig;
  workspaceDir: string;
}): string {
  // 优先使用快照中的 prompt
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }

  // 如果有预加载的 entries，基于它们构建
  if (params.entries && params.entries.length > 0) {
    return buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
  }

  return "";
}
```

### 10.4 从快照注入环境变量

不需要重新解析 frontmatter，直接使用快照中的元数据：

```typescript
function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: AppConfig;
}): () => void {
  if (!params.snapshot) return () => {};

  const updates: EnvUpdate[] = [];
  for (const skill of params.snapshot.skills) {
    const skillConfig = resolveSkillConfig(params.config, skill.name);
    if (!skillConfig) continue;

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: skill.primaryEnv,
      requiredEnv: skill.requiredEnv,
      skillKey: skill.name,
    });
  }

  return createEnvReverter(updates);
}
```

### 10.5 文件监听与版本递增

```typescript
import chokidar from "chokidar";

let snapshotVersion = 0;
const changeListeners: Set<() => void> = new Set();

function watchSkillDirectories(dirs: string[]) {
  const watcher = chokidar.watch(
    dirs.map((dir) => path.join(dir, "**", "SKILL.md")),
    {
      ignoreInitial: true,
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/.venv/**",
        "**/__pycache__/**",
      ],
    },
  );

  let debounceTimer: NodeJS.Timeout | undefined;

  const handleChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      snapshotVersion++;
      for (const listener of changeListeners) {
        listener();
      }
    }, 250);  // 250ms 防抖
  };

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", handleChange);

  return () => watcher.close();
}

function getSnapshotVersion(): number {
  return snapshotVersion;
}

function onSkillsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
```

### 10.6 版本对比与缓存失效

```typescript
function shouldRebuildSnapshot(
  cached: SkillSnapshot | undefined,
  currentVersion: number,
  nextFilter?: string[],
): boolean {
  if (!cached) return true;
  if (cached.version !== currentVersion) return true;

  // 过滤条件变化也需要重建
  const cachedFilter = normalizeSkillFilter(cached.skillFilter);
  const nextNormalized = normalizeSkillFilter(nextFilter);
  if (cachedFilter === undefined && nextNormalized === undefined) return false;
  if (cachedFilter === undefined || nextNormalized === undefined) return true;
  if (cachedFilter.length !== nextNormalized.length) return true;
  return !cachedFilter.every((entry, i) => entry === nextNormalized[i]);
}

function normalizeSkillFilter(filter?: string[]): string[] | undefined {
  if (filter === undefined) return undefined;
  const normalized = filter.map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}
```

---

## 11. 配置系统

### 11.1 完整配置类型

```typescript
// 全局 skill 配置
type SkillsConfig = {
  allowBundled?: string[];                  // 内置 skill 白名单
  load?: SkillsLoadConfig;                  // 加载配置
  install?: SkillsInstallConfig;            // 安装偏好
  limits?: SkillsLimitsConfig;              // 安全限制
  entries?: Record<string, SkillConfig>;    // 单 skill 配置
};

// 加载配置
type SkillsLoadConfig = {
  extraDirs?: string[];        // 额外 skill 目录
  watch?: boolean;             // 是否监听文件变更（默认 true）
  watchDebounceMs?: number;    // 防抖延迟（默认 250ms）
};

// 安装偏好
type SkillsInstallConfig = {
  preferBrew?: boolean;                                  // 优先使用 Homebrew
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";       // Node 包管理器
};

// 安全限制
type SkillsLimitsConfig = {
  maxCandidatesPerRoot?: number;       // 每个根目录最多扫描子目录数（默认 300）
  maxSkillsLoadedPerSource?: number;   // 每个源最多加载 skill 数（默认 200）
  maxSkillsInPrompt?: number;          // 系统提示词最多包含 skill 数（默认 150）
  maxSkillsPromptChars?: number;       // 系统提示词 skill 块最大字符数（默认 30,000）
  maxSkillFileBytes?: number;          // 单个 SKILL.md 最大字节数（默认 256KB）
};

// 单个 skill 配置
type SkillConfig = {
  enabled?: boolean;                   // 启用/禁用
  apiKey?: string;                     // API 密钥
  env?: Record<string, string>;        // 环境变量
  config?: Record<string, unknown>;    // 任意配置数据
};
```

### 11.2 配置示例

```json
{
  "skills": {
    "allowBundled": ["github", "1password", "tmux"],

    "load": {
      "extraDirs": ["~/my-skills", "/opt/shared-skills"],
      "watch": true,
      "watchDebounceMs": 300
    },

    "install": {
      "preferBrew": true,
      "nodeManager": "pnpm"
    },

    "limits": {
      "maxSkillsInPrompt": 100,
      "maxSkillsPromptChars": 20000
    },

    "entries": {
      "github": {
        "enabled": true,
        "apiKey": "ghp_xxxxxxxxxxxx",
        "env": {
          "GH_REPO": "myorg/myrepo"
        }
      },
      "slack": {
        "enabled": false
      },
      "custom-tool": {
        "apiKey": "sk-xxxxxxx",
        "config": {
          "model": "gpt-4",
          "temperature": 0.7
        }
      }
    }
  }
}
```

### 11.3 配置查找

```typescript
function resolveSkillConfig(
  config: AppConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const entries = config?.skills?.entries;
  if (!entries || typeof entries !== "object") return undefined;

  const entry = entries[skillKey];
  if (!entry || typeof entry !== "object") return undefined;

  return entry;
}

function resolveSkillsLimits(config?: AppConfig): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? 300,
    maxSkillsLoadedPerSource: limits?.maxSkillsLoadedPerSource ?? 200,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? 150,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? 30_000,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? 256_000,
  };
}
```

### 11.4 默认值汇总表

| 配置路径 | 默认值 | 说明 |
|----------|--------|------|
| `limits.maxCandidatesPerRoot` | 300 | 防止扫描巨大目录 |
| `limits.maxSkillsLoadedPerSource` | 200 | 防止内存溢出 |
| `limits.maxSkillsInPrompt` | 150 | token 预算 |
| `limits.maxSkillsPromptChars` | 30,000 | 字符预算 |
| `limits.maxSkillFileBytes` | 256,000 (256KB) | 防止加载巨大文件 |
| `load.watch` | true | 自动监听变更 |
| `load.watchDebounceMs` | 250 | 防抖延迟 |
| `install.preferBrew` | false | 安装偏好 |
| `install.nodeManager` | `"npm"` | 包管理器 |

---

## 12. 实现步骤指导

### 12.1 最小可行实现（MVP）

按以下顺序实现，每一步都可独立验证：

#### 步骤 1：定义核心类型

创建 `src/skills/types.ts`：

```typescript
export type Skill = {
  name: string;
  description?: string;
  filePath: string;
  baseDir: string;
  source: string;
};

export type ParsedSkillFrontmatter = Record<string, string>;

export type SkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
};

export type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: SkillMetadata;
  invocation?: SkillInvocationPolicy;
};

export type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string;
  dispatch?: { kind: "tool"; toolName: string; argMode?: "raw" };
};

export type SkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  skillFilter?: string[];
  version?: number;
};

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
};
```

#### 步骤 2：实现 SKILL.md 解析

创建 `src/skills/frontmatter.ts`，实现：
- `parseFrontmatterBlock(content)` — YAML + 行解析双策略
- `resolveSkillMetadata(frontmatter)` — 元数据提取
- `resolveSkillInvocationPolicy(frontmatter)` — 调用策略

参考 [2.5 Frontmatter 解析实现](#25-frontmatter-解析实现) 的完整代码。

#### 步骤 3：实现 Skill 发现与加载

创建 `src/skills/loader.ts`，实现：
- `listChildDirectories(dir)` — 安全目录列表
- `loadSkillsFromDir(params)` — 单目录加载
- `loadSkillEntries(workspaceDir, opts)` — 多源加载 + 合并

参考 [第 3 章](#3-多源优先级存储) 和 [第 4 章](#4-skill-发现与加载)。

MVP 阶段可简化为 2 层优先级：`bundled` + `workspace`。

#### 步骤 4：实现过滤与资格评估

创建 `src/skills/eligibility.ts`，实现：
- `hasBinary(bin)` — PATH 搜索 + 缓存
- `evaluateRuntimeEligibility(params)` — 完整资格评估
- `shouldIncludeSkill(params)` — 三级过滤
- `filterSkillEntries(entries, config, filter)` — 过滤入口

参考 [第 5 章](#5-skill-过滤与资格评估)。

#### 步骤 5：实现系统提示词注入

创建 `src/skills/prompt.ts`，实现：
- `formatSkillsForPrompt(skills)` — XML 格式化
- `applySkillsPromptLimits(params)` — 预算管控（二分搜索）
- `buildSkillsSection(params)` — 系统提示词段落

参考 [第 6 章](#6-系统提示词注入惰性加载)。

#### 步骤 6：实现命令注册

创建 `src/skills/commands.ts`，实现：
- `sanitizeSkillCommandName(raw)` — 名称规范化
- `resolveUniqueSkillCommandName(base, used)` — 冲突处理
- `buildSkillCommandSpecs(workspaceDir, opts)` — 命令规格生成

参考 [第 7 章](#7-命令注册与名称规范化)。

#### 步骤 7：实现执行路径

创建 `src/skills/executor.ts`，实现：
- `resolveSkillCommandInvocation(params)` — 命令解析
- `executeToolDispatch(params)` — 工具派发路径
- `rewriteForPromptDriven(invocation)` — 提示词驱动改写

参考 [第 8 章](#8-skill-执行双路径架构)。

#### 步骤 8：实现环境注入

创建 `src/skills/env-overrides.ts`，实现：
- `applySkillEnvOverrides(params)` — 注入 + 返回清理函数
- `sanitizeSkillEnvOverrides(params)` — 安全检查
- `createEnvReverter(updates)` — 环境恢复

参考 [第 9 章](#9-环境变量注入与安全)。

#### 步骤 9（可选）：实现快照与缓存

创建 `src/skills/snapshot.ts`，实现：
- `buildSkillSnapshot(workspaceDir, opts)` — 快照构建
- `watchSkillDirectories(dirs)` — 文件监听
- `shouldRebuildSnapshot(cached, version)` — 缓存失效

参考 [第 10 章](#10-skillsnapshot-与缓存)。

### 12.2 核心依赖

| 依赖 | 用途 | 是否必须 |
|------|------|:--------:|
| `yaml` | YAML frontmatter 解析 | 是 |
| `chokidar` | 文件变更监听 | 否（快照缓存功能需要） |

### 12.3 文件结构建议

```
src/skills/
├── types.ts              # 类型定义
├── frontmatter.ts        # SKILL.md 解析
├── loader.ts             # 发现与加载
├── eligibility.ts        # 过滤与资格评估
├── prompt.ts             # 系统提示词注入
├── commands.ts           # 命令注册
├── executor.ts           # 执行路径
├── env-overrides.ts      # 环境变量注入
├── snapshot.ts           # 快照与缓存
└── config.ts             # 配置查找
```

### 12.4 扩展点规划

| 扩展点 | 说明 |
|--------|------|
| 多源优先级 | 按需增加更多 skill 来源（插件系统、远程仓库） |
| 安装自动化 | 基于 `install` 元数据实现 skill 依赖自动安装 |
| 远程资格检查 | 支持检查远程服务器上的二进制/环境是否满足 |
| CLI 工具 | `skills list/info/check` 命令用于审计和调试 |
| 权限系统 | 细粒度控制哪些用户可以调用哪些 skill |
| skill 模板 | 提供 `skill init` 命令快速创建新 skill |

---

## 附录：核心数据结构总览

```typescript
// ─── 基础类型 ───────────────────────────────────────

type Skill = {
  name: string;
  description?: string;
  filePath: string;
  baseDir: string;
  source: string;
};

type ParsedSkillFrontmatter = Record<string, string>;

// ─── 元数据 ─────────────────────────────────────────

type SkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: RuntimeRequires;
  install?: SkillInstallSpec[];
};

type RuntimeRequires = {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
};

type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  url?: string;
};

// ─── 策略 ───────────────────────────────────────────

type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

type SkillCommandDispatchSpec = {
  kind: "tool";
  toolName: string;
  argMode?: "raw";
};

// ─── 组合类型 ───────────────────────────────────────

type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: SkillMetadata;
  invocation?: SkillInvocationPolicy;
};

type SkillCommandSpec = {
  name: string;
  skillName: string;
  description: string;
  dispatch?: SkillCommandDispatchSpec;
};

type SkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};

// ─── 配置类型 ───────────────────────────────────────

type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

type SkillsConfig = {
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  entries?: Record<string, SkillConfig>;
};

type SkillsLoadConfig = {
  extraDirs?: string[];
  watch?: boolean;
  watchDebounceMs?: number;
};

type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

type SkillsLimitsConfig = {
  maxCandidatesPerRoot?: number;
  maxSkillsLoadedPerSource?: number;
  maxSkillsInPrompt?: number;
  maxSkillsPromptChars?: number;
  maxSkillFileBytes?: number;
};
```
