# dsh-rewind

DSH 的按轮回退插件。它只保存文件工具改动前的内容，放在工作区外面；对话回退会另开一个会话，不截断原来的记录。

不把快照写进用户仓库的 Git 对象，也不把整棵工作区扫一遍。`shell`、`run_code` 和手改的文件不会被自动撤掉，界面会标明这一点。

## 安装

这是一个 DSH Profile Bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `dsh-rewind`。安装消费已经构建好的 `lib/`，不要改 DSH 主仓库，也不要重新构建 Web 壳。客户端从包的 `./client` 入口加载。

命令行 profile 用 `dsh plugin`，它和界面里的插件管理走同一套 pnpm 事务。本地目录可以是相对路径或绝对路径：

```sh
dsh plugin --profile web add G:\Code\DSH\dsh-rewind
dsh --profile web --dump-config
```

`desktop` 这个名字由 Electron 独占，`dsh plugin --profile desktop` 会被拒绝。在正在运行的桌面端里，打开插件页，把绝对路径交给安装框。不要手改 `$DSH_HOME/profiles/desktop/package.json`。新组合包会进入 `dsh.profile.bundles`。链接到配置目录外的检出要等进程重新建立解析表之后才能导入 peer；第一次启用若报 `failed to import`，完全退出并重新打开桌面端，再启用一次。已经装过的同一依赖被替换时同样需要重启进程。

存储默认在 `$DSH_HOME/rewind/v1`，没有该变量时用 `~/.dsh/rewind/v1`。`storageDir` 只写在配置层，运行中不能改。

## 设置

设置卡片和 `dsh-rewind` 命名空间里这些项都会立刻作用到正在运行的引擎上：

| 项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | 开 | 关闭后不再记录新改动，旧记录仍可回退 |
| `captureSubagents` | 开 | 子代理的文件工具算到父会话当前轮 |
| `shellPolicy` | `gap` | `gap` 标明跑过命令；`ignore` 不标明。都不做命令快照 |
| `shellTools` | `bash,shell,run_code,terminal` | 这些工具只记缺口 |
| `extraFileTools` | 空 | 额外按路径参数记录的工具名 |
| `pathFields` | `file_path,path` | 额外工具的路径参数名 |
| `excludeGlobs` | 空 | 每行一个 glob，匹配的路径不记录 |
| `skipGenerated` | 开 | 另外跳过 `node_modules`、`.git`、`dist`、`coverage`、`.dsh` |
| `maxFileBytes` | 8 MiB | 更大的文件只记缺口 |
| `maxCheckpointsPerSession` | 100 | 每个会话保留的最新条数 |
| `retentionDays` | 30 | `0` 表示不按天数删除 |
| `maxSessionBytes` | 512 MiB | 单个会话超出后从最旧的记录丢 |
| `maxStorageBytes` | 2 GiB | 全部会话加在一起的字节上限，至少保留一轮 |
| `maxStoredTurns` | 1000 | 全部会话加在一起保留的轮数 |
| `conflictPolicy` | `ask` | `ask` 需勾选，`skip` 跳过，`overwrite` 覆盖 |
| `restoreCreatedFiles` | 开 | 回退时删除这一轮新建的文件 |
| `blockWhileAgentsRun` | 开 | 同一工作区还有代理在跑时不允许改文件 |
| `allowOutsideWorkspace` | 关 | 是否记录并回退工作区外的路径 |
| `previewTrust` | `content` | `metadata` 只在大小和修改时间都没变时少读一次 |
| `putPromptInComposer` | 开 | 回退对话后把原话放回新会话输入框 |
| `maxPreviewFiles` | 200 | 对话框最多显示的行数，指纹仍覆盖全部路径 |
| `staleLockMs` | 30000 | 锁的持有进程已经退出并超过这个时间后才可抢走 |
| `originCheck` | `same-origin` | 拒绝跨站回退请求 |

## 开发

```bash
pnpm install
pnpm test
```

测试覆盖文件工具的修改前记录、失败工具不记账、命令缺口、冲突、新建文件、排除路径、符号链接父目录、保留策略，以及中断回退后的启动补偿。
