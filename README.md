# dsh-rewind

DSH 的按轮回退插件。每轮开始时记下工作区里符合条件的文件，放在工作区外面；对话回退会另开一个会话，不截断原来的记录。

不把快照写进用户仓库的 Git 对象。回退到某一轮，会把之后的手改、脚本改动和文件工具改动撤回到那一轮开始时。生成目录、符号链接、硬链接，以及超过大小或数量上限的文件不会动。

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

插件详情页（插件列表里打开 `dsh-rewind`）显示这些项，改完立刻作用到正在运行的引擎上。设置面板里不再有这一页。

| 项 | 默认 | 作用 |
| --- | --- | --- |
| `skipGenerated` | 开 | 跳过 `node_modules`、`.git`、`dist`、`coverage`、`.dsh` |
| `captureExternal` | 开 | 每轮开始时记下工作区。两轮之间的手改和脚本改动，回退到较早的一轮时撤掉 |
| `captureSubagents` | 开 | 子代理的文件工具算到父会话当前轮 |
| `shellPolicy` | `gap` | `gap` 标明跑过命令；`ignore` 不标明。命令本身不另做快照，文件仍回到回合开始时的内容 |
| `conflictPolicy` | `ask` | `ask` 需勾选，`skip` 跳过，`overwrite` 覆盖 |
| `restoreCreatedFiles` | 开 | 回退时删除这一轮新建的文件 |
| `putPromptInComposer` | 开 | 回退对话后把原话放回新会话输入框 |
| `blockWhileAgentsRun` | 开 | 同一工作区还有代理在跑时不允许改文件 |
| `retentionDays` | 30 | `0` 表示不按天数删除 |
| `maxStorageBytes` | 2 GiB | 全部会话加在一起的字节上限，至少保留一轮。页面按 MiB 填写 |
| `maxStoredTurns` | 1000 | 全部会话加在一起保留的轮数 |

同一命名空间里还有这些项，页面不显示，默认值继续生效，只能在配置层改：`enabled`、`shellTools`、`extraFileTools`、`pathFields`、`excludeGlobs`、`maxFileBytes`、`maxSnapshotFiles`（默认 2000，扫满后不再删除没扫到的文件）、`maxCheckpointsPerSession`、`maxSessionBytes`、`allowOutsideWorkspace`、`previewTrust`、`maxPreviewFiles`、`staleLockMs`、`originCheck`、`storageDir`。

## 开发

```bash
pnpm install
pnpm test
```

测试覆盖文件工具的修改前记录、失败工具不记账、命令缺口、冲突、新建文件、排除路径、符号链接父目录、保留策略、两轮之间的手改和脚本改动，以及中断回退后的启动补偿。
