# PandaAI 赛道

我们正在面向金融方向的 Agent 团队公开征集参赛作品，统一采用 A2A 协议完成对接与评审，欢迎已有可用 Agent 的团队报名。

## 一句话理解 A2A

A2A 是 Agent 世界的标准接口：不同框架、不同技术栈搭建的 Agent，只要对外暴露一份 Agent Card 并支持标准消息调用，就能被统一发现、统一调用。

## 官方文档（建议先读）

- 协议首页与入门：<https://a2a-protocol.org/latest/>
- 协议规范（Specification）：<https://a2a-protocol.org/latest/specification/>
- 核心概念（Agent Card、消息、任务等）：<https://a2a-protocol.org/latest/topics/key-concepts/>
- Task 生命周期：<https://a2a-protocol.org/latest/topics/life-of-a-task/>
- 官方仓库与 v1.0.1 发布：<https://github.com/a2aproject/A2A> · <https://github.com/a2aproject/A2A/releases/tag/v1.0.1>

## 为什么统一走 A2A 评审

赛事选择统一采用 A2A，是为了让评审组可以对所有参赛作品做黑盒调用，在同一套规则下完成公平打分，并在赛后针对关键结论做证据复核，而不依赖选手自述的实现细节。

## 已有 Agent 接入并不复杂

如果你手上已经有一个能跑起来、能正常回答问题的金融 Agent，通常不需要重写核心逻辑，只需要在外层补上一份 Agent Card、一个标准消息入口，并把最终结果整理成规范返回格式即可完成对接，工作量因团队现状而异。A2A 不要求公开你内部使用的模型、提示词、工具链或工作流，这些都可以留在黑盒内部。

## 评审关注的三个维度

- 场景价值： 任务是否足够复杂？是否适合使用Agent或者多Agent实现？
- 专业性: Agent返回的结果是否足够专业？比如因子分析、回测逻辑、风险解释是否专业？
- 智能体能力： 任务理解、工具调用、推理规划、结果质量、记忆系统、返回速度等，综合考量智能体的能力。

## 最低投递清单

- 一份可被访问的 Agent Card
- 一个可被稳定调用的服务 （如果存在key）
- 至少 3 个示例任务（覆盖正常任务、信息不足、风险或失败边界）

## 欢迎的方向

无论你做的是金融研究、行情分析、因子挖掘、交易策略、风险控制、组合管理，还是事件研究，只要能以 A2A Remote Agent 的形式稳定运行，都欢迎报名参赛。
