# Third-party components

Jokerdeck Switch bundles these independent MIT-licensed programs:

- `shibaweidu/codex-desktop-zh` v0.7.7, https://github.com/shibaweidu/codex-desktop-zh. Source is vendored under `third_party/codex-desktop-zh` with a local proxy argument patch and rebuilt for macOS and Windows. The original release SHA-256 values are: Windows `7947636309b1b3a0f642365834532403a7dd08233f076570446f486f4dc54381`; macOS arm64 ZIP `21cda855caea9c179a99f21e665636a9ce9d4dbe9aada6e57dd2c546388612df`; macOS x64 ZIP `57f0559fcf4761ff55192fd1e85aff1d79b2f4d35ef7f67a7889d7397590de3c`.
- `QwenLM/open-computer-use` v0.2.3, https://github.com/QwenLM/open-computer-use, distributed through `@qwen-code/open-computer-use`. The package includes native macOS and Windows runtimes. npm integrity: `sha512-Cnoofoc/1sx0zaXvktbm6mOLPlw1w3tF++KREO4gBR1VM+Oy+ZYRgkoAjY3ckhGqPywDyHLv+2iq1gfDowU08Q==`.
- `MetaCubeX/mihomo` v1.19.32, https://github.com/MetaCubeX/mihomo. The macOS arm64, macOS x64 and Windows x64 runtimes are downloaded at build time and verified against SHA-256 values in `scripts/fetch-proxy-core.mjs`.

Their license texts are in `vendor/LICENSE-codex-desktop-zh`, `vendor/LICENSE-open-computer-use` and `vendor/LICENSE-mihomo`. These integrations do not grant official Codex or Computer Use account entitlements.
