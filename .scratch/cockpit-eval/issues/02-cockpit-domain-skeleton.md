# 02: cockpit 垂域骨架

**What to build:** 新建 `cockpit` 垂域：空壳环境（无 DB 状态断言，操作打在真实测试后端）、3 个手写种子任务、注册 domain 与 tasks，使 `tau2 check-data` 通过且任务列表可见。种子任务需覆盖：一个单轮车控指令、一个车况查询、一个带曲折的两轮交互。

**Blocked by:** None（可立即开始，与 01 并行）

**Status:** ready-for-agent

- [ ] 垂域定义可被 registry 识别，`tau2` CLI 可选到该 domain
- [ ] 3 个种子任务（单轮车控 / 车况查询 / 两轮曲折）结构合法，`tau2 check-data` 通过
- [ ] 种子任务的 user_scenario 含指令 + persona（user_id/VIN + 画像生成的限定范围）
- [ ] 任务 `reward_basis` 仅含 `nl_assertions`
