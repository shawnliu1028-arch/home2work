# 03: 首次端到端冒烟跑

**What to build:** 第一条完整穿膛的示踪弹：3 个种子任务各跑 1 个 trial，使用 tau2 内置的 NL 断言判分（LLM judge 对照原子断言打二元分），产出带分数的轨迹并可用 `tau2 view` 浏览。每个种子任务的期望结果拆为 3~6 条可独立判 True/False 的原子断言（例：「Agent 声明已将空调温度设置为 22 度」而非「成功处理了请求」）。此票同时验证断言措辞写法，为 04 的流水线定调。

**Blocked by:** 01（黑盒 Agent HTTP 适配器）、02（cockpit 垂域骨架）

**Status:** ready-for-agent

- [ ] 种子任务的期望结果全部拆为原子 NL 断言并写入任务
- [ ] LLM 用户模拟器成功驱动黑盒 Agent 完成多轮对话（需喂 persona/指令）
- [ ] 判分产出 RewardInfo，断言逐条给出 met/not met
- [ ] 轨迹保存并在 `tau2 view` 中可浏览
- [ ] 人工复核 3 条轨迹的 judge 结论，记录断言措辞的试错结论供 04 复用
