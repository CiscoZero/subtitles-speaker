# 译声机 EchoTape

把带中文字幕的音频变成「原声 + 中文朗读」的伴听卡带机：播放到某句字幕 → 暂停原声 → 用系统中文语音读这句 → 读完继续原声。全部在本机完成，不上传任何文件。

## 网页版

```bash
npm install
npm run dev
```

建议用 Microsoft Edge / Chrome，朗读使用系统语音（Windows 设置 → 时间和语言 → 语音 → 中文（简体））。

## 桌面版 / 打包 .exe

`desktop/` 是一套独立的 Electron 打包工程，可以把网页版变成 Windows 桌面应用并产出安装包与便携版 `.exe`：

```bat
cd desktop
npm install
npm run check-voice
npm run dist
```

细节（为什么桌面版要走 SAPI 桥、脚本说明、常见问题）见 [desktop/README.md](desktop/README.md)。
