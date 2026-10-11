const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');

console.log('========================================');
console.log('ParallelBrowser - Building Installers');
console.log('========================================\n');

function run(cmd, cwd = rootDir) {
  console.log(`> [${path.basename(cwd)}] ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

try {
  // 1. Build Shared
  console.log('\n[1/4] Building Shared library...');
  run('npm run build', path.join(rootDir, 'shared'));

  // 2. Build Host App
  console.log('\n[2/4] Building Host Application...');
  run('npm run build', path.join(rootDir, 'host-app'));

  // 3. Build Client App
  console.log('\n[3/4] Building Client Application...');
  run('npm run build', path.join(rootDir, 'client-app'));

  // 4. Run Automated Test Suite
  console.log('\n[4/4] Running Test Suite...');
  run('npm test', rootDir);

  console.log('\n========================================');
  console.log('Build and verification successful!');
  console.log('To package NSIS installers, run:');
  console.log('  npm run dist:all');
  console.log('========================================');
} catch (error) {
  console.error('\nBuild failed:', error.message);
  process.exit(1);
}
