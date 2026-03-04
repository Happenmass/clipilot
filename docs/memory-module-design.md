# AI Agent 记忆模块设计与实现指导

> 基于 OpenClaw 项目记忆架构分析，结合分类功能设计，面向 TypeScript + SQLite 技术栈的可移植实现方案。

---

## 目录

1. [架构概览](#1-架构概览)
2. [存储层设计](#2-存储层设计)
3. [索引层设计](#3-索引层设计)
4. [搜索层设计](#4-搜索层设计)
5. [记忆分类设计](#5-记忆分类设计)
6. [写入层设计](#6-写入层设计)
7. [注入层设计](#7-注入层设计)
8. [上下文压缩与记忆持久化](#8-上下文压缩与记忆持久化)
9. [实现步骤指导](#9-实现步骤指导)
10. [嵌入提供商设计](#10-嵌入提供商设计)

---

## 1. 架构概览

### 1.1 分层架构

记忆模块采用六层架构，每层职责清晰、可独立替换：

```
┌─────────────────────────────────────────────────────┐
│                  Agent 交互层                         │
│  memory_search / memory_get / memory_write 工具       │
├─────────────────────────────────────────────────────┤
│                  注入层（Injection）                   │
│  静态注入（系统提示词 contextFile）                      │
│  动态检索（工具调用 → 搜索 → 返回结果）                   │
├─────────────────────────────────────────────────────┤
│                  搜索层（Search）                      │
│  向量搜索（KNN）+ 关键词搜索（FTS5 BM25）                │
│  混合结果合并 → 时间衰减 → MMR 多样性 → 过滤             │
├─────────────────────────────────────────────────────┤
│                  分类层（Classification）              │
│  路径 → 分类映射 / 分类 → SQL 过滤 / 生命周期策略         │
├─────────────────────────────────────────────────────┤
│                  索引层（Indexing）                    │
│  Markdown 分块 → 向量嵌入 → FTS 索引 → 增量同步          │
├─────────────────────────────────────────────────────┤
│                  存储层（Storage）                     │
│  Markdown 源文件（真相源）+ SQLite 数据库（搜索索引）       │
└─────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

1. **Markdown 文件是真相源（Source of Truth）**：SQLite 数据库仅作为搜索索引，可随时从源文件重建
2. **混合搜索**：向量语义搜索 + 关键词精确搜索并行执行，加权合并
3. **文件路径即分类**：通过文件路径约定推断记忆类别，零额外元数据
4. **两层注入**：静态注入保证核心记忆始终在上下文中；动态检索按需获取详细信息
5. **渐进衰减**：日期相关记忆随时间衰减，核心知识常青不衰

### 1.3 数据流

```
写入流：LLM → memory_write 工具 → 写入 memory/*.md → 触发索引同步 → 更新 SQLite

检索流：LLM → memory_search 工具 → 并行搜索（向量 + 关键词）
        → 合并去重 → 时间衰减 → MMR 重排 → 返回 Top-K 结果
        → LLM → memory_get 工具 → 直接读取 .md 文件指定行 → 返回原文
```

---

## 2. 存储层设计

### 2.1 双存储架构

记忆模块使用**双存储架构**：

| 存储 | 角色 | 格式 | 位置 |
|------|------|------|------|
| Markdown 文件 | 真相源 | `.md` 纯文本 | `workspace/memory/*.md` |
| SQLite 数据库 | 搜索索引 | `.sqlite` | `~/.app/state/memory/<agentId>.sqlite` |

**为什么选择这种架构？**
- Markdown 文件**人类可读、可编辑**，LLM 可以直接追加写入
- SQLite 数据库**高效搜索**，支持向量 KNN 和全文索引
- 两者解耦：删除数据库后可从文件重建索引，不丢失任何记忆

### 2.2 Markdown 源文件

记忆源文件存储在工作区目录下：

```
workspace/
├── MEMORY.md              # 核心记忆（legacy，向后兼容）
├── memory.md              # 核心记忆（legacy 别名）
└── memory/
    ├── core.md            # 架构决策、项目规则
    ├── preferences.md     # 用户偏好
    ├── people.md          # 联系人、角色
    ├── todos.md           # 活跃任务
    ├── 2024-01-15.md      # 日期日志（时间衰减）
    ├── 2024-01-16.md
    └── <custom-topic>.md  # 自定义主题文件
```

每个文件都是标准 Markdown 格式，LLM 通过 `memory_write` 工具直接以 `fs.writeFile` / `fs.appendFile` 写入。

### 2.3 SQLite 数据库 Schema

数据库包含 6 张表：

```sql
-- 1. 元信息表：记录索引配置（模型、分块参数等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 2. 文件表：跟踪已索引文件的状态（用于增量同步）
CREATE TABLE IF NOT EXISTS files (
  path   TEXT PRIMARY KEY,          -- 相对路径，如 "memory/core.md"
  source TEXT NOT NULL DEFAULT 'memory',  -- 来源：'memory' 或 'sessions'
  hash   TEXT NOT NULL,             -- 文件内容 SHA-256 哈希
  mtime  INTEGER NOT NULL,          -- 修改时间戳（毫秒）
  size   INTEGER NOT NULL           -- 文件大小（字节）
);

-- 3. 分块表：存储文本分块及其嵌入向量
CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,      -- 唯一标识（UUID）
  path       TEXT NOT NULL,         -- 所属文件路径
  source     TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,      -- 分块起始行（1-indexed）
  end_line   INTEGER NOT NULL,      -- 分块结束行（1-indexed）
  hash       TEXT NOT NULL,         -- 分块文本哈希
  model      TEXT NOT NULL,         -- 嵌入模型标识
  text       TEXT NOT NULL,         -- 分块原始文本
  embedding  TEXT NOT NULL,         -- 嵌入向量 JSON 数组
  updated_at INTEGER NOT NULL       -- 更新时间戳
);

-- 分块索引
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

-- 4. 向量搜索虚拟表（sqlite-vec 扩展）
-- 注意：需要加载 sqlite-vec 扩展后才能创建
-- 维度在运行时根据嵌入模型动态确定
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[<dims>]           -- dims 由嵌入模型决定，如 1536
);

-- 5. 全文搜索虚拟表（FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,                             -- 可搜索的文本内容
  id UNINDEXED,                     -- 关联 chunk ID（不索引）
  path UNINDEXED,                   -- 文件路径（不索引）
  source UNINDEXED,                 -- 来源（不索引）
  model UNINDEXED,                  -- 模型标识（不索引）
  start_line UNINDEXED,             -- 起始行（不索引）
  end_line UNINDEXED                -- 结束行（不索引）
);

-- 6. 嵌入缓存表：避免重复计算相同文本的嵌入
CREATE TABLE IF NOT EXISTS embedding_cache (
  provider     TEXT NOT NULL,       -- 嵌入提供商
  model        TEXT NOT NULL,       -- 模型名
  provider_key TEXT NOT NULL,       -- API Key 标识
  hash         TEXT NOT NULL,       -- 文本内容哈希
  embedding    TEXT NOT NULL,       -- 缓存的嵌入向量
  dims         INTEGER,             -- 向量维度
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);
CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at
  ON embedding_cache(updated_at);
```

### 2.4 表间关系

```
files.path ──1:N──> chunks.path     文件包含多个分块
chunks.id  ──1:1──> chunks_vec.id   分块对应一条向量记录
chunks.id  ──1:1──> chunks_fts.id   分块对应一条 FTS 记录
```

**关键点**：`chunks` 表同时存储了文本和嵌入向量（`embedding` 列），这是**后备搜索路径**——当 sqlite-vec 扩展不可用时，可以加载全部向量到内存进行暴力余弦相似度搜索。

---

## 3. 索引层设计

### 3.1 Markdown 分块算法

分块是将长文本切分为适合嵌入和搜索的小片段的过程。核心参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `tokens` | 400 | 每块最大 token 数 |
| `overlap` | 80 | 相邻块重叠的 token 数 |

**token 到字符的近似转换**：`maxChars = tokens * 4`（英文约 4 字符/token）

**分块算法核心逻辑**（`chunkMarkdown`）：

```typescript
function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number }
): MemoryChunk[] {
  const lines = content.split("\n");
  const maxChars = Math.max(32, chunking.tokens * 4);  // 400 * 4 = 1600 字符
  const overlapChars = Math.max(0, chunking.overlap * 4); // 80 * 4 = 320 字符
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  // flush：将当前累积的行生成一个 chunk
  const flush = () => {
    if (current.length === 0) return;
    const text = current.map(e => e.line).join("\n");
    chunks.push({
      startLine: current[0].lineNo,  // 1-indexed 行号
      endLine: current[current.length - 1].lineNo,
      text,
      hash: sha256(text),
    });
  };

  // carryOverlap：保留尾部若干行作为下一个 chunk 的开头（重叠区）
  const carryOverlap = () => {
    if (overlapChars <= 0) { current = []; currentChars = 0; return; }
    let acc = 0;
    const kept = [];
    // 从后往前累积，直到达到 overlapChars
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i].line.length + 1;
      kept.unshift(current[i]);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;  // 1-indexed
    const lineSize = line.length + 1;

    // 超过 maxChars 时，先 flush 当前 chunk，再 carry overlap
    if (currentChars + lineSize > maxChars && current.length > 0) {
      flush();
      carryOverlap();
    }
    current.push({ line, lineNo });
    currentChars += lineSize;
  }
  flush();
  return chunks;
}
```

**分块结果示例**：

```
文件 memory/core.md（30 行，2000 字符）：
  Chunk 0: startLine=1,  endLine=12, text="## 项目规则\n..."
  Chunk 1: startLine=9,  endLine=22, text="..重叠区..\n## 编码规范\n..."
  Chunk 2: startLine=18, endLine=30, text="..重叠区..\n## 部署流程\n..."
```

**重叠的作用**：确保跨越分块边界的信息不会丢失。Chunk 1 的前几行与 Chunk 0 的后几行相同。

### 3.2 向量嵌入生成

每个 chunk 的文本通过嵌入模型（如 OpenAI `text-embedding-3-small`）转换为数值向量：

```typescript
// 嵌入生成（伪代码）
async function embedText(text: string): Promise<number[]> {
  // 先检查缓存
  const hash = sha256(text);
  const cached = db.prepare(
    `SELECT embedding FROM embedding_cache
     WHERE provider = ? AND model = ? AND hash = ?`
  ).get(provider, model, hash);

  if (cached) {
    return JSON.parse(cached.embedding);
  }

  // 调用嵌入 API
  const response = await embeddingClient.embed({ input: text });
  const embedding = response.data[0].embedding;  // number[]

  // 写入缓存
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache
     (provider, model, provider_key, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(provider, model, providerKey, hash, JSON.stringify(embedding),
        embedding.length, Date.now());

  return embedding;
}
```

**嵌入缓存的价值**：避免对相同文本重复调用 API（节省成本和时间）。当文件内容未变化（hash 相同），直接使用缓存的嵌入。

### 3.3 索引写入

每个 chunk 同时写入三张表：

```typescript
// 写入 chunks 表
db.prepare(
  `INSERT OR REPLACE INTO chunks
   (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(chunkId, filePath, 'memory', chunk.startLine, chunk.endLine,
      chunk.hash, modelName, chunk.text, JSON.stringify(embedding), Date.now());

// 写入 chunks_vec 表（向量搜索）
db.prepare(
  `INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)`
).run(chunkId, vectorToBlob(embedding));
// vectorToBlob: Float32Array → Buffer

// 写入 chunks_fts 表（全文搜索）
db.prepare(
  `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(chunk.text, chunkId, filePath, 'memory', modelName,
      chunk.startLine, chunk.endLine);
```

### 3.4 增量同步策略

索引不需要每次全量重建。通过文件 hash 变更检测实现增量同步：

```typescript
async function syncMemoryFiles() {
  // 1. 扫描工作区中的所有 memory 文件
  const currentFiles = await listMemoryFiles(workspaceDir);

  for (const absPath of currentFiles) {
    const entry = await buildFileEntry(absPath, workspaceDir);
    // entry.hash = sha256(文件内容)

    // 2. 检查数据库中是否有该文件的记录
    const existing = db.prepare(
      `SELECT hash FROM files WHERE path = ?`
    ).get(entry.path);

    if (existing && existing.hash === entry.hash) {
      continue;  // 文件未变化，跳过
    }

    // 3. 文件变化或新文件 → 重新分块 + 嵌入 + 索引
    const content = await fs.readFile(absPath, 'utf-8');
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 80 });

    // 4. 删除该文件的旧 chunks
    db.prepare(`DELETE FROM chunks WHERE path = ?`).run(entry.path);
    db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(entry.path);
    // chunks_vec 中的旧记录也需清理

    // 5. 写入新 chunks
    for (const chunk of chunks) {
      const embedding = await embedText(chunk.text);
      // ... 写入三张表 ...
    }

    // 6. 更新 files 表记录
    db.prepare(
      `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
       VALUES (?, 'memory', ?, ?, ?)`
    ).run(entry.path, entry.hash, entry.mtimeMs, entry.size);
  }

  // 7. 处理已删除的文件
  const dbFiles = db.prepare(`SELECT path FROM files WHERE source = 'memory'`).all();
  const currentSet = new Set(currentFiles.map(f => path.relative(workspaceDir, f)));
  for (const row of dbFiles) {
    if (!currentSet.has(row.path)) {
      db.prepare(`DELETE FROM files WHERE path = ?`).run(row.path);
      db.prepare(`DELETE FROM chunks WHERE path = ?`).run(row.path);
      // ... 同步清理 chunks_vec 和 chunks_fts ...
    }
  }
}
```

**同步触发时机**：
- 文件系统监控（chokidar watcher）检测到 `memory/` 目录变化
- 搜索请求到来时检查 dirty 标志
- 定时轮询（可选）

---

## 4. 搜索层设计

### 4.1 混合搜索架构

搜索层的核心是**双路并行搜索 + 加权合并**：

```
            用户查询
               │
        ┌──────┴──────┐
        ▼              ▼
  ┌──────────┐  ┌──────────┐
  │ 向量搜索  │  │ 关键词搜索│
  │ (KNN)    │  │ (FTS5)   │
  │ 权重 0.7  │  │ 权重 0.3  │
  └────┬─────┘  └────┬─────┘
       │              │
       └──────┬───────┘
              ▼
       ┌─────────────┐
       │ 合并去重      │
       │ (按 chunk ID) │
       └──────┬──────┘
              ▼
       ┌─────────────┐
       │ 时间衰减      │
       │ (指数衰减)    │
       └──────┬──────┘
              ▼
       ┌─────────────┐
       │ MMR 多样性    │
       │ 重排（可选）   │
       └──────┬──────┘
              ▼
       ┌─────────────┐
       │ 最低分过滤    │
       │ Top-K 截断   │
       └──────┬──────┘
              ▼
         搜索结果
```

### 4.2 向量搜索（sqlite-vec KNN）

向量搜索将查询文本转换为嵌入向量，在 `chunks_vec` 表中执行 KNN（K-最近邻）搜索：

```sql
-- sqlite-vec 向量搜索 SQL
SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
       vec_distance_cosine(v.embedding, ?) AS dist
  FROM chunks_vec v
  JOIN chunks c ON c.id = v.id
 WHERE c.model = ?
   AND c.source IN ('memory')        -- 来源过滤
 ORDER BY dist ASC                   -- 距离越小越相似
 LIMIT ?                             -- 候选数量
```

**评分转换**：`vectorScore = 1 - dist`（余弦距离转为相似度，0~1）

**后备路径**（sqlite-vec 不可用时）：
```typescript
// 加载全部 chunks 到内存，暴力计算余弦相似度
const candidates = db.prepare(
  `SELECT id, path, start_line, end_line, text, embedding, source
     FROM chunks WHERE model = ?`
).all(providerModel);

const scored = candidates.map(chunk => ({
  chunk,
  score: cosineSimilarity(queryVec, JSON.parse(chunk.embedding))
}));
return scored.sort((a, b) => b.score - a.score).slice(0, limit);
```

### 4.3 关键词搜索（FTS5 BM25）

FTS5 使用倒排索引实现高效的关键词匹配，BM25 算法计算相关度排名：

```sql
-- FTS5 关键词搜索 SQL
SELECT id, path, source, start_line, end_line, text,
       bm25(chunks_fts) AS rank        -- BM25 排名值
  FROM chunks_fts
 WHERE chunks_fts MATCH ?              -- FTS5 查询语法
   AND model = ?
   AND source IN ('memory')
 ORDER BY rank ASC                     -- rank 越小越相关
 LIMIT ?
```

**FTS 查询构建**：将自然语言查询转为 FTS5 MATCH 语法：

```typescript
function buildFtsQuery(raw: string): string | null {
  // 提取所有单词 token（Unicode 字母/数字/下划线）
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)
    ?.map(t => t.trim())
    .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;

  // 每个 token 用双引号包裹，用 AND 连接
  // "deploy" AND "staging" AND "config"
  return tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' AND ');
}
```

**BM25 rank 到 score 的转换**：

```typescript
function bm25RankToScore(rank: number): number {
  // rank 是 BM25 的原始值（越小越相关），转换为 0~1 的评分
  const normalized = Math.max(0, rank);
  return 1 / (1 + normalized);
}
```

### 4.4 结果合并算法

两路搜索结果**按 chunk ID 合并**，同一个 chunk 可能同时被两路命中：

```typescript
async function mergeHybridResults(params: {
  vector: HybridVectorResult[];    // 向量搜索结果
  keyword: HybridKeywordResult[];  // 关键词搜索结果
  vectorWeight: number;            // 默认 0.7
  textWeight: number;              // 默认 0.3
}): Promise<MergedResult[]> {

  // 第一步：以 chunk ID 为 key 合并到 Map
  const byId = new Map<string, MergedEntry>();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine, endLine: r.endLine,
      source: r.source, snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,             // 关键词搜索未命中时默认为 0
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      // 同一 chunk 被两路都命中 → 更新 textScore
      existing.textScore = r.textScore;
    } else {
      // 仅关键词搜索命中 → vectorScore 为 0
      byId.set(r.id, {
        ...r, vectorScore: 0, textScore: r.textScore,
      });
    }
  }

  // 第二步：计算加权评分
  const merged = Array.from(byId.values()).map(entry => ({
    path: entry.path,
    startLine: entry.startLine, endLine: entry.endLine,
    // 核心公式：0.7 * vectorScore + 0.3 * textScore
    score: params.vectorWeight * entry.vectorScore
         + params.textWeight * entry.textScore,
    snippet: entry.snippet,
    source: entry.source,
  }));

  // 第三步：后处理（时间衰减 → 排序 → MMR）
  const decayed = await applyTemporalDecay(merged);
  const sorted = decayed.sort((a, b) => b.score - a.score);

  return sorted;
}
```

**合并策略要点**：
- 两路搜索查询的是**同一张 chunks 表**，因此 chunk ID 是全局唯一的
- 仅被一路命中的 chunk，另一路的分数按 0 处理
- 被两路同时命中的 chunk 得分更高（向量语义匹配 + 关键词精确匹配）

### 4.5 时间衰减

对日期命名的记忆文件应用指数衰减，使近期记忆得分更高：

```typescript
// 衰减公式：score * exp(-λ * ageInDays)
// 其中 λ = ln(2) / halfLifeDays

function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;  // 默认 30 天
}): number {
  const lambda = Math.LN2 / params.halfLifeDays;
  return Math.exp(-lambda * Math.max(0, params.ageInDays));
}

// 示例：halfLifeDays = 30
// 0 天前：multiplier = 1.0（不衰减）
// 30 天前：multiplier = 0.5
// 60 天前：multiplier = 0.25
// 90 天前：multiplier = 0.125
```

**日期提取**：从文件路径中解析日期（`memory/2024-01-15.md` → `2024-01-15`）

```typescript
const DATED_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;

function extractDateFromPath(filePath: string): Date | null {
  const match = DATED_RE.exec(filePath);
  if (!match) return null;
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
}
```

**常青文件不衰减**：非日期命名的文件（`core.md`、`preferences.md` 等）返回 `null` 日期，衰减乘数为 1.0。

### 4.6 MMR 多样性重排（可选）

MMR（Maximal Marginal Relevance）避免返回内容高度重复的结果：

```
MMR(d) = λ * Relevance(d) - (1-λ) * max_selected(Similarity(d, d_selected))
```

即在选择下一个结果时，同时考虑**与查询的相关性**和**与已选结果的差异性**。

---

## 5. 记忆分类设计

### 5.1 分类体系

采用**基于文件路径的隐式分类**，不引入额外元数据或数据库字段：

| 分类 | 文件路径模式 | 生命周期 | 用途 |
|------|-------------|----------|------|
| `core` | `memory/core.md` | 常青 | 架构决策、编码规范、项目规则 |
| `preferences` | `memory/preferences.md` | 常青 | 用户偏好、风格偏好 |
| `people` | `memory/people.md` | 常青 | 联系人、团队成员、角色 |
| `todos` | `memory/todos.md` | 常青 | 活跃 TODO 和任务 |
| `daily` | `memory/YYYY-MM-DD.md` | 时间衰减 | 每日会话日志、临时事件 |
| `legacy` | `MEMORY.md` / `memory.md` | 常青 | 向后兼容的旧格式 |
| `topic` | `memory/<other>.md` | 常青 | 自定义主题文件 |

### 5.2 路径 → 分类映射

```typescript
type MemoryCategory =
  | "core" | "preferences" | "people" | "todos"
  | "daily" | "legacy" | "topic";

const CATEGORY_FILES: Record<string, MemoryCategory> = {
  "core.md": "core",
  "preferences.md": "preferences",
  "people.md": "people",
  "todos.md": "todos",
};

const DATED_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const LEGACY_RE = /^(MEMORY\.md|memory\.md)$/;

function categoryFromPath(relPath: string): MemoryCategory {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

  if (LEGACY_RE.test(normalized)) return "legacy";
  if (DATED_RE.test(normalized)) return "daily";

  if (normalized.startsWith("memory/")) {
    const basename = normalized.slice("memory/".length);
    if (!basename.includes("/") && CATEGORY_FILES[basename]) {
      return CATEGORY_FILES[basename];
    }
    return "topic";
  }
  return "topic";
}

function isEvergreenCategory(category: MemoryCategory): boolean {
  return category !== "daily";  // 仅 daily 类型有时间衰减
}
```

### 5.3 分类 → SQL 过滤

在搜索时，可选地按分类过滤结果：

```typescript
function buildCategoryPathFilter(
  categories: MemoryCategory[],
  alias?: string
): { sql: string; params: string[] } {
  if (categories.length === 0) return { sql: "", params: [] };

  const col = alias ? `${alias}.path` : "path";
  const clauses: string[] = [];
  const params: string[] = [];

  for (const cat of categories) {
    switch (cat) {
      case "core":
        clauses.push(`${col} = ?`);
        params.push("memory/core.md");
        break;
      case "preferences":
        clauses.push(`${col} = ?`);
        params.push("memory/preferences.md");
        break;
      case "people":
        clauses.push(`${col} = ?`);
        params.push("memory/people.md");
        break;
      case "todos":
        clauses.push(`${col} = ?`);
        params.push("memory/todos.md");
        break;
      case "daily":
        // GLOB 模式匹配日期文件
        clauses.push(`${col} GLOB ?`);
        params.push("memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md");
        break;
      case "legacy":
        clauses.push(`(${col} = ? OR ${col} = ?)`);
        params.push("MEMORY.md", "memory.md");
        break;
      case "topic":
        // memory/ 下非日期、非已知分类的文件
        clauses.push(
          `(${col} LIKE ? AND ${col} NOT GLOB ?
            AND ${col} NOT IN (?, ?, ?, ?))`
        );
        params.push(
          "memory/%",
          "memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md",
          "memory/core.md", "memory/preferences.md",
          "memory/people.md", "memory/todos.md"
        );
        break;
    }
  }

  return {
    sql: ` AND (${clauses.join(" OR ")})`,
    params,
  };
}
```

**与搜索层集成**：

```typescript
// 在 search() 方法中，将分类过滤追加到 sourceFilter 之后
async search(query: string, opts?: { category?: string }) {
  const sourceFilter = this.buildSourceFilter("c");  // 现有来源过滤

  // 追加分类过滤
  let categoryFilterSql = "";
  let categoryFilterParams: string[] = [];
  if (opts?.category) {
    const filter = buildCategoryPathFilter(
      [opts.category as MemoryCategory], "c"
    );
    categoryFilterSql = filter.sql;
    categoryFilterParams = filter.params;
  }

  // 合并过滤条件传入向量搜索和关键词搜索
  const combinedFilter = {
    sql: sourceFilter.sql + categoryFilterSql,
    params: [...sourceFilter.params, ...categoryFilterParams],
  };

  // ... 传递 combinedFilter 到 searchVector / searchKeyword ...
}
```

### 5.4 生命周期策略

| 分类 | 衰减行为 | 策略 |
|------|---------|------|
| `core` | 不衰减 | 常青知识，始终最高优先级 |
| `preferences` | 不衰减 | 用户偏好长期稳定 |
| `people` | 不衰减 | 联系人信息持久化 |
| `todos` | 不衰减 | 由 LLM 主动管理（完成的 TODO 被替换） |
| `daily` | 指数衰减 | 30 天半衰期，旧日志逐渐降低优先级 |
| `legacy` | 不衰减 | 向后兼容 |
| `topic` | 不衰减 | 自定义主题默认常青 |

---

## 6. 写入层设计

### 6.1 Memory Flush 机制

Memory Flush 是记忆持久化的核心机制——在会话即将被压缩（compaction）之前，触发一个专门的 LLM 回合，将对话中的重要信息写入磁盘。

**触发条件**：

```typescript
function shouldRunMemoryFlush(params: {
  totalTokens: number;         // 当前会话总 token 数
  contextWindowTokens: number; // 模型上下文窗口大小
  reserveTokensFloor: number;  // 压缩保留 token 数
  softThresholdTokens: number; // 提前触发的软阈值（默认 4000）
  lastFlushCompactionCount: number; // 上次 flush 时的压缩计数
  currentCompactionCount: number;   // 当前压缩计数
}): boolean {
  // 计算触发阈值
  const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;

  // 当前 token 数超过阈值
  if (totalTokens < threshold) return false;

  // 避免同一轮压缩重复 flush
  if (lastFlushCompactionCount === currentCompactionCount) return false;

  return true;
}
```

**流程**：

```
会话运行中 → 检测到接近上下文限制
    │
    ▼
shouldRunMemoryFlush() === true
    │
    ▼
创建临时嵌入式 Agent（带 memory_write 工具）
    │
    ▼
注入 Memory Flush 提示词
    │
    ▼
LLM 决定要保存什么 → 调用 memory_write 写入分类文件
    │
    ▼
正常的会话压缩继续执行
```

### 6.2 分类引导提示词

**Memory Flush Prompt**（引导 LLM 按分类写入）：

```
Pre-compaction memory flush.
Store durable memories now. Route content to the appropriate file by type:
- memory/core.md — architecture decisions, coding conventions, project rules
- memory/preferences.md — user preferences, communication style, tool preferences
- memory/people.md — contacts, team members, roles, relationships
- memory/todos.md — active TODOs, tasks, action items (replace completed items)
- memory/YYYY-MM-DD.md — daily session events, conversations, ephemeral notes
Create memory/ dir and files as needed. APPEND to existing files; do not overwrite.
For todos.md: replace completed items rather than appending indefinitely.
If nothing to store, reply with <silent>.
Current time: 2024-01-15T14:30:00+08:00
```

**System Prompt**（flush 专用）：

```
Pre-compaction memory flush turn.
The session is near auto-compaction; capture durable memories to disk.
Route each piece of information to its appropriate category file under memory/.
Prefer specific category files (core, preferences, people, todos) over daily logs.
Only use memory/YYYY-MM-DD.md for ephemeral, date-specific events.
You may reply, but usually <silent> is correct.
```

### 6.3 memory_write 工具实现

```typescript
const MemoryWriteSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "相对路径，如 memory/core.md" },
    content: { type: "string", description: "要写入的 Markdown 内容" },
  },
  required: ["path", "content"],
};

async function executeMemoryWrite(params: { path: string; content: string }) {
  const relPath = params.path.trim();

  // 安全校验：只允许写入 memory/ 目录或 MEMORY.md
  if (!isMemoryPath(relPath)) {
    throw new Error("只能写入 memory/ 目录下的 .md 文件");
  }

  const absPath = path.resolve(workspaceDir, relPath);

  // 确保目录存在
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  // 写入文件（追加模式）
  if (await fileExists(absPath)) {
    const existing = await fs.readFile(absPath, 'utf-8');
    if (!existing.endsWith('\n')) {
      await fs.appendFile(absPath, '\n');
    }
    await fs.appendFile(absPath, params.content);
  } else {
    await fs.writeFile(absPath, params.content, 'utf-8');
  }

  // 标记索引需要同步
  markDirty();

  return { success: true, path: relPath };
}
```

---

## 7. 注入层设计

### 7.1 两层注入架构

记忆通过两个层次注入到 Agent 的上下文中：

| 层次 | 机制 | 时机 | 内容 |
|------|------|------|------|
| **静态注入** | contextFile | 会话创建时 | MEMORY.md 全文 |
| **动态检索** | 工具调用 | 对话进行中 | 搜索结果片段 |

### 7.2 静态注入：contextFile

在 Agent 会话启动时，将 `MEMORY.md`（或 `memory.md`）的全文作为系统提示词的一部分注入：

```typescript
// 加载 bootstrap 文件（包含 MEMORY.md）
async function resolveBootstrapContextFiles(workspaceDir: string) {
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altFile = path.join(workspaceDir, "memory.md");

  const contextFiles: EmbeddedContextFile[] = [];

  for (const filePath of [memoryFile, altFile]) {
    if (await fileExists(filePath)) {
      const content = await fs.readFile(filePath, 'utf-8');
      const truncated = content.length > maxChars
        ? content.slice(0, maxChars) + "\n...[truncated]"
        : content;
      contextFiles.push({
        path: path.relative(workspaceDir, filePath),
        content: truncated,
      });
      break;  // 只加载一个
    }
  }

  return contextFiles;
}
```

**注入到系统提示词的格式**：

```
<context_file path="MEMORY.md">
# 项目核心知识

## 架构决策
- 使用 microservices 架构
- 数据库选择 PostgreSQL
...
</context_file>
```

**限制**：contextFile 有字符上限（如 10000 字符），超长内容会被截断。这就是为什么需要第二层动态检索。

### 7.3 动态检索：memory_search + memory_get

通过 SDK 的 `tools` 字段（非提示词文本）注册两个工具：

**memory_search 工具定义**：

```typescript
const memorySearchTool = {
  name: "memory_search",
  description: "语义搜索 MEMORY.md + memory/*.md 中的记忆。" +
    "在回答关于先前工作、决策、日期、人员、偏好或待办事项的问题之前必须调用。" +
    "返回带有文件路径和行号的匹配片段。" +
    "可选 category 过滤：core, preferences, people, todos, daily, legacy, topic。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索查询" },
      maxResults: { type: "number", description: "最大结果数" },
      minScore: { type: "number", description: "最低相关度分数" },
      category: { type: "string", description: "分类过滤（可选）" },
    },
    required: ["query"],
  },
  execute: async (params) => {
    const results = await memoryManager.search(params.query, {
      maxResults: params.maxResults,
      minScore: params.minScore,
      category: params.category,
    });
    return { results };
  },
};
```

**memory_get 工具定义**：

```typescript
const memoryGetTool = {
  name: "memory_get",
  description: "从 MEMORY.md 或 memory/*.md 中读取指定行范围的原文。" +
    "在 memory_search 之后使用，仅拉取需要的行以保持上下文紧凑。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件相对路径" },
      from: { type: "number", description: "起始行号（1-indexed）" },
      lines: { type: "number", description: "读取行数" },
    },
    required: ["path"],
  },
  execute: async (params) => {
    // 直接读取 .md 文件，按行号切片
    const content = await fs.readFile(absPath, 'utf-8');
    const allLines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? allLines.length);
    const slice = allLines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: params.path };
  },
};
```

### 7.4 系统提示词中的记忆指引

在系统提示词中添加使用指引（自然语言），引导 LLM 正确使用记忆工具：

```
## Memory Recall
Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines.
If low confidence after search, say you checked.

Memory files are organized by category:
- memory/core.md (architecture/rules)
- memory/preferences.md (user preferences)
- memory/people.md (contacts/roles)
- memory/todos.md (tasks)
- memory/YYYY-MM-DD.md (daily logs)

Use the category filter parameter in memory_search to narrow results
when you know the category (e.g., category='todos' for task queries).

Citations: include Source: <path#line> when it helps verify memory snippets.
```

### 7.5 工具注册方式

工具通过 SDK 的 `tools` 字段传入（结构化 JSON Schema），而非写入系统提示词文本：

```typescript
const agentSession = await createAgentSession({
  model: "claude-sonnet-4-20250514",
  systemPrompt: systemPromptText,  // 包含记忆指引
  tools: [                          // 结构化工具定义
    memorySearchTool,
    memoryGetTool,
    memoryWriteTool,
    // ... 其他工具
  ],
});
```

LLM Provider（如 Anthropic API）会将 tools 数组解析为工具目录，LLM 据此决定何时调用哪个工具。

---

## 8. 上下文压缩与记忆持久化

### 8.1 问题：动态检索结果的生命周期

在多轮对话中，每次 `memory_search` 的返回值都作为工具结果留在对话历史中。随着对话进行，旧的搜索结果会占用大量上下文空间。

### 8.2 三层压缩机制

```
                         对话历史增长
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
        ┌───────────┐  ┌───────────┐  ┌───────────┐
        │  Layer 1   │  │  Layer 2   │  │  Layer 3   │
        │ 工具结果    │  │ Memory    │  │ 会话       │
        │ 上下文守卫  │  │ Flush     │  │ Compaction │
        └───────────┘  └───────────┘  └───────────┘
```

#### Layer 1：工具结果上下文守卫（transformContext）

在每次 LLM API 调用前，拦截消息列表，将旧的工具结果替换为占位符：

```typescript
function installToolResultContextGuard(params: {
  contextWindowTokens: number;
}) {
  const contextBudgetChars =
    contextWindowTokens * 4 * 0.75;  // 75% 的上下文用于输入

  const maxSingleToolResultChars =
    contextWindowTokens * 2 * 0.5;   // 单个工具结果最多占 50%

  // 拦截 transformContext
  return (messages: Message[]) => {
    // 1. 截断超大的单个工具结果
    for (const msg of messages) {
      if (isToolResult(msg) && estimateChars(msg) > maxSingleToolResultChars) {
        msg.content = truncateToChars(msg, maxSingleToolResultChars);
      }
    }

    // 2. 如果总上下文仍超预算，从最旧的工具结果开始替换
    let currentChars = estimateTotalChars(messages);
    if (currentChars > contextBudgetChars) {
      for (let i = 0; i < messages.length; i++) {
        if (!isToolResult(messages[i])) continue;

        const before = estimateChars(messages[i]);
        messages[i].content = "[compacted: tool output removed to free context]";
        const after = estimateChars(messages[i]);

        currentChars -= (before - after);
        if (currentChars <= contextBudgetChars) break;
      }
    }

    return messages;
  };
}
```

**效果**：旧的 memory_search 结果被替换为 `"[compacted: tool output removed to free context]"`，LLM 仍然知道之前做过搜索，但看不到具体结果——如果需要，它会再次调用 memory_search。

#### Layer 2：Memory Flush（记忆持久化）

在会话压缩之前，将对话中的关键信息写入磁盘文件（详见第 6 节）。

**核心价值**：即使对话历史被压缩（摘要化），重要信息已经持久化到 `memory/*.md` 文件中，后续可以通过 memory_search 重新检索。

#### Layer 3：会话压缩（Session Compaction）

当对话历史超过上下文窗口时，使用 LLM 对旧历史进行摘要化：

```typescript
async function summarizeInStages(params: {
  messages: Message[];
  model: string;
  apiKey: string;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  // 1. 将消息按 token 预算分块
  const chunks = chunkMessagesByMaxTokens(
    params.messages, params.maxChunkTokens
  );

  // 2. 逐块摘要
  let runningContext = params.previousSummary ?? "";
  for (const chunk of chunks) {
    const summary = await generateSummary({
      messages: chunk,
      previousContext: runningContext,
      model: params.model,
      apiKey: params.apiKey,
    });
    runningContext = summary;
  }

  return runningContext;
}
```

**压缩后的结构**：

```
[摘要消息] "## 会话摘要\n之前讨论了 X、决定了 Y、待办 Z..."
[最近的消息保留原文]
```

### 8.3 压缩后的记忆恢复

压缩后注入 AGENTS.md 关键段落，确保核心行为指引不丢失：

```typescript
function readPostCompactionContext(workspaceDir: string): string | null {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  const content = fs.readFileSync(agentsPath, "utf-8");

  // 提取关键段落（Session Startup / Red Lines）
  const sections = extractSections(content, ["Session Startup", "Red Lines"]);
  if (sections.length === 0) return null;

  return (
    "[Post-compaction context refresh]\n\n" +
    "Session was just compacted. Execute your Session Startup sequence now.\n\n" +
    "Critical rules:\n\n" +
    sections.join("\n\n")
  );
}
```

### 8.4 完整生命周期图

```
对话开始
  │
  ├── 静态注入 MEMORY.md 到系统提示词
  │
  ├── 多轮对话...
  │   ├── LLM 调用 memory_search → 结果写入历史
  │   ├── LLM 调用 memory_get → 结果写入历史
  │   ├── ...更多工具调用...
  │   │
  │   ├── [Layer 1] transformContext 替换旧工具结果
  │   │
  │   ├── 接近上下文限制...
  │   │
  │   ├── [Layer 2] Memory Flush → 写入 memory/*.md
  │   │
  │   └── [Layer 3] Session Compaction → 历史摘要化
  │       │
  │       └── 注入 Post-compaction context
  │
  └── 对话继续...（新对话 + 摘要 + 可再次搜索记忆）
```

---

## 9. 实现步骤指导

### 9.1 核心依赖

| 依赖 | 用途 | npm 包 |
|------|------|--------|
| SQLite | 数据库引擎 | `node:sqlite`（Node 22+内置）或 `better-sqlite3` |
| sqlite-vec | 向量搜索扩展 | `sqlite-vec`（C 扩展，需编译） |
| Embedding API | 文本嵌入 | OpenAI / Gemini / Voyage / Mistral SDK |
| chokidar | 文件监控 | `chokidar` |

### 9.2 最小可行实现（MVP）路径

建议按以下顺序逐步实现，每步都可独立验证：

#### Step 1：存储层（1-2 天）

- 实现 SQLite schema 创建（6 张表）
- 实现 Markdown 文件扫描（`listMemoryFiles`）
- 实现文件状态跟踪（`buildFileEntry` 计算 hash）
- **验证**：创建数据库，写入测试文件记录，查询确认

#### Step 2：索引层（2-3 天）

- 实现 `chunkMarkdown` 分块算法
- 集成嵌入 API（选一个，如 OpenAI）
- 实现嵌入缓存
- 实现完整的索引写入（chunks + chunks_vec + chunks_fts）
- 实现增量同步
- **验证**：对测试 .md 文件执行索引，检查数据库中的 chunks 记录

#### Step 3：搜索层（2-3 天）

- 实现向量搜索（`searchVector`）
- 实现关键词搜索（`searchKeyword` + `buildFtsQuery` + `bm25RankToScore`）
- 实现混合结果合并（`mergeHybridResults`）
- 实现时间衰减
- **验证**：写入测试记忆文件，执行搜索查询，检查结果排序

#### Step 4：分类层（0.5-1 天）

- 实现 `categoryFromPath`
- 实现 `buildCategoryPathFilter`
- 实现 `isEvergreenCategory`
- 集成到搜索层（可选 category 参数）
- **验证**：写入不同分类的记忆文件，验证分类过滤搜索

#### Step 5：工具层（1-2 天）

- 定义 memory_search 工具（schema + execute）
- 定义 memory_get 工具（schema + execute）
- 定义 memory_write 工具（schema + execute）
- 注册到 Agent SDK
- **验证**：通过 Agent 对话测试工具调用

#### Step 6：注入层（1 天）

- 实现 MEMORY.md 静态注入（contextFile）
- 编写系统提示词记忆指引段落
- 编写 Memory Flush 提示词
- **验证**：检查系统提示词输出，确认记忆指引和 contextFile 存在

#### Step 7：压缩层（2-3 天）

- 实现 transformContext 工具结果守卫
- 实现 Memory Flush 触发逻辑
- 集成会话压缩流程
- 实现 Post-compaction 上下文恢复
- **验证**：长对话测试，观察压缩行为和记忆持久化

### 9.3 关键设计决策清单

在实现前需要确认的决策点：

| 决策 | 选项 | 建议 |
|------|------|------|
| 嵌入模型 | OpenAI / Gemini / Voyage / Mistral / 本地 | OpenAI `text-embedding-3-small` 性价比最高 |
| 向量维度 | 256 / 512 / 1536 / 3072 | 1536（OpenAI 默认），或降维到 512 节省空间 |
| 分块大小 | 200-800 tokens | 400 tokens（平衡精度和上下文长度） |
| 分块重叠 | 0-200 tokens | 80 tokens（20% 重叠） |
| 向量权重 | 0.5-0.9 | 0.7（语义搜索为主） |
| 文本权重 | 0.1-0.5 | 0.3（关键词搜索为辅） |
| 衰减半衰期 | 7-90 天 | 30 天 |
| 搜索 Top-K | 3-20 | 10 |
| 最低分阈值 | 0.0-0.5 | 0.1 |
| sqlite-vec 是否必须 | 必须 / 可选 | 可选（提供暴力搜索后备） |
| FTS5 是否必须 | 必须 / 可选 | 推荐（某些 SQLite 构建不支持） |

### 9.4 测试策略

```
单元测试：
├── chunkMarkdown: 分块边界、重叠、空文件、超长行
├── categoryFromPath: 所有分类路径、边界条件、路径分隔符
├── buildCategoryPathFilter: SQL 生成、参数绑定
├── buildFtsQuery: token 提取、特殊字符
├── bm25RankToScore: 分数转换
├── mergeHybridResults: 单路命中、双路命中、空结果
├── calculateTemporalDecayMultiplier: 衰减曲线、边界值
└── isEvergreenCategory: 各分类判断

集成测试：
├── 完整索引流程：文件 → 分块 → 嵌入 → 写入
├── 增量同步：文件修改 → 重新索引
├── 混合搜索：端到端查询 → 结果验证
├── 分类过滤搜索：按 category 过滤
└── Memory Flush：触发条件 → 文件写入

端到端测试：
├── Agent 对话中使用 memory_search
├── Memory Flush → 验证分类文件生成
└── 长对话压缩 → 记忆恢复
```

---

## 10. 嵌入提供商设计

记忆模块的向量搜索依赖嵌入提供商将文本转换为数值向量。本节详述嵌入提供商的抽象层、工厂模式、自动选择与降级链、缓存机制和批量处理。

### 10.1 统一抽象接口

所有嵌入提供商（远程 API 和本地模型）实现同一个接口：

```typescript
type EmbeddingProvider = {
  id: string;           // 提供商标识，如 "openai"、"gemini"、"local"
  model: string;        // 模型名，如 "text-embedding-3-small"
  maxInputTokens?: number;  // 单次输入的 token 上限
  embedQuery: (text: string) => Promise<number[]>;     // 单文本嵌入（查询用）
  embedBatch: (texts: string[]) => Promise<number[][]>; // 批量嵌入（索引用）
};
```

**设计要点**：
- `embedQuery` 和 `embedBatch` 分离：部分提供商（如 Gemini、Voyage）区分 `RETRIEVAL_QUERY` 和 `RETRIEVAL_DOCUMENT` 两种 task type，query 和 document 使用不同的嵌入策略
- `maxInputTokens` 可选：用于在嵌入前自动拆分超长 chunk
- 返回 `number[]` 纯数值数组，不绑定特定向量库格式

### 10.2 支持的提供商

| 提供商 | 类型 | 默认模型 | 输入 Token 上限 | 认证方式 |
|--------|------|---------|----------------|---------|
| `openai` | 远程 | `text-embedding-3-small` | 8192 | Bearer Token |
| `gemini` | 远程 | `gemini-embedding-001` | 2048 | API Key（支持多 Key 轮换） |
| `voyage` | 远程 | `voyage-4-large` | 32000 | Bearer Token |
| `mistral` | 远程 | `mistral-embed` | — | Bearer Token |
| `local` | 本地 | `embedding-gemma-300m` (GGUF) | — | 无需认证 |

**远程提供商的 HTTP 接口**：

```typescript
// OpenAI / Mistral 使用相同的 API 格式（OpenAI 兼容）
// POST {baseUrl}/embeddings
{
  model: "text-embedding-3-small",
  input: "要嵌入的文本"
}
// 响应：{ data: [{ embedding: [0.123, -0.456, ...] }] }

// Gemini 使用 Google AI API
// POST {baseUrl}/{model}:embedContent
{
  content: { parts: [{ text: "要嵌入的文本" }] },
  taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT"
}

// Voyage 使用自有 API
// POST {baseUrl}/embeddings
{
  model: "voyage-4-large",
  input: "要嵌入的文本",
  input_type: "query" | "document"
}
```

### 10.3 工厂模式与自动选择

核心工厂函数 `createEmbeddingProvider()` 支持三种选择模式：

```typescript
type EmbeddingProviderRequest = "auto" | "openai" | "gemini" | "voyage" | "mistral" | "local";
type EmbeddingProviderFallback = "openai" | "gemini" | "voyage" | "mistral" | "local" | "none";

type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;  // null = 所有提供商不可用
  fallbackFrom?: string;              // 从哪个提供商降级的
  fallbackReason?: string;            // 降级原因
  unavailableReason?: string;         // 完全不可用的原因
};

async function createEmbeddingProvider(params: {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
  model?: string;           // 覆盖默认模型
  remote?: {
    baseUrl?: string;       // 自定义 API 端点（如代理/私有部署）
    apiKey?: string;        // API 密钥
    headers?: Record<string, string>;  // 额外请求头
  };
  local?: {
    modelPath?: string;     // 本地 GGUF 模型文件路径
    modelCacheDir?: string; // 模型缓存目录
  };
}): Promise<EmbeddingProviderResult> {
  // ... 见下方详细逻辑
}
```

#### 模式 A：自动检测（`provider = "auto"`）

```
┌─────────────────────────────────────────────┐
│             自动检测流程                      │
├─────────────────────────────────────────────┤
│                                             │
│  1. 检查是否配置了本地模型路径               │
│     └─ modelPath 存在且是本地文件？          │
│        ├─ 是 → 尝试创建 local 提供商        │
│        │       ├─ 成功 → 返回 local         │
│        │       └─ 失败 → 继续步骤 2         │
│        └─ 否 → 继续步骤 2                   │
│                                             │
│  2. 按顺序尝试远程提供商：                   │
│     openai → gemini → voyage → mistral      │
│     │                                       │
│     ├─ 创建提供商...                        │
│     │  ├─ 成功 → 返回该提供商               │
│     │  ├─ 认证失败（无 API Key）→ 继续下一个│
│     │  └─ 其他错误 → 直接抛出异常           │
│     │                                       │
│     └─ 全部认证失败 →                       │
│        返回 null（降级到 FTS-only 模式）     │
│                                             │
└─────────────────────────────────────────────┘
```

#### 模式 B：显式指定 + 降级

```
┌─────────────────────────────────────────────┐
│     显式提供商 + Fallback 流程               │
├─────────────────────────────────────────────┤
│                                             │
│  1. 尝试创建指定提供商（如 "voyage"）        │
│     ├─ 成功 → 返回                          │
│     ├─ 认证失败 →                           │
│     │  ├─ 配置了 fallback？                 │
│     │  │  ├─ 是 → 尝试 fallback 提供商      │
│     │  │  │   ├─ 成功 → 返回（记录降级信息）│
│     │  │  │   ├─ 认证失败 → 返回 null       │
│     │  │  │   └─ 其他错误 → 抛出            │
│     │  │  └─ 否 → 返回 null（FTS-only）     │
│     │  └───────────────────────────         │
│     └─ 其他错误 → 直接抛出异常              │
│                                             │
└─────────────────────────────────────────────┘
```

#### 模式 C：null 提供商（FTS-only 降级）

当所有嵌入提供商不可用时，`provider = null`，记忆系统自动降级为**纯 FTS5 关键词搜索**：

```typescript
// manager.ts search() 中的降级逻辑
async search(query: string, opts?: { ... }): Promise<MemorySearchResult[]> {
  // FTS-only 模式：无嵌入提供商
  if (!this.provider) {
    if (!this.fts.enabled || !this.fts.available) {
      return [];  // 向量和 FTS 都不可用
    }
    // 提取关键词，执行纯 FTS 搜索
    const keywords = extractKeywords(query);
    const resultSets = await Promise.all(
      keywords.map(term => this.searchKeyword(term, candidates))
    );
    // 合并去重，返回结果
    return mergedResults;
  }
  // 正常混合搜索路径...
}
```

### 10.4 远程提供商通用模式

OpenAI 和 Mistral 使用通用的 `createRemoteEmbeddingProvider()` 工厂（兼容 OpenAI API 格式的 `/embeddings` 端点）：

```typescript
// 通用远程嵌入提供商工厂
function createRemoteEmbeddingProvider(params: {
  id: string;              // "openai" | "mistral"
  client: RemoteEmbeddingClient;
  maxInputTokens?: number;
}): EmbeddingProvider {
  return {
    id: params.id,
    model: client.model,
    maxInputTokens: params.maxInputTokens,

    embedQuery: async (text: string) => {
      const response = await fetchRemoteEmbeddingVectors({
        url: `${client.baseUrl}/embeddings`,
        headers: client.headers,      // { Authorization: "Bearer xxx" }
        body: { model: client.model, input: text },
      });
      return response[0];  // number[]
    },

    embedBatch: async (texts: string[]) => {
      const response = await fetchRemoteEmbeddingVectors({
        url: `${client.baseUrl}/embeddings`,
        headers: client.headers,
        body: { model: client.model, input: texts },
      });
      return response;  // number[][]
    },
  };
}

// 通用 HTTP 请求工具
async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  body: object;
}): Promise<number[][]> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...params.headers },
    body: JSON.stringify(params.body),
  });
  const json = await response.json();
  // 响应格式：{ data: [{ embedding: number[] }, ...] }
  return json.data.map((item: { embedding: number[] }) => item.embedding);
}
```

**客户端解析模式**：

```typescript
// 解析 API Key 来源（配置 → 环境变量）
function resolveRemoteEmbeddingClient(params: {
  provider: string;
  model: string;
  config: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  envKey: string;           // 如 "OPENAI_API_KEY"
  defaultBaseUrl: string;   // 如 "https://api.openai.com/v1"
}): RemoteEmbeddingClient | null {
  // 1. 先从配置中取 API Key
  let apiKey = params.config.apiKey;

  // 2. 配置中没有 → 从环境变量取
  if (!apiKey) {
    apiKey = process.env[params.envKey];
  }

  // 3. 都没有 → 返回 null（认证失败）
  if (!apiKey) return null;

  return {
    model: params.model,
    baseUrl: params.config.baseUrl ?? params.defaultBaseUrl,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      ...params.config.headers,
    },
  };
}
```

### 10.5 Gemini 特殊处理：API Key 轮换

Gemini 支持多个 API Key 轮换，应对单 Key 配额限制：

```typescript
// Gemini 提供商支持多 Key 轮换
function createGeminiEmbeddingProvider(params: {
  apiKeys: string[];  // 支持多个 API Key
  model: string;
  baseUrl: string;
}): EmbeddingProvider {
  let currentKeyIndex = 0;

  async function executeWithApiKeyRotation<T>(
    fn: (apiKey: string) => Promise<T>
  ): Promise<T> {
    const startIndex = currentKeyIndex;
    let lastError: Error | null = null;

    // 尝试每个 Key，直到成功或全部失败
    do {
      const apiKey = params.apiKeys[currentKeyIndex];
      try {
        return await fn(apiKey);
      } catch (err) {
        lastError = err as Error;
        // 轮换到下一个 Key
        currentKeyIndex = (currentKeyIndex + 1) % params.apiKeys.length;
      }
    } while (currentKeyIndex !== startIndex);

    throw lastError;
  }

  return {
    id: "gemini",
    model: params.model,
    embedQuery: async (text) => {
      return executeWithApiKeyRotation(async (apiKey) => {
        // POST {baseUrl}/{model}:embedContent?key={apiKey}
        const url = `${params.baseUrl}/${params.model}:embedContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_QUERY",
          }),
        });
        const json = await response.json();
        return json.embedding.values;
      });
    },
    embedBatch: async (texts) => {
      return executeWithApiKeyRotation(async (apiKey) => {
        // POST {baseUrl}/{model}:batchEmbedContents?key={apiKey}
        const url = `${params.baseUrl}/${params.model}:batchEmbedContents?key=${apiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: texts.map(text => ({
              content: { parts: [{ text }] },
              taskType: "RETRIEVAL_DOCUMENT",
            })),
          }),
        });
        const json = await response.json();
        return json.embeddings.map((e: any) => e.values);
      });
    },
  };
}
```

### 10.6 本地嵌入提供商

使用 `node-llama-cpp` 在本地运行 GGUF 格式的嵌入模型，无需远程 API 调用：

```typescript
function createLocalEmbeddingProvider(params: {
  modelPath: string;  // GGUF 文件路径或 HuggingFace 标识
  modelCacheDir?: string;
}): EmbeddingProvider {
  let llamaInstance: Llama | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;

  // 懒加载：首次使用时才加载模型
  async function ensureLoaded() {
    if (embeddingContext) return;
    const { getLlama } = await import("node-llama-cpp");
    llamaInstance = await getLlama();
    const model = await llamaInstance.loadModel({ modelPath: params.modelPath });
    embeddingContext = await model.createEmbeddingContext();
  }

  // 后处理：清理非有限值，L2 归一化
  function sanitizeEmbedding(raw: number[]): number[] {
    const cleaned = raw.map(v => Number.isFinite(v) ? v : 0);
    const magnitude = Math.sqrt(cleaned.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return cleaned;
    return cleaned.map(v => v / magnitude);
  }

  return {
    id: "local",
    model: path.basename(params.modelPath),
    embedQuery: async (text) => {
      await ensureLoaded();
      const result = await embeddingContext!.getEmbeddingFor(text);
      return sanitizeEmbedding(Array.from(result.vector));
    },
    embedBatch: async (texts) => {
      await ensureLoaded();
      return Promise.all(texts.map(async text => {
        const result = await embeddingContext!.getEmbeddingFor(text);
        return sanitizeEmbedding(Array.from(result.vector));
      }));
    },
  };
}
```

**自动选择检查**（判断是否使用本地提供商）：

```typescript
function shouldUseLocalProvider(modelPath?: string): boolean {
  if (!modelPath) return false;
  // HuggingFace 标识或 URL → 不算本地文件
  if (modelPath.startsWith("hf:") || modelPath.startsWith("http")) return false;
  // 检查文件是否实际存在
  return fs.existsSync(modelPath);
}
```

### 10.7 嵌入缓存机制

基于**文本哈希**的四元组主键缓存，避免对相同文本重复调用嵌入 API：

```sql
-- 缓存表 Schema（已在第 2 节中定义）
CREATE TABLE embedding_cache (
  provider     TEXT NOT NULL,     -- 提供商标识
  model        TEXT NOT NULL,     -- 模型名
  provider_key TEXT NOT NULL,     -- API Key 标识（区分不同认证上下文）
  hash         TEXT NOT NULL,     -- 文本内容 SHA-256
  embedding    TEXT NOT NULL,     -- 缓存的嵌入向量（JSON 数组）
  dims         INTEGER,           -- 向量维度
  updated_at   INTEGER NOT NULL,  -- 更新时间戳
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

**缓存操作**：

```typescript
class EmbeddingCacheOps {
  // 批量加载缓存（一次最多 400 条）
  async loadCached(
    textHashes: string[]
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    // 分批查询，每批 400 条
    for (const batch of chunkArray(textHashes, 400)) {
      const placeholders = batch.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT hash, embedding FROM ${CACHE_TABLE}
         WHERE provider = ? AND model = ? AND provider_key = ?
           AND hash IN (${placeholders})`
      ).all(provider, model, providerKey, ...batch);

      for (const row of rows) {
        result.set(row.hash, JSON.parse(row.embedding));
      }
    }
    return result;
  }

  // 写入缓存
  upsertCache(hash: string, embedding: number[]): void {
    db.prepare(
      `INSERT OR REPLACE INTO ${CACHE_TABLE}
       (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(provider, model, providerKey, hash,
          JSON.stringify(embedding), embedding.length, Date.now());
  }

  // LRU 淘汰（按 updated_at 排序，保留最新的 maxEntries 条）
  pruneCache(maxEntries: number): void {
    const count = db.prepare(
      `SELECT COUNT(*) as c FROM ${CACHE_TABLE}
       WHERE provider = ? AND model = ?`
    ).get(provider, model).c;

    if (count <= maxEntries) return;

    const toDelete = count - maxEntries;
    db.prepare(
      `DELETE FROM ${CACHE_TABLE}
       WHERE rowid IN (
         SELECT rowid FROM ${CACHE_TABLE}
         WHERE provider = ? AND model = ?
         ORDER BY updated_at ASC
         LIMIT ?
       )`
    ).run(provider, model, toDelete);
  }
}
```

**缓存的使用流程**：

```
索引写入时：
  1. 对所有 chunk 计算文本哈希
  2. 批量查询缓存：已缓存的直接使用
  3. 未缓存的 chunk → 调用嵌入 API
  4. 将新嵌入写入缓存
  5. 如果超过 maxEntries → LRU 淘汰

搜索查询时：
  查询文本直接调用 embedQuery()（不走缓存，因为查询文本通常不重复）
```

### 10.8 输入 Token 限制与自动拆分

嵌入模型有输入 token 上限，超长 chunk 需要自动拆分：

```typescript
// 已知模型的 token 上限
const KNOWN_LIMITS: Record<string, number> = {
  "openai:text-embedding-3-small": 8192,
  "openai:text-embedding-3-large": 8192,
  "openai:text-embedding-ada-002": 8191,
  "gemini:text-embedding-004": 2048,
  "gemini:gemini-embedding-001": 2048,
  "voyage:voyage-3": 32000,
  "voyage:voyage-3-lite": 16000,
  "voyage:voyage-code-3": 32000,
};

function enforceEmbeddingMaxInputTokens(
  provider: EmbeddingProvider,
  chunks: MemoryChunk[],
): MemoryChunk[] {
  const limit = provider.maxInputTokens
    ?? KNOWN_LIMITS[`${provider.id}:${provider.model}`]
    ?? 8192;  // 默认上限

  const maxChars = limit * 4;  // 近似 token→字符

  return chunks.flatMap(chunk => {
    if (chunk.text.length <= maxChars) {
      return [chunk];
    }
    // 超长 chunk → 拆分为多个子 chunk
    const pieces: MemoryChunk[] = [];
    for (let start = 0; start < chunk.text.length; start += maxChars) {
      const text = chunk.text.slice(start, start + maxChars);
      pieces.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text,
        hash: sha256(text),
      });
    }
    return pieces;
  });
}
```

### 10.9 嵌入重试与错误处理

API 调用失败时的指数退避重试：

```typescript
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

async function embedBatchWithRetry(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await provider.embedBatch(texts);
    } catch (err) {
      lastError = err as Error;

      // 认证错误不重试
      if (isAuthError(err)) throw err;

      // 指数退避
      const delay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
        RETRY_MAX_DELAY_MS
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
```

**批量失败追踪**（用于监控持续性 API 问题）：

```typescript
// Manager 级别的失败追踪
class MemoryIndexManager {
  private batchFailureCount = 0;
  private batchFailureLastError?: string;
  private batchFailureLastProvider?: string;

  // 批量失败达到上限（默认 2 次）后，暂停该提供商
  private readonly BATCH_FAILURE_LIMIT = 2;
}
```

### 10.10 异步批量 API（可选，大规模索引用）

对于大量文件的首次索引，可使用提供商的异步 Batch API 降低成本：

```
                     异步 Batch API 流程
┌──────────────────────────────────────────────┐
│                                              │
│  1. 准备阶段：                               │
│     将所有待嵌入文本打包为 JSONL 文件          │
│     每行一条请求                              │
│                                              │
│  2. 上传阶段：                               │
│     POST /files (上传 JSONL)                 │
│     → 获得 file_id                           │
│                                              │
│  3. 创建批量任务：                            │
│     POST /batches                            │
│     { input_file_id, endpoint: "/embeddings" }│
│     → 获得 batch_id                          │
│                                              │
│  4. 轮询状态：                               │
│     GET /batches/{batch_id}                  │
│     每 2 秒轮询，超时 60 分钟                 │
│     状态：queued → in_progress → completed    │
│                                              │
│  5. 获取结果：                               │
│     GET /files/{output_file_id}/content      │
│     解析 JSONL → 提取每条的 embedding         │
│                                              │
└──────────────────────────────────────────────┘
```

配置：

```typescript
type BatchConfig = {
  enabled: boolean;         // 默认 false（正常使用即时 API 即可）
  wait: boolean;            // 是否同步等待结果
  concurrency: number;      // 并行 batch 数（默认 2）
  pollIntervalMs: number;   // 轮询间隔（默认 2000ms）
  timeoutMinutes: number;   // 超时时间（默认 60 分钟）
};
```

### 10.11 配置结构汇总

```typescript
// 完整的嵌入相关配置
type MemorySearchConfig = {
  // 提供商选择
  provider: "auto" | "openai" | "gemini" | "voyage" | "mistral" | "local";
  fallback: "openai" | "gemini" | "voyage" | "mistral" | "local" | "none";
  model: string;             // 覆盖提供商默认模型

  // 远程提供商配置
  remote?: {
    baseUrl?: string;        // 自定义 API 端点（代理/私有部署）
    apiKey?: string;         // API 密钥（优先于环境变量）
    headers?: Record<string, string>;  // 额外请求头
    batch?: BatchConfig;     // 异步批量 API 配置
  };

  // 本地提供商配置
  local?: {
    modelPath?: string;      // GGUF 模型文件路径
    modelCacheDir?: string;  // HuggingFace 模型下载缓存目录
  };

  // 缓存配置
  cache: {
    enabled: boolean;        // 默认 true
    maxEntries?: number;     // LRU 缓存上限
  };

  // 以下为搜索相关配置（与提供商无关，但影响嵌入使用方式）
  store: {
    driver: "sqlite";
    path: string;            // SQLite 数据库路径
    vector: {
      enabled: boolean;      // 是否启用 sqlite-vec
      extensionPath?: string;// sqlite-vec 扩展路径
    };
  };
  chunking: {
    tokens: number;          // 分块大小（默认 400）
    overlap: number;         // 重叠大小（默认 80）
  };
};
```

### 10.12 移植建议

| 场景 | 推荐方案 |
|------|---------|
| **快速起步** | 仅实现 OpenAI 提供商 + 嵌入缓存，约 100 行代码 |
| **离线/隐私优先** | 仅实现 local 提供商（node-llama-cpp + GGUF），无 API 依赖 |
| **生产就绪** | 实现 auto 选择 + FTS-only 降级 + 嵌入缓存 + 重试机制 |
| **多提供商** | 按需逐个添加，遵循统一 `EmbeddingProvider` 接口 |
| **大规模索引** | 添加异步 Batch API 支持，降低 API 成本 |

**最小实现清单**（约 200 行核心代码）：

1. `EmbeddingProvider` 接口定义
2. 一个具体提供商（如 OpenAI）的 `createOpenAIEmbeddingProvider()`
3. `fetchRemoteEmbeddingVectors()` HTTP 请求工具
4. 嵌入缓存的 `loadCached()` / `upsertCache()` / `pruneCache()`
5. `embedBatchWithRetry()` 重试逻辑
6. `enforceEmbeddingMaxInputTokens()` 输入限制检查

---

## 附录：关键数据结构参考

### MemoryChunk

```typescript
type MemoryChunk = {
  startLine: number;  // 1-indexed 起始行号
  endLine: number;    // 1-indexed 结束行号
  text: string;       // 分块文本内容
  hash: string;       // 文本 SHA-256 哈希
};
```

### MemorySearchResult

```typescript
type MemorySearchResult = {
  path: string;       // 文件相对路径
  startLine: number;  // 1-indexed
  endLine: number;    // 1-indexed
  score: number;      // 0~1 相关度评分
  snippet: string;    // 截断后的文本片段
  source: string;     // "memory" 或 "sessions"
};
```

### MemoryCategory

```typescript
type MemoryCategory =
  | "core"        // 架构决策、项目规则
  | "preferences" // 用户偏好
  | "people"      // 联系人
  | "todos"       // 待办事项
  | "daily"       // 日期日志（时间衰减）
  | "legacy"      // MEMORY.md 向后兼容
  | "topic";      // 自定义主题
```

### EmbeddingProvider

```typescript
type EmbeddingProvider = {
  id: string;           // 提供商标识："openai" | "gemini" | "voyage" | "mistral" | "local"
  model: string;        // 模型名，如 "text-embedding-3-small"
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};
```

### EmbeddingProviderResult

```typescript
type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;  // null = FTS-only 降级
  fallbackFrom?: string;              // 降级前的提供商
  fallbackReason?: string;            // 降级原因
  unavailableReason?: string;         // 完全不可用的原因
};
```

### HybridSearchConfig

```typescript
type HybridSearchConfig = {
  enabled: boolean;          // 是否启用混合搜索
  vectorWeight: number;      // 向量搜索权重（默认 0.7）
  textWeight: number;        // 关键词搜索权重（默认 0.3）
  candidateMultiplier: number; // 候选数倍数（内部取 topK * multiplier 个候选再过滤）
  temporalDecay?: {
    enabled: boolean;
    halfLifeDays: number;    // 衰减半衰期（默认 30 天）
  };
  mmr?: {
    enabled: boolean;
    lambda: number;          // MMR 多样性参数
  };
};
```
