const fs = require("fs/promises");
const path = require("path");
const pngToIco = require("png-to-ico");

const root = path.join(__dirname, "..");
const sourcePng = path.join(root, "build", "icon.png");
const packageJsonPath = path.join(root, "package.json");
const linuxDir = path.join(root, "build", "linux");
const appId = "com.rclone.gui.glasswing";
const metainfoPath = path.join(linuxDir, `${appId}.metainfo.xml`);
const targets = [
  path.join(root, "build", "icon.ico"),
  path.join(root, "electron", "icons", "icon.ico"),
];
const pngTargets = [
  path.join(root, "src", "assets", "icon.png"),
  path.join(root, "electron", "icons", "icon.png"),
];

async function writeAppStreamMetainfo(version) {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>
  <metadata_license>MIT</metadata_license>
  <project_license>MIT</project_license>
  <name>Glasswing Rclone</name>
  <summary>Rclone GUI with live job dashboard</summary>
  <description>
    <p>Glasswing is an Electron-based Rclone GUI with a live job dashboard and modern UI.</p>
  </description>
  <launchable type="desktop-id">${appId}.desktop</launchable>
  <icon type="stock">${appId}</icon>
  <categories>
    <category>Utility</category>
  </categories>
  <provides>
    <binary>${appId}</binary>
  </provides>
  <releases>
    <release version="${version}" date="${new Date().toISOString().slice(0, 10)}"/>
  </releases>
  <content_rating type="oars-1.1"/>
</component>
`;

  await fs.mkdir(linuxDir, { recursive: true });
  await fs.writeFile(metainfoPath, content, "utf8");
  console.log(`Wrote ${metainfoPath}`);
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
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

  await writeAppStreamMetainfo(packageJson.version);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
