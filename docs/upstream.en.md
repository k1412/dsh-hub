# Upstream and third-party attribution

English | [中文](upstream.md)

DSH Hub is an independently maintained community project. It is not an official DeepSeek product and does not represent the DeepSeek Harness release plan or support commitment.

## DeepSeek Harness

This project integrates with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through public Cordis plugin interfaces, Host APIs, and a reviewed Web build snapshot. Its exact upstream commit, Hub compatibility commit, browser-plugin roster, and reproducible source patch live in `third_party/official-web`. A Hub Release never loads or executes frontend JavaScript uploaded by a node at runtime.

The repository no longer carries a complete mirror of the DeepSeek Harness source tree. This keeps Hub review, Issues, Releases, and security ownership focused on code maintained by this project while retaining the complete official Web interaction through a pinned artifact. A snapshot update must pin the new upstream commit, regenerate the source patch and roster, and pass Hub unit and component tests, concurrent multi-node tests, production-CSP boot, desktop browser checks, and 390px mobile checks, with compatibility changes recorded.

DeepSeek Harness and its npm packages are distributed under the MIT License. Their copyright and trademarks remain with their respective owners. This project's MIT License does not grant a right to use the DeepSeek name, logos, or other marks to imply official endorsement.

## Project-owned code

The `@k1412/dsh-hub-*` packages, Hub Web composition entry, installers, deployment files, and Hub documentation are maintained by this project and released under the [MIT License](../LICENSE). Dependency licenses and notices that must accompany distributions are collected in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Please open an Issue for missing attribution, a license conflict, or confusing branding. Report security-sensitive findings privately according to [SECURITY.md](../SECURITY.md).
