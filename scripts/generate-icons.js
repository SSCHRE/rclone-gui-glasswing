const fs = require("fs/promises");
const path = require("path");
const pngToIco = require("png-to-ico");

const root = path.join(__dirname, "..");
const sourcePng = path.join(root, "build", "icon.png");
const targets = [
  path.join(root, "build", "icon.ico"),
  path.join(root, "electron", "icons", "icon.ico"),
];
const pngTargets = [
  path.join(root, "src", "assets", "icon.png"),
  path.join(root, "electron", "icons", "icon.png"),
];

async function main() {
  const ico = await pngToIco(sourcePng);

  for (const target of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, ico);
    console.log(`Wrote ${target}`);
  }

  for (const target of pngTargets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(sourcePng, target);
    console.log(`Wrote ${target}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
