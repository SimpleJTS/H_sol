# Sol Sniper - Solana 极速交易 Chrome 插件

极速 Solana Token 交易插件，支持预加载交易，一键买入/卖出。

## 功能特点

- 🚀 **极速交易** - 预加载交易数据，点击即交易
- 🎯 **悬浮窗口** - 可拖动、可调整大小
- 🔐 **安全存储** - AES-256-GCM 加密私钥
- ⚡ **预设按钮** - 自定义买入/卖出金额

## 安装

### 1. 构建插件

```bash
npm install
npm run build
```

### 2. 加载到 Chrome

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角 "开发者模式"
3. 点击 "加载已解压的扩展程序"
4. 选择 `dist` 目录

## 配置

首次使用需要配置：

1. 点击插件图标打开设置页面
2. 输入 Helius API Key（免费获取：https://helius.dev）
3. 导入钱包私钥（Base58 格式）
4. 设置密码保护
5. 自定义买入/卖出预设

## 使用

1. 在任意网页，右下角会出现悬浮窗
2. 输入 Token CA（合约地址）
3. 等待状态变为 "Ready"
4. 点击预设按钮即时交易

## 技术架构

```
├── background/     # Service Worker (交易引擎)
│   ├── helius.ts   # Helius RPC 客户端
│   ├── jupiter.ts  # Jupiter 聚合器
│   └── wallet.ts   # 钱包管理
├── content/        # 悬浮窗 UI
├── popup/          # 设置页面
└── shared/         # 共享模块
```

## API 使用

- **Helius** - RPC 节点、余额查询、交易发送
- **Jupiter** - DEX 聚合、最优价格路由

## 安全警告

⚠️ **重要安全提示**：

- 私钥存储在本地，使用 AES-256-GCM 加密
- 仅用于小额交易，不建议存储大量资金
- 定期备份私钥
- 使用强密码

## 开发

```bash
# 开发模式（自动重建）
npm run dev

# 生产构建
npm run build

# 清理
npm run clean
```

## License

MIT
