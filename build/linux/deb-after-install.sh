#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/glasswing-rclone' -a -e '/usr/bin/glasswing-rclone' -a "`readlink '/usr/bin/glasswing-rclone'`" != '/etc/alternatives/glasswing-rclone' ]; then
        rm -f '/usr/bin/glasswing-rclone'
    fi
    update-alternatives --install '/usr/bin/glasswing-rclone' 'glasswing-rclone' '/opt/Glasswing Rclone/glasswing-rclone' 100 || ln -sf '/opt/Glasswing Rclone/glasswing-rclone' '/usr/bin/glasswing-rclone'
else
    ln -sf '/opt/Glasswing Rclone/glasswing-rclone' '/usr/bin/glasswing-rclone'
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/Glasswing Rclone/chrome-sandbox' || true
else
    chmod 0755 '/opt/Glasswing Rclone/chrome-sandbox' || true
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
  APPARMOR_PROFILE_SOURCE='/opt/Glasswing Rclone/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/glasswing-rclone'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
