# Blinko 操作指南

本参考与 `../SKILL.md` 在各设备 PiWeb／OC 使用同一内容，职责与授权以主技能和插件注入的记忆规则为准。

## 日常维护边界

- 仅维护符合 smemo 职责的跨设备共享知识；不新增个人倾向、现场事实、项目专有状态或敏感信息。
- 与当前任务或相关知识维护直接相关的创建、更新、合并、标签调整、归档、恢复及删除（含永久删除）均可自主执行并事后回报，不要求逐条授权，也不强制先标记待删除或备份。
- 合并保留独有价值后再处理重复条目；有历史／引用价值的外部结论保留必要追溯。永久删除不承诺可恢复。
- 已有现场记录另按确认范围迁移到所属项目资料，不能借技能同步顺手清理旧库。定时任务、其他文件／服务和凭据权限不包含在条目维护授权内。

## MCP 接入

| 宿主 | 操作方式 |
| --- | --- |
| Pi／Pi Web | Pi 原生 MCP；本会话有 codemode 时通过 `searchTools()`／`describeTool()` 获取工具定义；原生工具名以实际发现结果为准 |
| OpenCode | 使用当前会话已提供的 MCP 工具及发现入口，不复制 Pi 专属调用前缀或调用方式 |

`blinko__searchBlinko`、`blinko__upsertBlinko`、`blinko__updateBlinko`、`blinko__deleteBlinko` 分别承担检索、创建、更新和删除。实际名称、参数及操作效果以实时定义为准，不用本页历史 API 片段代替工具 schema。

### 查询与状态验证

1. 先关键词宽搜，再按标签精确筛选；同范围先更新主记录。
2. 普通列表无命中时检查当前工具的归档／回收站过滤能力，如支持，可定向查询相应状态；不能据此断言条目不存在或已永久删除。
3. 合并／更新后回读确认正文和状态；删除前确认实际入口是移入回收站还是永久删除，删除后按工具支持的状态查询或明确结果验证。
4. 工具或认证不可用时报告原因，只用已提供的入口；不猜工具名，不通过搜索凭据或临时放宽权限绕过故障。

## 历史 API 调查线索

以下是此前保留的源码定位及接口摘录，**没有绑定当前运行版本**。路径、行号、字段和删除语义可能变化，仅供必要时调查；实际 API 操作前须核验目标版本、受管入口、身份和 schema。普通维护优先使用已授权 MCP，不因 MCP 故障推定已获直接 API 认证授权。

## API 源码位置

- **文件**: `server/routerTrpc/note.ts`
- **路由**: `noteRouter.updateMany`
- **行号**: 1278-1297

### 相关批量操作 (同一文件)

| 端点 | 路由路径 | 行号 |
| ---------- | --------------------- | --------- |
| `updateMany` | `/v1/note/batch-update` | 1278-1297 |
| `trashMany` | `/v1/note/batch-trash` | 1298-1306 |
| `deleteMany` | `/v1/note/batch-delete` | 1307-1333 |

### batch-update 源码

```typescript
updateMany: authProcedure
  .meta({ openapi: { method: 'POST', path: '/v1/note/batch-update', summary: 'Batch update note', protect: true, tags: ['Note'] } })
  .input(
    z.object({
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1),
      isArchived: z.union([z.boolean(), z.null()]).default(null),
      isRecycle: z.union([z.boolean(), z.null()]).default(null),
      ids: z.array(z.number()),
    }),
  )
  .output(z.any())
  .mutation(async function ({ input, ctx }) {
    const { type, isArchived, isRecycle, ids } = input;
    const update: Prisma.notesUpdateInput = {
      ...(type !== -1 && { type }),
      ...(isArchived !== null && { isArchived }),
      ...(isRecycle !== null && { isRecycle }),
    };
    return await prisma.notes.updateMany({ where: { id: { in: ids }, accountId: Number(ctx.id) }, data: update });
  }),
```

## 常用 API 端点

### 笔记列表

**文件**: `server/routerTrpc/note.ts`
**行号**: 26-65

```typescript
list: authProcedure
  .meta({ openapi: { method: 'POST', path: '/v1/note/list', summary: 'Query notes list', protect: true, tags: ['Note'] } })
  .input(
    z.object({
      tagId: z.union([z.number(), z.null()]).default(null),
      page: z.number().default(1),
      size: z.number().default(30),
      orderBy: z.enum(['asc', 'desc']).default('desc'),
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1),
      isArchived: z.union([z.boolean(), z.null()]).default(false).optional(),
      isShare: z.union([z.boolean(), z.null()]).default(null).optional(),
      isRecycle: z.boolean().default(false).optional(),
      searchText: z.string().default('').optional(),
      withoutTag: z.boolean().default(false).optional(),
      withFile: z.boolean().default(false).optional(),
      withLink: z.boolean().default(false).optional(),
      isUseAiQuery: z.boolean().default(false).optional(),
      startDate: z.union([z.date(), z.null(), z.string()]).default(null).optional(),
      endDate: z.union([z.date(), z.null(), z.string()]).default(null).optional(),
      hasTodo: z.boolean().default(false).optional(),
    }),
  )
```

## 定时任务线索

此前记录的 `ArchiveJob`、`DBJob`、`RebuildEmbeddingJob`、`RecommandJob`、`AIScheduledTaskJob` 是调查线索，不证明当前实例正在执行这些任务。当前任务是否启用、何时运行和能否修改须按实际版本核验；不由普通条目维护授权推定可以新建、修改或删除调度。

## 相关定位

- 技能职责与维护流程：[smemo 主技能](../SKILL.md)。
- 官方源码项目：`blinkospace/blinko`，笔记路由线索 `server/routerTrpc/note.ts`。
- 受管实例的 API 文档／OpenAPI 入口与身份从既有配置确认，不将具体设备现场或认证复制进共享笔记。
