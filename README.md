<div align="center">

# AmpCore

**Set up and control networked DSP power amps from your laptop or phone.**

[![Latest release](https://img.shields.io/github/v/release/OpenAmpCore/ampcore?label=latest&sort=semver)](https://github.com/OpenAmpCore/ampcore/releases/latest)
[![Release date](https://img.shields.io/github/release-date/OpenAmpCore/ampcore?label=released)](https://github.com/OpenAmpCore/ampcore/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/OpenAmpCore/ampcore/total?label=downloads)](https://github.com/OpenAmpCore/ampcore/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/OpenAmpCore/ampcore/release.yml?branch=main&label=build)](https://github.com/OpenAmpCore/ampcore/actions/workflows/release.yml)

[![Download for Windows](https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/OpenAmpCore/ampcore/releases/latest)
[![Download for macOS](https://img.shields.io/badge/Download-macOS-555555?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/OpenAmpCore/ampcore/releases/latest)
[![Download for Android](https://img.shields.io/badge/Download-Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/OpenAmpCore/ampcore/releases/latest)

</div>

AmpCore finds the amps on your network, shows what they're doing live, and lets you change their settings. You can
also plan a whole rig before the gig and send it to the amps on site. It's a replacement for the vendor's Windows tool.

**Works with:** CVR DSP amplifiers (DSP-654 up to DSP-4302), firmware 1.1.8 and 1.1.9.

| | Desktop | Mobile |
|---|---|---|
| Platforms | Windows, macOS | Android |
| Find amps, live meters and health | ✓ | ✓ |
| Mute, volume, EQ, delay, presets | ✓ | ✓ |
| Full EQ, FIR, limiter and matrix editors | ✓ | |
| Offline projects and speaker library | ✓ | |

## Getting started

1. Download the installer for your system from the [latest release](https://github.com/OpenAmpCore/ampcore/releases/latest).
2. Connect your computer or phone to the same network as the amps.
3. Open AmpCore. The amps show up on their own.

<details>
<summary>macOS or Android won't open it?</summary>

- **macOS:** the app isn't signed yet. Right-click it and choose **Open**, or run `xattr -cr /Applications/AmpCore.app`.
- **Android:** the APK is a debug build, so allow installs from unknown sources.

</details>

<details>
<summary>Good to know</summary>

- A hardware preset brings back the selected input source, but not that source's trim and delay.
- Amps on firmware 1.1.8 don't report their gain, so Gain and SEN show "—".

</details>

## For developers

<details>
<summary>Build from source</summary>

You need Rust (stable), Node (LTS) and [pnpm](https://pnpm.io). Use pnpm, not npm.

```sh
pnpm install

cd apps/desktop
pnpm preview        # run the desktop app
pnpm build:app      # build the installer

cd apps/mobile      # needs the Android SDK + NDK
pnpm exec tauri android dev
```

Checks:

```sh
cargo test --workspace
cd apps/desktop && pnpm typecheck
```

| Folder | What's in it |
|---|---|
| `crates/ampcore-core` | Amp protocol, DSP math, project model. Shared by both apps |
| `apps/desktop` | Desktop app (Tauri + React) |
| `apps/mobile` | Mobile app (Tauri + React) |

</details>

Found a setting that reads back wrong on your amp? [Open an issue](https://github.com/OpenAmpCore/ampcore/issues) and
include the amp model and firmware.
