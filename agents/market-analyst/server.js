import '../../src/env.js';
import { pathToFileURL } from 'node:url';

import { createMarketAgentServer } from './a2a-server.js';
import { marketAgentConfig } from './config.js';
import { MarketOrchestrator } from './orchestrator.js';

export function startMarketAgentServer(options = {}) {
  const config = options.config || marketAgentConfig();
  const orchestrator = options.orchestrator || new MarketOrchestrator(config);
  const server = createMarketAgentServer({ ...options, config, orchestrator });
  server.listen(config.port, config.host, () => {
    console.log(
      `Panda Market Analyst listening at http://${config.host}:${config.port}`
    );
  });
  return server;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) startMarketAgentServer();
