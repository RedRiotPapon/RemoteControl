const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Copy renderer HTML and CSS to dist
const srcDir = path.join(__dirname, 'src', 'renderer');
const distDir = path.join(__dirname, 'dist', 'renderer');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy HTML
fs.copyFileSync(path.join(srcDir, 'index.html'), path.join(distDir, 'index.html'));

// Copy CSS
if (fs.existsSync(path.join(srcDir, 'styles.css'))) {
  fs.copyFileSync(path.join(srcDir, 'styles.css'), path.join(distDir, 'styles.css'));
}

// Copy JS (no bundling needed for vanilla JS renderer)
if (fs.existsSync(path.join(srcDir, 'app.js'))) {
  fs.copyFileSync(path.join(srcDir, 'app.js'), path.join(distDir, 'app.js'));
}

console.log('Renderer files copied to dist/renderer/');
