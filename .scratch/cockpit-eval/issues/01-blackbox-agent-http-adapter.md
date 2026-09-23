# 01: 黑盒 Agent HTTP 适配器

**What to build:** 将已部署的智能座舱黑盒 Agent 接入 tau2 半双工框架：实现一个注册为 tau2 agent factory 的 `HalfDuplexAgent` 子类，把 tau2 的 UserMessage 转发为 HTTP 请求（单条用户消息 + user_id/VIN 身份参数），并将 HTTP 响应包装为合法的 `AssistantMessage` 返回。若响应含结构化动作执行结果（如 `{"action": ..., "status": ...}`），必须拼进 AssistantMessage 文本——这是后续 LLM judge 判断"是否正确调用工具"的唯一证据。tools 传空列表（工具调用全部发生在黑盒内部），完成后可用一条真实消息手动验证适配器产出合法消息。

**Blocked by:** None（可立即开始）

**Status:** ready-for-agent

- [ ] 实现适配器类：UserMessage + 身份参数（user_id/VIN）→ HTTP 单条消息调用 → AssistantMessage（纯文本，无 tool_calls）
- [ ] 适配器注册到 registry，`tau2` CLI 可选到该 agent
- [ ] 响应中的结构化执行结果被透传进 AssistantMessage 文本
- [ ] 用一条真实消息对部署好的服务做手动冒烟验证，产出合法 AssistantMessage
- [ ] HTTP 超时/错误处理：异常不炸编排器，转为可观测的错误消息
