# dsh-workspace-write-extra

[English](README.md) | 简体中文

为 DeepSeek Harness 增加第四个权限预设：在会话工作区**之外**，额外允许写入已配置的目录。

三种自带沙箱模式未被改动：`read-only`、`workspace-write`、`danger-full-access`
的含义、持久化 schema 与升级阶梯全部保持原样。

## 新增了什么

权限选择器里多出一项：

| 预设 | 沙箱模式 | 审批 | 可写范围 |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | 无 |
| `workspace-write` | `workspace-write` | `ask` | 工作区 + 临时目录 |
| `workspace-write-extra` | `workspace-write` | `ask` | 上述范围 **+ 已配置目录** |
| `danger-full-access` | `danger-full-access` | `never` | 全部 |

该项**不带标签**，因此选择器按预设名推导文字，显示为 `Workspace Write Extra`，
与自带项的风格一致。若在此处提供标签，它会**原样显示为英文**——因为客户端只为
自己的内置预设与 `auto` 预设做本地化。

新预设是**权限预设**，不是第四种 `SandboxMode`。这个区分正是关键：沙箱模式是一组
封闭的三值联合类型，会被写入 `sandbox/mode` 会话事件，并在会话恢复时由多个外部
投影重新校验。若在那里加入第四个值，**所有用过它的会话都将无法读取**。把已有的
`workspace-write` 模式与额外行为打包在一起，正是自带的 `auto` 预设采用的做法。

生效范围是**逐会话**的：仅当该会话最后记录的权限预设为 `workspace-write-extra`
时额外目录才生效；由于该选择存在于会话日志中，重启后依然保留。

## 如何避免干扰

本插件不禁用、不替换、不重排任何自带行，而是**就地包装**两个正在运行的执行服务，
并在卸载时精确还原：

* 已挂载文件系统的包含性检查（`checkedTarget`）：当其 `workspace-write` 拒绝发生时，
  针对额外目录再重试一次；
* 沙箱 provider 的 `confine`：在 bwrap profile 中补上对应的 `--bind` 对。

由此产生两个性质，两者都很重要：

* **失败是安全的。** 若本插件未能加载，harness 仍保有原有的文件系统与沙箱，而不会
  失去它们。（另一条路——禁用自带行再插入替换行——没有这种回退：Cordis 拒绝为同一
  服务名注册两个提供者，因此也无法靠遮蔽来获得安全性。）
* **它是叠加式的。** 自带检查对它原本已处理的每种情况仍具权威性，只有它自身的拒绝
  才会被重新考虑。

## 配置

两种方式都支持。

### profile 配置

```yaml
- id: workspace-write-extra
  name: dsh-workspace-write-extra
  config:
    extraWritableDirs:
      - /srv/shared-assets
      - ~/notes
    presetName: workspace-write-extra
```

条目必须是绝对路径；开头的 `~` 会被展开。符号链接会被解析，而**不存在或不是目录**
的条目会被**忽略并告警**，而不是被创建——授予一个没人指定的路径是危险的方向。展开
是异步的，因此某个目录只有在其自身展开成功之后才变为可写。

### 设置页

`extraWritableDirs` 是 volatile 字段，因此也会出现在设置页，编辑后对该 profile 内的
所有会话实时生效。

## 与 harness 的兼容性

本插件不声明任何 `@deepseek-ai/dsh-*` 的 peer 范围，而 harness 只检查这类 peer。
因此它的兼容性建立在更精确也更狭窄的东西上：**两个已挂载服务的形状**。这个形状才是
代码实际使用的东西，并由 `test/contract.test.mjs` 对**真实类**加以固定——所以任何
移动了它的 harness 升级都会立刻让测试失败，而不是在生产环境里悄悄收窄预设。

| 依赖 | 使用处 |
| --- | --- |
| `fs.checkedTarget(target, policy)` 以错误码 `FS_SANDBOX_DENIED` 拒绝 | `lib/fs.mjs` |
| `fs.resolve(path)` 解析出带 `targetKey` 的 target | `lib/fs.mjs` |
| `sandbox.confine(argv, policy, signal)` 解析为带 `argv` 的对象 | `lib/provider.mjs` |
| policy 的 `mode`、`sessionId` 字段；结果的 `argv` 字段 | 两个包装 |
| `permissionPresets.presets` 与 `emitCatalogChanged()` | `lib/service.mjs` |
| `systemPrompt.context()` 与 `getContextOrder('SANDBOX_POLICY')` | `lib/service.mjs` |

有两个性质让它在升级中保持稳健：

* 包装通过 `await` 调用自带方法，因此自带方法在同步与异步之间变化仍可工作。
* 两个包装都在**返回的对象**上操作，而不假设它是裸 argv，因此返回值新增字段仍可工作。

当某个已挂载服务完全不暴露预期的接缝时，插件会**每个服务告警一次**，并保持该实例
不变。它从不禁用自带行，因此任何意外 harness 形状下的失败模式都只是日志告警加自带
行为——绝不会变成文件系统或沙箱缺失。

## 平台支持

* **Linux + `bwrap`** —— 完全支持。额外目录以 `--bind <dir> <dir>` 加入 bubblewrap
  profile，因此受限命令与 write/edit 文件工具的行为一致。
* **Linux + `landlock`，以及 macOS `seatbelt`** —— write/edit 文件工具会被放宽，
  但受限命令不会，因为那些 profile 构建在本插件无法扩展的包内部。此时会告警一次，
  而不是假装支持。
* **Windows** —— 不支持。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `lib/service.mjs` | `ctx.extraWriteDirs`：持有已配置目录、按会话判定预设是否生效、包装两个执行服务、发布预设，并加入面向模型的说明。 |
| `lib/fs.mjs` | 包装运行中文件系统的包含性检查。 |
| `lib/provider.mjs` | 包装运行中沙箱 provider 的 `confine`。 |
| `lib/roots.mjs` | 路径展开与包含性判定。 |
| `lib/plan.mjs` | 纯函数式的 bwrap argv 变换。 |
| `cordis.patch.yml` | 插入唯一的一行插件。 |
| `test/contract.test.mjs` | 固定本插件所扩展的 harness 接缝。 |

## 测试

```
node --test test/
```

`roots.mjs`、`plan.mjs` 与两个包装都不依赖外部包，随处可运行。契约套件与集成套件
需要 DSH 包可被解析，因此需在已安装的 profile 中运行：契约套件固定真实的原生接缝，
集成套件则装配真实的文件系统与沙箱 provider，断言放宽生效以及卸载时的精确还原。
所有需要这些包的套件在包缺失时会带原因跳过，绝不空过。