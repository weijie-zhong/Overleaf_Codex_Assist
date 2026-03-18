const { startBridge } = require('./bridge');

const bridgePort = Number(process.env.BRIDGE_PORT) || 8787;

startBridge({ port: bridgePort })
  .then((bridge) => {
    console.log(`Proxy listening on http://localhost:${bridge.port}`);
    console.log(`Using Codex CLI binary: ${bridge.codexBin}`);
  })
  .catch((err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`Failed to start proxy bridge: ${message}`);
    process.exit(1);
  });
