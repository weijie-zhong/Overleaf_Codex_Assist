const path = require('path');
const { spawn } = require('child_process');

let electronBinary = '';
try {
  electronBinary = require('electron');
} catch (err) {
  console.error(`Failed to resolve electron binary: ${err.message}`);
  process.exit(1);
}

const entryPoint = path.join(__dirname, 'main.js');
const env = { ...process.env };

// Ensure Electron starts in app mode even if parent shells export this flag.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [entryPoint], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(`Failed to launch desktop app: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
