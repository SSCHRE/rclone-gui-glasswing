const fs = require("fs/promises");
const path = require("path");
const pngToIco = require("png-to-ico");
const { readPNG, resize } = require("png-to-ico/lib/png");
const { PNG } = require("pngjs");

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
const linuxIconDir = path.join(root, "build", "icons");
const linuxIconSizes = [16, 24, 32, 48, 64, 128, 256, 512];

function scaleTo(source, size) {
  let image = source;
  while (image.width >= size * 2) {
    image = resize(image, Math.round(image.width / 2), Math.round(image.height / 2));
  }
  return image.width === size ? image : resize(image, size, size);
}

async function writeLinuxIcons() {
  const source = await readPNG(sourcePng);
  await fs.mkdir(linuxIconDir, { recursive: true });
  for (const size of linuxIconSizes) {
    const target = path.join(linuxIconDir, `${size}x${size}.png`);
    await fs.writeFile(target, PNG.sync.write(scaleTo(source, size)));
    console.log(`Wrote ${target}`);
  }
}

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

  await writeLinuxIcons();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
