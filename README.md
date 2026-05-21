# Shouji Diannao

Shouji Diannao is an Obsidian plugin that synchronizes your notes between phone and computer.

---

我们新做了一个 Obsidian 手机电脑同步插件 —— **方便、快速、安全**。

让你的笔记在手机和电脑之间实时保持一致，不依赖第三方网盘，不需要复杂配置。

## 三个特点

- **方便** —— 动态码绑定后就能开始同步。新设备上输入一次动态码完成配对，之后自动同步，无需反复登录。
- **快速** —— 大陆地区多机房就近接入。客户端自动选择延迟最低的机房，国内访问无需翻墙。
- **安全** —— 跟比特币一样的加密强度。基于椭圆曲线密钥协商与 AES 加密，密钥只在你的设备上，服务器无法读取你的笔记内容。

## 安装

### 手动安装（推荐）

1. 到 [Releases](https://github.com/notesynchelper/shoujidiannao/releases) 下载最新版本的 `main.js` 和 `manifest.json`。
2. 在你的 vault 里创建目录：`<你的vault>/.obsidian/plugins/shoujidiannao/`。
3. 把下载的 `main.js`、`manifest.json` 两个文件放进该目录。
4. 重启 Obsidian → 打开「设置 → 第三方插件」→ 在已安装插件列表里启用 **Shouji Diannao**。

## 使用

1. 启用插件后，打开「设置 → Shouji Diannao」。
2. **首台设备**：完成账号登录，自动创建你的同步库。
3. **新增设备**：在已绑定的设备上生成动态码，在新设备上输入该动态码完成配对。
4. 配对成功后插件自动开始同步，之后笔记改动会在设备间实时传播。

## 从源码构建

```bash
git clone https://github.com/notesynchelper/shoujidiannao.git
cd shoujidiannao
npm install
npm run build      # 产出 main.js
```

构建产物 `main.js` 与 `manifest.json` 一起放进
`<你的vault>/.obsidian/plugins/shoujidiannao/` 即可使用。

## 兼容性

- 需要 Obsidian `1.4.0` 或更高版本。
- 当前版本（0.0.1）的加密模块依赖桌面端运行时，建议在桌面端 Obsidian 上使用；
  手机端完整支持将在后续版本提供。

## 许可证

[MIT](./LICENSE)

---

## About

It pairs new devices with a one-time dynamic code, connects through the
nearest data center in mainland China, and encrypts every note end-to-end —
so only you ever hold the keys to your own notes.
