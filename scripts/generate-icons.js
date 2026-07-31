const fs = require("fs/promises");
const path = require("path");
const pngToIco = require("png-to-ico");
const sanitizeFileName = require("sanitize-filename");

const root = path.join(__dirname, "..");
const sourcePng = path.join(root, "build", "icon.png");
const packageJsonPath = path.join(root, "package.json");
const linuxDir = path.join(root, "build", "linux");
const appId = "com.rclone.gui.glasswing";
const metainfoPath = path.join(linuxDir, `${appId}.metainfo.xml`);
const debAfterInstallPath = path.join(linuxDir, "deb-after-install.sh");
const targets = [
  path.join(root, "build", "icon.ico"),
  path.join(root, "electron", "icons", "icon.ico"),
];
const pngTargets = [
  path.join(root, "src", "assets", "icon.png"),
  path.join(root, "electron", "icons", "icon.png"),
];

function bashSingleQuoteEscape(value) {
  return value.replace(/'/g, "'\\''");
}

async function writeDebAfterInstall(executable, sanitizedProductName) {
  const exec = bashSingleQuoteEscape(executable);
  const productDir = bashSingleQuoteEscape(sanitizedProductName);
  const installRoot = `/opt/${productDir}`;

  const content = `#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${exec}' -a -e '/usr/bin/${exec}' -a "\`readlink '/usr/bin/${exec}'\`" != '/etc/alternatives/${exec}' ]; then
        rm -f '/usr/bin/${exec}'
    fi
    update-alternatives --install '/usr/bin/${exec}' '${exec}' '${installRoot}/${exec}' 100 || ln -sf '${installRoot}/${exec}' '/usr/bin/${exec}'
else
    ln -sf '${installRoot}/${exec}' '/usr/bin/${exec}'
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '${installRoot}/chrome-sandbox' || true
else
    chmod 0755 '${installRoot}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='${installRoot}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${exec}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
`;

  await fs.mkdir(linuxDir, { recursive: true });
  await fs.writeFile(debAfterInstallPath, content, "utf8");
  console.log(`Wrote ${debAfterInstallPath}`);
}

async function writeAppStreamMetainfo(version, executable) {
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
  <icon type="stock">${executable}</icon>
  <categories>
    <category>Utility</category>
  </categories>
  <provides>
    <binary>${executable}</binary>
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
  const productName = packageJson.build?.productName || packageJson.name;
  const executable =
    packageJson.build?.linux?.executableName || sanitizeFileName(productName);
  const sanitizedProductName = sanitizeFileName(productName);
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

  await writeAppStreamMetainfo(packageJson.version, executable);
  await writeDebAfterInstall(executable, sanitizedProductName);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
