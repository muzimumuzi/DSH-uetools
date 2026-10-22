# Third-party notices

This package bundles third-party material that is **not** covered by the
package's own BSD-3-Clause license.

## UnrealAgentLink editor plugin (precompiled binaries + interface documents)

- Source project: https://github.com/ueboxai/uebox — directory `plugin/UnrealAgentLink`
- Copyright: uebox.ai
- License: Apache License 2.0 (full text: [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt))
- Bundled artifacts:
  - `assets/plugins/UnrealAgentLink50.zip` … `UnrealAgentLink58.zip` — the compiled
    Unreal Editor plugin for Unreal Engine 5.0 through 5.8 (Win64), including its
    content and binaries.
  - `assets/docs/*.md` — the plugin's interface documentation.
  - `assets/methods.json` — the command method list extracted from the plugin's
    C++ command registry.

These files are redistributed unmodified. The package installs them into the
user's Unreal Engine project; they are not linked into this package's own code.

## Runtime dependencies

None. The plugin's JavaScript imports only Node.js built-in modules
(`node:fs`, `node:http`, `node:path`, `node:url`, `node:crypto`, `node:util`,
`node:zlib`). No npm package is required at runtime.

## What this package does not include

- Unreal Engine itself.
- The Unreal Box desktop application (`unreal-agent`); this package never runs it
  and does not require it.
