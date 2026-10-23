#!/bin/bash

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# Only drop the AppArmor profile on a real uninstall, not during an upgrade.
if [ "$1" = "remove" ] || [ "$1" = "purge" ] || [ "$1" = "0" ]; then
    if [ -f '/etc/apparmor.d/${executable}' ]; then
        if hash apparmor_parser 2>/dev/null; then
            apparmor_parser --remove '/etc/apparmor.d/${executable}' 2>/dev/null || true
        fi
        rm -f '/etc/apparmor.d/${executable}'
    fi
fi
