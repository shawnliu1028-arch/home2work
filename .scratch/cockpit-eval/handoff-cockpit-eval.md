# 交接文档：tau2-bench 半双工框架下评估智能座舱黑盒 Agent

日期：2026-09-23
工作区：`/home/kazuha/tau2-bench`（τ-bench 代码库，见根目录 `AGENTS.md` 了解项目概况）

## 项目目标

利用 tau2-bench 的**半双工**评测框架，以垂域任务数据评估用户已有的一个**智能座舱黑盒 Agent**（已独立部署的 HTTP 服务）。

## 需求画像（三轮访谈拷问确认的事实）

这些是用户亲口确认的关键决策，实现时不要重新质疑，除非出现硬冲突：

1. **Agent 形态**：黑盒服务/API。内部有自己的工具链和知识库，只能通过 HTTP 对话。身份通过 `user_id` 和 `VIN` 确定。接口既支持传全量历史，也支持单条用户消息（有状态 session）；**推荐单条消息模式**，适配器最简。
2. **垂域数据**：目前只有「用户指令 + 期望结果」，**尚未结构化**——这是最大的数据工程量（对应票据 04）。
3. **工具执行**：Agent 连真实测试后端执行操作。测试环境**可重置、可快照**。
4. **判分方式**：总体走 **LLM judge**（tau2 内置 `NLAssertionsEvaluator` + `EvaluationType.NL_ASSERTIONS`，无需自定义判分器）。座舱后端暂无查询接口，但未来会提供——程序化终态断言作为预留票据 08。
5. **用户模拟器**：tau2 内置 LLM 用户模拟器 + 用户场景数据。垂域为智能座舱，**不需要账户细节**；画像由模拟器在限定范围内生成，后端也提供部分画像功能。
6. **任务构成**：大部分为单轮直接指令，少量曲折场景；已同意补充约 20% 多轮曲折任务（票据 07）。
7. **规模**：小任务集（<50 任务），每任务 ≥3 trials 取平均（票据 06）。

## 技术方案要点（已与用户对齐）

- **接入方式**：实现 `HalfDuplexAgent` 子类（见 `src/tau2/agent/base_agent.py:52`，关键方法 `generate_next_message()`，构造签名 `(tools, domain_policy)`）。UserMessage 文本 + user_id/VIN → HTTP POST → 响应包装为纯文本 `AssistantMessage`（无 tool_calls，tools 传空列表）。**响应中的结构化动作执行结果必须拼进 AssistantMessage 文本**，否则 judge 无法判断"是否正确调用工具"。
- **判分**：任务 `reward_basis: ["nl_assertions"]`，期望结果拆为 **3~6 条原子断言**（可独立判 True/False），这是 judge 稳定性的关键。
- **运行**：`tau2 run --domain cockpit --agent <黑盒agent> --user-llm <强模型> --num-trials 3 --evaluation-type nl_assertions`。
- **残余风险**（需持续盯住）：judge 盲区（黑盒"没调工具但嘴上说调了"）、trial 间真实后端副作用叠加（批间重置测试环境）、judge 校准（人工标注 20 条轨迹，一致率 ≥90% 才采信）。

## 关键代码坐标（已勘察）

- `src/tau2/agent/base_agent.py:52` — `HalfDuplexAgent` 基类
- `src/tau2/evaluator/evaluator_nl_assertions.py:16` — `NLAssertionsEvaluator`（内置 LLM judge，按原子断言判二元分）
- `src/tau2/evaluator/evaluator.py:79` — `EvaluationType.NL_ASSERTIONS`
- `src/tau2/registry.py` — 所有 agent/domain/tasks 必须在此注册
- `src/tau2/data_model/tasks.py` — `Task`/`UserScenario`/`EvaluationCriteria` 等数据模型
- `src/tau2/domains/mock/` — 空壳垂域的最佳参照模板
- `data/tau2/domains/<name>/` — 垂域数据目录约定（tasks.json 等）

## 工件（不要重复其内容，按路径引用）

- **票据**：`/home/kazuha/tau2-bench/.scratch/cockpit-eval/issues/01-*.md` 至 `08-*.md`，共 8 张 tracer-bullet 票，含阻塞边与验收标准。当前 frontier：**01（黑盒 Agent HTTP 适配器）和 02（cockpit 垂域骨架）可并行开工**。
- 项目指引：`/home/kazuha/tau2-bench/AGENTS.md`

## 下一步行动

1. 从票据 01 开始：实现黑盒 Agent HTTP 适配器并注册。
2. **开工前必须向用户索取**：黑盒 Agent 的 HTTP 接口文档（URL、请求/响应 schema、鉴权方式、user_id/VIN 传参格式）——访谈中未确认这些细节。
3. 票据 02 可并行：参照 `mock` domain 建 cockpit 空壳垂域 + 3 个种子任务。
4. 完成后走 03 的端到端冒烟（`make check-all` 通过后再提交；遵循项目的 conventional commit 规范）。

## 敏感信息

访谈未涉及 API key/密码/PII。实现时如需配置鉴权凭据，提醒用户放入 `.env`（该项目约定 `.env` 永不提交）。

## Suggested skills

- `grill-me`：如实现中出现新的方案级模糊点，再次访谈拷问用户。
- `to-tickets`：如拆解需要变更（新需求/拆分/合并票据），用它维护 `.scratch/cockpit-eval/issues/` 的票据集。
- `handoff`：会话结束前若需再次交接，更新本文档。
