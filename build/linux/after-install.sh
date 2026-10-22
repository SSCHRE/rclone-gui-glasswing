#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if [ -f /etc/apparmor.d/abi/4.0 ] && hash apparmor_parser 2>/dev/null; then
    cat > '/etc/apparmor.d/${executable}' <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile ${executable} /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
PROFILE
    apparmor_parser --replace --write-cache --skip-read-cache '/etc/apparmor.d/${executable}' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
