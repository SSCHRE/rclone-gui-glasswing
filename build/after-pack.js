const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const dir = path.join(
    context.appOutDir,
    'resources', 'app.asar.unpacked', 'node_modules', '7zip-bin', 'linux'
  );
  if (!fs.existsSync(dir)) return;

  for (const arch of fs.readdirSync(dir)) {
    const bin = path.join(dir, arch, '7za');
    if (fs.existsSync(bin)) {
      fs.chmodSync(bin, 0o755);
      console.log(`afterPack: chmod 755 ${bin}`);
    }
  }
};