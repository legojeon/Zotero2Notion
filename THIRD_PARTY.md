# Sources and third-party material

The implementation was informed by these projects and official documentation. Their full source is not bundled as a fork or runtime dependency:

- [Notero](https://github.com/dvanoni/notero): event handling, Zotero settings registration, and credential storage patterns.
- [zotero2notion](https://github.com/nsalminen/zotero2notion): linking pages with source item keys.
- [ZoteroToNotion](https://github.com/nanbhas/ZoteroToNotion): comparison with a local database approach.
- [Zotero developer documentation](https://www.zotero.org/support/dev/zotero_10_for_developers).
- [Notion API documentation](https://developers.notion.com/).

## Paper figures

The following images are excerpts from the cited papers, included with attribution in educational worked examples. They are **not covered by this repository’s MIT license**; rights remain with their respective owners.

| Asset | Source |
|---|---|
| `examples/assets/transformer-architecture.png` | Vaswani et al., *Attention Is All You Need*, Figure 1, [NeurIPS 2017](https://papers.neurips.cc/paper/7181-attention-isall-you-need.pdf) |
| `examples/assets/resnet-architecture.png` | He et al., *Deep Residual Learning for Image Recognition*, Figure 3, [arXiv:1512.03385v1](https://arxiv.org/pdf/1512.03385v1) |
| `examples/assets/resnet-residual-block.png` | He et al., *Deep Residual Learning for Image Recognition*, Figure 2, [arXiv:1512.03385v1](https://arxiv.org/pdf/1512.03385v1) |

Original PDFs are not distributed. Zotero and Notion names and marks belong to their respective owners; use here does not imply endorsement.

## Build dependencies

esbuild is a development dependency under the MIT license. Its license is installed at `node_modules/esbuild/LICENSE.md`. The esbuild executable is not included in the plugin XPI.
