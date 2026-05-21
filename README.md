# Shouji Diannao

Shouji Diannao keeps your notes in sync between your phone and your computer —
convenient, fast, and secure. Your notes stay consistent across devices in real
time, with no third-party cloud drive and no complex configuration.

## Features

- **Convenient** — Pair devices with a one-time dynamic code. Enter the code
  once on a new device to pair it; after that, syncing runs automatically with
  no repeated sign-in.
- **Fast** — Multiple data centers across mainland China. The client
  automatically connects to the lowest-latency data center, so domestic access
  needs no VPN.
- **Secure** — Bitcoin-grade encryption. Notes are protected with
  elliptic-curve key exchange and AES encryption. The keys never leave your
  devices, so the server cannot read your note content.

## Installation

### Manual installation (recommended)

1. Download the latest `main.js` and `manifest.json` from the
   [Releases](https://github.com/notesynchelper/shoujidiannao/releases) page.
2. In your vault, create the folder
   `<your-vault>/.obsidian/plugins/shoujidiannao/`.
3. Place the downloaded `main.js` and `manifest.json` into that folder.
4. Restart Obsidian, open **Settings → Community plugins**, and enable
   **Shouji Diannao** in the installed plugins list.

## Usage

1. After enabling the plugin, open **Settings → Shouji Diannao**.
2. **First device**: sign in to create your sync library automatically.
3. **Additional devices**: generate a dynamic code on an already-paired device,
   then enter that code on the new device to pair it.
4. Once paired, the plugin starts syncing automatically; note changes then
   propagate between devices in real time.

## Build from source

```bash
git clone https://github.com/notesynchelper/shoujidiannao.git
cd shoujidiannao
npm install
npm run build      # produces main.js
```

Copy the build output `main.js` together with `manifest.json` into
`<your-vault>/.obsidian/plugins/shoujidiannao/` to use it.

## Compatibility

- Requires Obsidian `1.4.0` or higher.
- In the current version (0.0.4), the encryption module depends on the desktop
  runtime, so desktop Obsidian is recommended. Full mobile support will arrive
  in a later version.

## License

[MIT](./LICENSE)
