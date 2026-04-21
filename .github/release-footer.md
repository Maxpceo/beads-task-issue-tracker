## Requirements

> **Requires bd 1.0.x** (the current stable line). The app auto-detects the installed bd version at runtime and adapts to both the 0.57+ self-managing Dolt server and the 1.0 review chain. Older bd (≤ 0.56) is not supported.

## Installation

| Platform | File | Notes |
|----------|------|-------|
| **macOS (Apple Silicon M1/M2/M3)** | `*_macOS-ARM64.dmg` | For Mac 2020+ |
| **macOS (Intel)** | `*_macOS-Intel.dmg` | For Mac pre-2020 |
| **Windows** | `*_Windows.msi` | Recommended installer |
| **Linux (Debian/Ubuntu)** | `*_Linux-amd64.deb` | Recommended for Debian 12+, Ubuntu 22+ |
| **Linux (other)** | `*_Linux-amd64.AppImage` | Requires `libfuse2` |

### macOS — unsigned app workaround

This app is **not signed with an Apple Developer certificate**. On first launch macOS will show *"Apple cannot verify this developer"* and refuse to open the app. After dragging the app to `/Applications`, run this in Terminal once:

```bash
xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
```

This strips the quarantine attribute Gatekeeper adds to downloaded files. The app will then launch normally.
