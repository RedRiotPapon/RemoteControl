const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src', 'renderer');
const distDir = path.join(__dirname, 'dist', 'renderer');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

function copyRecursive(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

copyRecursive(srcDir, distDir);
console.log('Renderer assets copied to dist/renderer');
