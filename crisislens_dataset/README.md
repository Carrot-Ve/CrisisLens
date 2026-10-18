# CrisisLens Dataset

可加载、可校验的合成开发集：1 个基础案例、7 个端到端 Challenge、6 个过程用例，共 14 例。**Gold 尚待人工复核，尚未运行真实 Agent，不代表产品验收或准确率。**

## 使用

需要 Node.js 24+，无需安装第三方依赖。在本目录执行：

```powershell
npm run validate
npm test
```

scripts/build-dataset.ts 是合成数据的生成源。修改后运行 npm run build:data 会覆盖案例原文、Gold、索引、Schema、分组及旧 YAML 入口，不覆盖手工 Bad Case。人工复核后应冻结版本，避免重新生成覆盖复核结果。

## 内容

| 类型 | 数量 | 范围 |
|---|---:|---|
| 基础端到端 | 1 | 调查请求到带引用的报告 |
| 端到端 Challenge | 7 | 缺失质检、时间口径、转载、持续超时、权限、提示注入、真实冲突 |
| 过程用例 | 6 | 检索、证据冲突、状态上下文、规划停止、权限重试、报告生成 |
| 真实 Bad Case | 0 | 等实际运行失败后按模板记录 |

全部属于同一事件族 food_event_2024_001，暂放 dev。regression/holdout 有意为空；增加独立事件族后才能建立独立测试集，不能把同一事件改写拆进不同 split。

## 加载与答案隔离

- cases.jsonl 仅供评测端读取，含输入、Gold、原文路径、权限、故障配置。所有路径相对本数据集根目录。
- 各例 input.json 是用户任务或局部模块输入；gold.json 保存预期事实、原文锚点、验收判据。
- materials 包含合成原文及权限测试用合同 canary，不含真实秘密。
- rubrics.md 定义评分、硬门槛和人工复核方法。
- 历史 golden_case_001.yaml 已废弃为入口说明；JSON 索引是唯一加载入口。
- validate.ts 检查本仓库 Schema 子集、引用、路径、权限与分组，遇到未知 Schema 关键字报错，不是通用 Schema 引擎。

不要把整个数据集目录、cases.jsonl、Gold 或生成脚本放入模型上下文。评测端创建夹具，仅把 runner.input 和工具回调暴露给 Agent：

```typescript
import { createFixtureRunner } from './scripts/fixture-runner.ts';
const runner = createFixtureRunner(datasetRoot, 'food_foreign_object_001');
const results = runner.call('search_sources', { query: '投诉' });
const source = runner.call('fetch_source', { id: 'complaint_001' });
// 将 runner.input 传给模型，按实际 SDK 包装 runner.call；评测端保留 runner.trace。
```

夹具尚未接入 Pi/MiniClaw 模型循环。搜索按标题/ID 子串确定性匹配，空查询可列出通道目录，不测真实语义召回。受限合同标题可发现，正文读取被拒绝。

逻辑投影不是操作系统沙箱：被测 Agent 必须关闭直接文件/终端访问，或在隔离进程/容器只开放工具接口，否则仍可能绕过接口读答案。模块输入正文是否暗含答案还需人工审查。

调用预算包含搜索、读取、失败与拒绝。超时按资源注入，不真实等待，最多重试一次。max_tokens 是接入契约，由真实模型 Runtime 测量与执行，夹具不测 token。

## 运行与证据

真实运行应保存 case_id、run_id、Agent/model/prompt/tool 版本、数据版本或哈希、输出、Trace、token/耗时及逐项评分。静态校验、夹具单测、真实模块测试、Agent 端到端评测应分别报告。过程例需要接入相应模块后才可评判其实际正确性。
