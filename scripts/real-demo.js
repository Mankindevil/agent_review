process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
const { startExampleAgents } = await import('../examples/agents/server.js');
const agents = await startExampleAgents();
console.log('三个真实 A2A 示例已就绪：', agents.map((agent) => agent.origin).join(' · '));
await import('../server.js');
